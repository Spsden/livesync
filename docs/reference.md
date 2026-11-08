# Reference

Contract-level details: HTTP endpoints, WebSocket endpoint, environment
variables, on-disk layout, limits.

All paths are relative to `BASE_PATH` (empty by default, e.g. `/livesync`).

## HTTP API

### `GET /api/health`

Reports database reachability and how many rooms are resident in memory.

```json
{ "ok": true, "rooms": 2 }
```

- `200` — database responded.
- `503` — database unreachable; body `{ "ok": false, "error": "..." }`.

`rooms` counts **loaded** rooms (open or still inside the idle window), not stored
notepads.

### `GET /api/rooms?q=&limit=`

The public directory: only notepads whose participants marked them **listed**.

```json
{ "rooms": [ { "room": "7f84f42f13b5", "name": "Quarterly plans",
               "updatedAt": "2026-10-29T01:02:46.382Z" } ] }
```

| Param | Meaning |
| --- | --- |
| `q` | Optional. Max 64 chars. Fuzzy: room id (exact or prefix), name substring, trigram similarity, or per-token word similarity. Every token must match |
| `limit` | 1–50, default 20 |

Ranked by: exact id, id prefix, exact name, name prefix, trigram similarity, then
last activity. `pg_trgm` supplies the `%` pre-filter and the ranking; without it
the query degrades to substring matching.

The query joins `rooms` to `ydoc_state.updated_at` and **never selects
`ydoc_state.state`** — a directory page must not pull Yjs snapshots into memory.

Examples:

```
?q=quaterly%20plan     → typo still finds "Quarterly plans 2026"
?q=directry%20smoke    → word order and spelling do not matter
?q=7f84f4              → id prefix
```

### `POST /api/rooms`

Creates the notepad row explicitly, so a password can exist before the first
connection. Ids are generated client-side.

```json
{ "room": "7f84f42f13b5", "pin": "at least 6 characters" }
```

`pin` is optional; omit it for a link-only notepad. Returns
`{ "ok": true, "room": "...", "locked": true }`.

| Status | When |
| --- | --- |
| `200` | created |
| `400` | invalid room, or a password shorter than 6 characters |
| `409` | a notepad with that id already exists |

### `GET /api/rooms/:room/access`

What the client needs before opening a websocket: whether a password is set, and
whether this browser already passed it.

```json
{ "room": "7f84f42f13b5", "locked": true, "unlocked": false, "listed": true }
```

A room with no row (never created explicitly) reports `locked: false`.

### `POST /api/rooms/:room/unlock`

```json
{ "pin": "the password" }
```

On success sets an `HttpOnly`, `SameSite=Lax` cookie scoped to that room
(`ls_room_<room>`, signed with `COOKIE_SECRET`, 7-day default) and returns
`{ "ok": true, "locked": true }`.

| Status | When |
| --- | --- |
| `200` | accepted (or the notepad has no password) |
| `401` | wrong password |
| `404` | no row for that room |
| `429` | too many failures — 5 per 5 minutes per IP and room |

The unlock cookie is a **bearer credential**: anyone who copies it can enter
without the password until it expires.

### `POST /api/rooms/:room/files`

Uploads one file. `multipart/form-data`, single field named `file`.

```sh
curl -F "file=@notes.pdf" https://livesync.example.com/api/rooms/abc123/files
```

```json
{ "id": "0f8c...-uuid", "name": "notes.pdf", "mime": "application/pdf",
  "size": 184223, "url": "/api/files/0f8c...-uuid" }
```

| Status | When |
| --- | --- |
| `200` | stored |
| `400` | invalid room, missing `file` field, or malformed multipart |
| `401` | the notepad is locked and this request has no unlock cookie |
| `413` | exceeds `MAX_FILE_BYTES`, or the notepad's combined budget (`MAX_NOTEPAD_BYTES`). Body carries the reason |
| `500` | disk or database write failed (blob is rolled back on row failure) |

The room is **not** required to exist. Uploading to an arbitrary valid room id
creates metadata with no notepad behind it; see the note at the end.

### `GET /api/files/:id`

Streams the blob.

- `Content-Disposition: attachment` (original filename, RFC 5987 encoded)
- `X-Content-Type-Options: nosniff`
- `Cache-Control: private, max-age=31536000, immutable` (ids are never reused)

| Status | When |
| --- | --- |
| `200` | stream |
| `401` | the notepad is locked and this request has no unlock cookie |
| `404` | no row, or the row's blob is missing on disk |

### `DELETE /api/rooms/:room/files/:id`

Deletes one attachment. Scoped by room: an id from another notepad returns `404`.

```json
{ "ok": true, "id": "0f8c...-uuid" }
```

Requires the unlock cookie when the notepad has a password.

The row is removed before the blob is unlinked (see I6 in the architecture doc).
The caller is responsible for removing the entry from the shared `files` array;
peers then converge.

### `DELETE /api/rooms/:room`

Deletes the notepad: state row, file rows, blobs, live document, and every open
connection (closed `4404`). Writes a tombstone so the URL stays dead.

```json
{ "ok": true, "room": "abc123", "files": 2, "blobsRemoved": 2 }
```

Idempotent. A second call returns `{ files: 0, blobsRemoved: 0 }` and re-upserts
the tombstone.

| Status | When |
| --- | --- |
| `200` | deleted (or already gone) |
| `400` | invalid room |
| `401` | the notepad is locked and this request has no unlock cookie |
| `500` | database failure; state may be partially removed |

### `GET /`, `GET /n/:room`

Serve the SPA shell (`dist/client/index.html`). `/` renders the landing page;
every `/n/<id>` renders the notepad, with the id read client-side.

### WebSocket `GET /ws/:room` (upgrade)

Realtime sync. See [sync-protocol.md](sync-protocol.md). Invalid room → socket
destroyed; tombstoned room → close `4404`.

## Environment variables

Parsed in `server/config.js`. Blank values fall through to defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address; use `127.0.0.1` behind cloudflared |
| `BASE_PATH` | *(empty)* | Mount prefix. **Must match the client build** |
| `DATA_DIR` | `./data` | Blob directory (resolved from process cwd) |
| `DATABASE_URL` | derived | Full Postgres URL; wins over the parts below |
| `POSTGRES_DB` | `livesync` | Database name |
| `POSTGRES_USER` | `livesync` | Role |
| `POSTGRES_PASSWORD` | `livesync` | Password (insecure fallback, always set it) |
| `DB_HOST` | `127.0.0.1` | Postgres host |
| `DB_PORT` | `PG_PORT`, else `5432` | Postgres port for bare-metal runs |
| `PG_PORT` | `5433` | Host port Compose publishes Postgres on; also the bare-metal fallback |
| `MAX_FILE_BYTES` | `20971520` (20 MB) | Per-file ceiling |
| `MAX_NOTEPAD_BYTES` | `20971520` (20 MB) | Combined budget per notepad: encoded Yjs snapshot + all attachment bytes |
| `COOKIE_SECRET` | random per boot | Signs unlock cookies; unset means every restart logs people out |
| `COOKIE_MAX_AGE_MS` | `604800000` (7 days) | Unlock cookie lifetime |
| `PIN_ATTEMPTS` | `5` | Failed unlocks allowed per window |
| `PIN_WINDOW_MS` | `300000` (5 min) | Rate-limit window |
| `FLUSH_DELAY_MS` | `750` | Snapshot debounce; also the max server-side loss on SIGKILL |
| `IDLE_ROOM_MS` | `600000` (10 min) | Evict rooms from memory after this long with no connections |
| `GC_MIN_AGE_MS` | `3600000` (1 h) | `scripts/gc.mjs` only: skip blobs younger than this |
| `SERVER_PORT` | `3000` | Vite dev proxy target only (not read by the server) |

Compose sets `DATABASE_URL`, `PORT`, `DATA_DIR` and `BASE_PATH` explicitly for
the container, so the bare-metal variables above do not affect it.

## On-disk layout

```
<project>/
├── dist/client/            built SPA (served statically, 1 h cache)
├── data/                   DATA_DIR (PM2 default)
│   └── files/<uuid>        one blob per room_files row
├── server/                 runtime code (copied into the image)
└── scripts/                smoke test, gc
```

Blob names are server-generated UUIDs. The original filename is stored only in
`room_files.name` and used for the download header.

## Database schema

```sql
CREATE TABLE ydoc_state (
  room       text PRIMARY KEY,
  state      bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_files (
  id         text PRIMARY KEY,
  room       text NOT NULL,
  name       text NOT NULL,
  mime       text NOT NULL,
  size       bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_files_room_idx ON room_files (room, created_at);

CREATE TABLE deleted_rooms (
  room       text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- directory read model; name/listed are mirrored from the Yjs meta map
CREATE TABLE rooms (
  room       text PRIMARY KEY,
  name       text NOT NULL DEFAULT 'untitled',
  listed     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  listed_at  timestamptz,
  pin_hash    text,                       -- scrypt hash, NULL = no password
  pin_salt    text,
  pin_version integer NOT NULL DEFAULT 0  -- bump to invalidate cookies
);
CREATE INDEX rooms_listed_idx ON rooms (listed, listed_at DESC);
-- plus a GIN trigram index on name when pg_trgm is available
```

`ydoc_state.state` is `Y.encodeStateAsUpdate(doc)`. There is no delta log and no
revision history.

## Limits

| Thing | Limit | Enforced by |
| --- | --- | --- |
| Room id | 1–64 chars, `[A-Za-z0-9_-]` | `isValidRoom` at every entry point |
| Upload size | `MAX_FILE_BYTES` (20 MB) | multer |
| Notepad storage | `MAX_NOTEPAD_BYTES` (20 MB) combined: encoded note snapshot + attachments | upload transaction (advisory lock) and snapshot flush |
| Upload concurrency | unbounded, buffered in RAM per request | — |
| Files per notepad | bounded by the notepad budget | — |
| Text per notepad | bounded by the notepad budget | — |
| Open rooms | bounded by RAM, not by config | — |

## Known gaps

- **No rate limiting.** A public instance can be filled with rooms, files, or
  requests. Put Cloudflare Access or a rate-limit rule in front if that matters.
- **The budget is per notepad, not per person.** There are no accounts; anyone
  who can write to a notepad consumes its 20 MB.
- **Over-budget notes are not saved.** The last snapshot that fit is kept and
  clients are closed with `4413`; the overflow exists only in the browser that
  produced it.
- **Uploads do not require the notepad to exist.** A blob uploaded to a valid but
  never-opened room id keeps its row, so GC will not reclaim it unless that room
  is deleted.
- **No revision history.** Deleting a tab's text is final; there is no undo across
  sessions.
- **Health is shallow.** It checks `SELECT 1`, not disk space or blob
  readability.
- **No password recovery.** Losing the password loses the notepad; even deletion
  needs it. Operators can remove the row with SQL.
- **Rate limiting is in-memory.** A restart resets the counters, and it is per
  IP, so a distributed attempt is not fully covered.
- **Listed names are public.** The directory shows the name and id; only the
  content is gated.
- **Listing is a capability decision, not a privacy one.** Anyone holding a link
  can mark that notepad as listed; the directory publishes the room id to
  everyone. Listing is off by default.
- **A notepad only appears once it has been opened by the current server.** The
  directory joins `ydoc_state`, so rooms with content but no `rooms` row (from
  before the directory existed) show up only after their next visit.
