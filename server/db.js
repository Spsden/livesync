import pg from 'pg'
import { config } from './config.js'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
})

/** Flipped on when pg_trgm is available, so listRooms can pick a query shape. */
let trigram = false

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

  // Read model for the directory. `name` and `listed` are mirrored from the
  // Yjs `meta` map; ydoc_state stays the record of truth for content.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      room       text PRIMARY KEY,
      name       text NOT NULL DEFAULT 'untitled',
      listed     boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      listed_at  timestamptz
    )
  `)
  await pool.query(
    'CREATE INDEX IF NOT EXISTS rooms_listed_idx ON rooms (listed, listed_at DESC)',
  )

  // Passwords are optional; a notepad can only be listed if it has one.
  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pin_hash text')
  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pin_salt text')
  await pool.query(
    'ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pin_version integer NOT NULL DEFAULT 0',
  )
  // Listing without a password was possible before the rule existed.
  await pool.query(
    'UPDATE rooms SET listed = false, listed_at = NULL WHERE listed = true AND pin_hash IS NULL',
  )

  // Substring search is a sequential scan without this. pg_trgm is a trusted
  // extension on modern Postgres, but a managed database may forbid CREATE
  // EXTENSION; degrade to plain substring search rather than failing to boot.
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    trigram = true
    try {
      await pool.query(
        'CREATE INDEX IF NOT EXISTS rooms_name_trgm ON rooms USING gin (name gin_trgm_ops)',
      )
    } catch (err) {
      console.warn('[db] trigram index unavailable; fuzzy search will scan:', err.message)
    }
  } catch (err) {
    console.warn('[db] pg_trgm unavailable; falling back to substring search:', err.message)
  }
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

export async function fileBytesForRoom(room) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(size), 0) AS bytes FROM room_files WHERE room = $1',
    [room],
  )
  return Number(rows[0]?.bytes ?? 0)
}

/**
 * Inserts a file row only if the notepad's combined budget allows it.
 *
 * The advisory lock serialises concurrent uploads to the same room, otherwise
 * two requests could each see room left and both commit. `noteBytes` is passed
 * by the caller when the document is in memory, so unsaved edits count too.
 */
export async function insertFileWithinQuota({
  id,
  room,
  name,
  mime,
  size,
  limit,
  noteBytes = null,
}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [room])

    let notes = noteBytes
    if (notes === null) {
      const noteRow = await client.query(
        'SELECT length(state) AS bytes FROM ydoc_state WHERE room = $1',
        [room],
      )
      notes = Number(noteRow.rows[0]?.bytes ?? 0)
    }

    const fileRow = await client.query(
      'SELECT COALESCE(SUM(size), 0) AS bytes FROM room_files WHERE room = $1',
      [room],
    )
    const used = notes + Number(fileRow.rows[0]?.bytes ?? 0)

    if (used + size > limit) {
      await client.query('ROLLBACK')
      return { ok: false, used }
    }

    await client.query(
      'INSERT INTO room_files (id, room, name, mime, size) VALUES ($1, $2, $3, $4, $5)',
      [id, room, name, mime, size],
    )
    await client.query('COMMIT')
    return { ok: true, used: used + size }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
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
    'DELETE FROM room_files WHERE id = $1 AND room = $2 RETURNING id, name, size',
    [id, room],
  )
  return rows[0] ?? null
}

export async function ensureRoom(room, name, listed) {
  await pool.query(
    `INSERT INTO rooms (room, name, listed, listed_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (room) DO NOTHING`,
    [room, name, listed],
  )
}

export async function saveRoomMeta(room, name, listed) {
  await pool.query(
    `INSERT INTO rooms (room, name, listed, listed_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (room) DO UPDATE
       SET name = EXCLUDED.name,
           -- a notepad without a password must never be published
           listed = (EXCLUDED.listed AND rooms.pin_hash IS NOT NULL),
           listed_at = CASE
             WHEN EXCLUDED.listed AND rooms.pin_hash IS NOT NULL THEN now()
             ELSE NULL
           END`,
    [room, name, listed],
  )
}

export async function createRoomRow(room, pinHash, pinSalt) {
  const { rowCount } = await pool.query(
    `INSERT INTO rooms (room, name, listed, pin_hash, pin_salt)
     VALUES ($1, 'untitled', false, $2, $3)
     ON CONFLICT (room) DO NOTHING`,
    [room, pinHash, pinSalt],
  )
  return rowCount > 0
}

export async function getRoomAccess(room) {
  const { rows } = await pool.query(
    'SELECT pin_hash, pin_salt, pin_version, listed FROM rooms WHERE room = $1',
    [room],
  )
  return rows[0] ?? null
}

/**
 * Fuzzy directory search over listed notepads only.
 *
 * The `%` operator is a cheap GIN-index pre-filter; `similarity` ranks what
 * survives. The token branch catches multi-word queries and spelling mistakes
 * that fall below the operator threshold, and requires every token to match.
 * Never selects ydoc_state.state.
 */
const FUZZY_SQL = `
  WITH params AS (SELECT lower(btrim($1)) AS q)
  SELECT r.room, r.name, s.updated_at, (r.pin_hash IS NOT NULL) AS locked
    FROM rooms r
    JOIN ydoc_state s ON s.room = r.room
    CROSS JOIN params p
   WHERE r.listed = true
     AND r.pin_hash IS NOT NULL
     AND (
       p.q = ''
       OR r.room = p.q
       OR r.room LIKE p.q || '%'
       OR r.name ILIKE '%' || p.q || '%'
       OR r.name % p.q
       OR NOT EXISTS (
         SELECT 1
           FROM unnest(string_to_array(p.q, ' ')) AS t(token)
          WHERE t.token <> ''
            AND r.name NOT ILIKE '%' || t.token || '%'
            AND word_similarity(t.token, r.name) < 0.4
       )
     )
   ORDER BY
     (r.room = p.q) DESC,
     (r.room LIKE p.q || '%') DESC,
     (lower(r.name) = p.q) DESC,
     (r.name ILIKE p.q || '%') DESC,
     similarity(r.name, p.q) DESC,
     s.updated_at DESC
   LIMIT $2
`

const BASIC_SQL = `
  WITH params AS (SELECT lower(btrim($1)) AS q)
  SELECT r.room, r.name, s.updated_at, (r.pin_hash IS NOT NULL) AS locked
    FROM rooms r
    JOIN ydoc_state s ON s.room = r.room
    CROSS JOIN params p
   WHERE r.listed = true
     AND r.pin_hash IS NOT NULL
     AND (
       p.q = ''
       OR r.room = p.q
       OR r.room LIKE p.q || '%'
       OR r.name ILIKE '%' || p.q || '%'
     )
   ORDER BY
     (r.room = p.q) DESC,
     (lower(r.name) = p.q) DESC,
     s.updated_at DESC
   LIMIT $2
`

export async function listRooms(query, limit) {
  const { rows } = await pool.query(trigram ? FUZZY_SQL : BASIC_SQL, [
    query,
    limit,
  ])
  return rows
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
    await client.query('DELETE FROM rooms WHERE room = $1', [room])
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
