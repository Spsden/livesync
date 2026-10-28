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
| `413` | exceeds `MAX_FILE_BYTES` |
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
| `404` | no row, or the row's blob is missing on disk |

### `DELETE /api/rooms/:room/files/:id`

Deletes one attachment. Scoped by room: an id from another notepad returns `404`.

```json
{ "ok": true, "id": "0f8c...-uuid" }
```

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
| `500` | database failure; state may be partially removed |

### `GET /`, `GET /n/:room`

Serve the SPA shell (`dist/client/index.html`). Every `/n/<id>` renders the same
app; the id is read client-side.

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
| `MAX_FILE_BYTES` | `26214400` (25 MB) | Per-file ceiling |
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
```

`ydoc_state.state` is `Y.encodeStateAsUpdate(doc)`. There is no delta log and no
revision history.

## Limits

| Thing | Limit | Enforced by |
| --- | --- | --- |
| Room id | 1–64 chars, `[A-Za-z0-9_-]` | `isValidRoom` at every entry point |
| Upload size | `MAX_FILE_BYTES` (25 MB) | multer |
| Upload concurrency | unbounded, buffered in RAM per request | — |
| Files per notepad | unbounded | — |
| Text per notepad | unbounded | — |
| Open rooms | bounded by RAM, not by config | — |

## Known gaps

- **No rate limiting.** A public instance can be filled with rooms, files, or
  requests. Put Cloudflare Access or a rate-limit rule in front if that matters.
- **Uploads do not require the notepad to exist.** A blob uploaded to a valid but
  never-opened room id keeps its row, so GC will not reclaim it unless that room
  is deleted.
- **No revision history.** Deleting a tab's text is final; there is no undo across
  sessions.
- **Health is shallow.** It checks `SELECT 1`, not disk space or blob
  readability.
