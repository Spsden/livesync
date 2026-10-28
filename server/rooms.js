import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness.js'
import { config } from './config.js'
import { loadRoomState, saveRoomState, deleteRoomRecords } from './db.js'
import { sendSyncUpdate, sendAwareness } from './sync.js'

/** Close code for "this notepad no longer exists". y-websocket treats 4400-4499
 *  as permanent, so clients stop reconnecting instead of recreating the room. */
export const CLOSE_ROOM_DELETED = 4404

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

async function createRoom(name) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const room = {
    name,
    doc,
    awareness,
    conns: new Set(),
    timer: null,
    /** In-flight save, awaited before deleting so it can't resurrect the row. */
    saving: null,
    deleted: false,
    lastActive: Date.now(),
  }

  const stored = await loadRoomState(name)
  // Applied before the update listener is attached: restoring state must not
  // count as a change, or every cold start would immediately rewrite the row.
  if (stored) Y.applyUpdate(doc, stored, 'db')

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
  const saving = saveRoomState(room.name, state)
  room.saving = saving
  try {
    await saving
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
