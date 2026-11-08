import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness.js'
import { config } from './config.js'
import {
  loadRoomState,
  saveRoomState,
  deleteRoomRecords,
  ensureRoom,
  saveRoomMeta,
  fileBytesForRoom,
} from './db.js'
import { sendSyncUpdate, sendAwareness } from './sync.js'

/** Close code for "this notepad no longer exists". y-websocket treats 4400-4499
 *  as permanent, so clients stop reconnecting instead of recreating the room. */
export const CLOSE_ROOM_DELETED = 4404
/** Same permanent range: clients stop retrying and ask for the password. */
export const CLOSE_ROOM_LOCKED = 4403
/** The notepad hit its storage budget; the last saved snapshot is kept. */
export const CLOSE_ROOM_FULL = 4413

/** @type {Map<string, any>} */
const rooms = new Map()
/** @type {Map<string, Promise<any>>} */
const opening = new Map()

/**
 * Load a room, creating it from Postgres if this server hasn't seen it yet.
 * Concurrent connects to the same new room share one load, otherwise both
 * would apply the stored state twice and end up with duplicate content.
 */
export function getRoom(name) {
  const existing = rooms.get(name)
  if (existing) return Promise.resolve(existing)

  let pending = opening.get(name)
  if (!pending) {
    pending = createRoom(name)
      .then((room) => {
        rooms.set(name, room)
        opening.delete(name)
        return room
      })
      .catch((err) => {
        opening.delete(name)
        throw err
      })
    opening.set(name, pending)
  }
  return pending
}

function readMeta(doc) {
  const meta = doc.getMap('meta')
  const raw = meta.get('name')
  const name =
    typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 80) : 'untitled'
  return { name, listed: meta.get('listed') === true }
}

async function createRoom(name) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const room = {
    name,
    doc,
    awareness,
    conns: new Set(),
    timer: null,
    metaTimer: null,
    /** Cached attachment bytes, kept in step with upload/delete. */
    fileBytes: 0,
    /** Encoded snapshot size as of the last successful save. */
    noteBytes: 0,
    oversize: false,
    /** In-flight save, awaited before deleting so it can't resurrect the row. */
    saving: null,
    deleted: false,
    lastActive: Date.now(),
  }

  const stored = await loadRoomState(name)
  // Applied before the update listener is attached: restoring state must not
  // count as a change, or every cold start would immediately rewrite the row.
  room.noteBytes = stored?.length ?? 0
  if (stored) Y.applyUpdate(doc, stored, 'db')

  // Directory read model. Seeded on first load, then mirrored whenever the
  // name or listing flag changes. Debounced because a rename commits on blur,
  // but a client is free to write the map more often.
  const initialMeta = readMeta(doc)
  try {
    await ensureRoom(name, initialMeta.name, initialMeta.listed)
  } catch (err) {
    console.error(`[rooms] could not seed directory row for ${name}:`, err)
  }
  try {
    room.fileBytes = await fileBytesForRoom(name)
  } catch (err) {
    console.error(`[rooms] could not total files for ${name}:`, err)
  }
  doc.getMap('meta').observe(() => scheduleMetaSave(room))

  doc.on('update', (update, origin) => {
    if (room.deleted) return
    room.lastActive = Date.now()
    for (const conn of room.conns) {
      // Origin is the connection that produced this update. It already holds
      // it locally, so echoing back would be wasted bandwidth.
      if (conn === origin) continue
      sendSyncUpdate(conn, update)
    }
    scheduleSave(room)
  })

  awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = [...added, ...updated, ...removed]
    for (const conn of room.conns) {
      if (conn === origin) continue
      sendAwareness(conn, awareness, changed)
    }
  })

  return room
}

/**
 * Hard stop for the storage budget. Deliberately not a tombstone: the room is
 * dropped from memory so the next connection reads the last snapshot that fit,
 * and clients are closed 4413 so they stop pushing more.
 */
function failOversize(room, noteBytes) {
  if (room.oversize) return
  room.oversize = true
  if (room.timer) {
    clearTimeout(room.timer)
    room.timer = null
  }
  if (room.metaTimer) {
    clearTimeout(room.metaTimer)
    room.metaTimer = null
  }

  rooms.delete(room.name)
  console.error(
    `[rooms] ${room.name} exceeded the ${config.maxNotepadBytes}-byte budget ` +
      `(notes ${noteBytes} + files ${room.fileBytes}); keeping the last saved snapshot`,
  )

  for (const conn of room.conns) {
    try {
      conn.close(CLOSE_ROOM_FULL, 'notepad is full')
    } catch {
      conn.terminate()
    }
  }
  room.conns.clear()
  room.awareness.destroy()
  room.doc.destroy()
}

/** Cached usage for a loaded room, or null when it is not in memory. */
export function localUsage(name) {
  const room = rooms.get(name)
  if (!room || room.deleted || room.oversize) return null
  return { noteBytes: room.noteBytes, fileBytes: room.fileBytes }
}

/** Encoded size of the live document, or null when it is not loaded. */
export function currentNoteBytes(name) {
  const room = rooms.get(name)
  if (!room || room.deleted || room.oversize) return null
  return Y.encodeStateAsUpdate(room.doc).length
}

/** Keep the cached attachment total in step with uploads and deletes. */
export function addFileBytes(name, delta) {
  const room = rooms.get(name)
  if (!room || room.deleted || room.oversize) return
  room.fileBytes = Math.max(0, room.fileBytes + delta)
}

function scheduleMetaSave(room) {
  if (room.deleted) return
  if (room.metaTimer) clearTimeout(room.metaTimer)
  room.metaTimer = setTimeout(() => {
    room.metaTimer = null
    const { name, listed } = readMeta(room.doc)
    saveRoomMeta(room.name, name, listed).catch((err) =>
      console.error(`[rooms] meta save for ${room.name} failed:`, err),
    )
  }, 500)
}

function scheduleSave(room) {
  if (room.deleted) return
  if (room.timer) clearTimeout(room.timer)
  room.timer = setTimeout(() => {
    room.timer = null
    flushRoom(room).catch((err) =>
      console.error(`[persist] room ${room.name} failed to save:`, err),
    )
  }, config.flushDelayMs)
}

export async function flushRoom(room) {
  if (room.deleted) return
  if (room.timer) {
    clearTimeout(room.timer)
    room.timer = null
  }
  const state = Y.encodeStateAsUpdate(room.doc)

  if (state.length + room.fileBytes > config.maxNotepadBytes) {
    failOversize(room, state.length)
    return
  }

  const saving = saveRoomState(room.name, state)
  room.saving = saving
  try {
    await saving
    room.noteBytes = state.length
  } finally {
    if (room.saving === saving) room.saving = null
  }
}

export async function flushAll() {
  await Promise.allSettled([...rooms.values()].map(flushRoom))
}

/**
 * Permanently delete a notepad: its Yjs state, its file rows, its blobs, and
 * the live document in memory. Connected clients are closed with 4404 so they
 * show "deleted" instead of quietly reconnecting into a fresh empty room.
 *
 * Returns the blob ids the caller must unlink.
 */
export async function deleteRoom(name) {
  // A connect could be mid-load. Let it finish, otherwise it would re-insert
  // the room into the map right after we remove it.
  const pending = opening.get(name)
  if (pending) {
    try {
      await pending
    } catch {
      // A failed load left nothing behind; nothing to await.
    }
  }

  const room = rooms.get(name)
  if (room) {
    // Order matters: stop new writes, let the in-flight one land, then delete.
    room.deleted = true
    if (room.timer) {
      clearTimeout(room.timer)
      room.timer = null
    }
    if (room.metaTimer) {
      clearTimeout(room.metaTimer)
      room.metaTimer = null
    }

    for (const conn of room.conns) {
      try {
        conn.close(CLOSE_ROOM_DELETED, 'notepad deleted')
      } catch {
        conn.terminate()
      }
    }
    room.conns.clear()

    if (room.saving) {
      try {
        await room.saving
      } catch {
        // If it failed, there is nothing to overwrite our delete.
      }
    }

    rooms.delete(name)
    room.awareness.destroy()
    room.doc.destroy()
  }

  return deleteRoomRecords(name)
}

/** Unload documents nobody has touched recently so memory stays bounded. */
export function sweepIdleRooms() {
  const cutoff = Date.now() - config.idleRoomMs
  for (const [name, room] of rooms) {
    if (
      room.conns.size === 0 &&
      !room.timer &&
      !room.saving &&
      room.lastActive < cutoff
    ) {
      rooms.delete(name)
    }
  }
}

export const roomCount = () => rooms.size
