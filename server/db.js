import pg from 'pg'
import { config } from './config.js'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
})

export async function migrate() {
  // One row per room holding the whole merged Yjs state. Yjs updates are
  // compact binary diffs, so a notepad with megabytes of text is still a few
  // hundred KB here — and merging is free because we never store deltas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ydoc_state (
      room       text PRIMARY KEY,
      state      bytea NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_files (
      id         text PRIMARY KEY,
      room       text NOT NULL,
      name       text NOT NULL,
      mime       text NOT NULL,
      size       bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(
    'CREATE INDEX IF NOT EXISTS room_files_room_idx ON room_files (room, created_at)',
  )
  // A deleted URL stays deleted. Without this, a stale tab (or a same-browser
  // BroadcastChannel peer) can push its in-memory copy back into an empty room
  // and resurrect the notepad seconds after someone deleted it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_rooms (
      room       text PRIMARY KEY,
      deleted_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

/** @returns {Promise<Uint8Array | null>} */
export async function loadRoomState(room) {
  const { rows } = await pool.query(
    'SELECT state FROM ydoc_state WHERE room = $1',
    [room],
  )
  const buffer = rows[0]?.state
  return buffer ? new Uint8Array(buffer) : null
}

export async function saveRoomState(room, state) {
  await pool.query(
    `INSERT INTO ydoc_state (room, state, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (room) DO UPDATE
       SET state = EXCLUDED.state, updated_at = now()`,
    [room, Buffer.from(state)],
  )
}

export async function insertFile({ id, room, name, mime, size }) {
  await pool.query(
    'INSERT INTO room_files (id, room, name, mime, size) VALUES ($1, $2, $3, $4, $5)',
    [id, room, name, mime, size],
  )
}

export async function getFile(id) {
  const { rows } = await pool.query(
    'SELECT id, room, name, mime, size FROM room_files WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function deleteFileRecord(room, id) {
  const { rows } = await pool.query(
    'DELETE FROM room_files WHERE id = $1 AND room = $2 RETURNING id, name',
    [id, room],
  )
  return rows[0] ?? null
}

/**
 * Removes a notepad's state and file rows in one transaction, returning the
 * blob ids the caller still has to unlink. Doing the rows first means a crash
 * mid-way leaves orphan blobs (which GC reclaims) rather than rows pointing at
 * nothing (which would render as broken links forever).
 */
export async function deleteRoomRecords(room) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT id FROM room_files WHERE room = $1',
      [room],
    )
    await client.query('DELETE FROM room_files WHERE room = $1', [room])
    await client.query('DELETE FROM ydoc_state WHERE room = $1', [room])
    // Same transaction as the deletes: a room is never "half deleted".
    await client.query(
      `INSERT INTO deleted_rooms (room) VALUES ($1)
       ON CONFLICT (room) DO UPDATE SET deleted_at = now()`,
      [room],
    )
    await client.query('COMMIT')
    return rows.map((row) => row.id)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function allFileIds() {
  const { rows } = await pool.query('SELECT id FROM room_files')
  return new Set(rows.map((row) => row.id))
}

export async function isRoomDeleted(room) {
  const { rows } = await pool.query(
    'SELECT 1 FROM deleted_rooms WHERE room = $1',
    [room],
  )
  return rows.length > 0
}
