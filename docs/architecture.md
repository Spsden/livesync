# Architecture

Status: current as of 2026-10-28. Implementation details live in source; this
document explains *why* the system is shaped the way it is, what must stay true,
and where it breaks.

## 1. What this is

live-sync is a shareable, account-less notepad. One URL identifies one notepad.
A notepad holds tabs of collaboratively edited plain text plus a list of
attachments. Everyone with the URL sees edits and attachments live.

"Realtime" here means each browser holds a full replica of the notepad and edits
are merged by a CRDT (Yjs), via a single Node process that relays binary updates
and owns persistence. There is no polling, no refresh, and no lock.

## 2. Goals and non-goals

**Goals**

- Zero onboarding. The link is the entire permission model.
- Correct convergence under concurrent and temporarily-offline edits.
- Tabs are first-class documents, not sections of one long string.
- Attachments appear for every participant without a refresh.
- Deletion really deletes, and a deleted URL stays dead.
- A small operational surface: one process, Postgres, one directory.

**Non-goals**

- Accounts, roles, per-tab or per-file permissions.
- Horizontal scale-out (see [§12](#12-capacity-and-scaling) — it is a design
  constraint, not a TODO).
- Rich text, embeds, comments, search, revision-history UI.
- A native app, or offline-first PWA caching of the shell.

## 3. System context

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  Browser A   │   │  Browser B   │   │  Browser C   │
        │  (Yjs doc)   │   │  (Yjs doc)   │   │  (Yjs doc)   │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               │ wss              │ wss              │ https
               └──────────┬───────┴──────────────────┘
                          │
                 ┌────────▼─────────┐
                 │    Cloudflare    │  TLS, edge, optional Access
                 └────────┬─────────┘
                          │ QUIC (outbound from origin)
                 ┌────────▼─────────┐
                 │    cloudflared   │  systemd, locally-managed tunnel
                 │  ingress by host │
                 └────────┬─────────┘
                          │ http / ws → 127.0.0.1
                 ┌────────▼─────────┐        ┌──────────────┐
                 │  live-sync (Node)│───────►│   Postgres   │
                 │  one process     │        │ state, files │
                 │                  │        │ metadata,    │
                 │  in-memory rooms │        │ tombstones   │
                 └────────┬─────────┘        └──────────────┘
                          │
                 ┌────────▼─────────┐
                 │  DATA_DIR/files  │  blobs, named by uuid
                 └──────────────────┘
```

Three properties follow from this shape:

1. **The origin has no inbound ports.** cloudflared dials out; the app binds
   loopback. Firewall configuration is not part of the threat model.
2. **The process is stateful.** Replicas cannot be added freely.
3. **Postgres is the only system of record for text.** Losing it loses every
   notepad; the blob directory alone is not enough.

## 4. Runtime topology

| Unit | Managed by | Binds | Purpose |
| --- | --- | --- | --- |
| `live-sync` | PM2 (`fork`, 1 instance) | `127.0.0.1:3002` | HTTP + WebSocket + persistence |
| `cloudflared` | systemd (locally-managed tunnel) | outbound only | Public ingress |
| `postgres` | Docker Compose | `127.0.0.1:5433` | State, file metadata, tombstones |
| `DATA_DIR` | filesystem (PM2 `cwd`) | `./data` | Attachment bytes |

The Docker Compose stack is an alternative to PM2 that runs the same image with
its own Postgres; the two must never run simultaneously against the same
database (see invariant I7).

## 5. Components

| Path | Responsibility | Deliberately does not |
| --- | --- | --- |
| `server/index.js` | HTTP routing, static assets, WS upgrade, lifecycle, GC schedule | Know the sync protocol |
| `server/sync.js` | y-websocket wire protocol: framing, handshake, broadcast | Own documents |
| `server/rooms.js` | Room registry, load/save orchestration, deletion, idle eviction | Parse updates |
| `server/db.js` | Schema, snapshots, file rows, tombstones | Know about Yjs types |
| `server/files.js` | Upload/download/delete, safe blob naming | Know about rooms' text |
| `server/gc.js` | Reclaim blobs with no row | Delete rows |
| `server/config.js` | Env parsing, validation helpers | — |
| `src/client/*` | React shell, routing, editor, presence, file UI | Hold authoritative state |

The client is not an authority. It renders a replica and writes intents to it;
the CRDT merge decides the outcome.

## 6. Data model

### 6.1 The Yjs document

One `Y.Doc` per notepad, replicated to every open client:

```
Y.Doc
├── tabs          Y.Array<{ id: string, title: string }>
├── tab:<id>      Y.Text                      (one per tab)
└── files         Y.Array<{ id, name, mime, size }>
```

Why this shape:

- **`tabs` as a `Y.Array`** makes "create/rename/reorder/close a tab" a merged
  operation like typing. There is no server-side notion of "the current tab
  list", so two people adding tabs simultaneously cannot clobber each other.
- **A `Y.Text` per tab** keeps undo scoped (one `Y.UndoManager` per tab) and
  makes closing a tab an explicit, bounded deletion rather than a splice inside
  a monolithic document.
- **`files` as a `Y.Array`** means an attachment is published over the same
  socket as text. No second channel, no polling. The bytes are *not* in Yjs.
- **Ids are generated client-side** (`crypto.getRandomValues`), so creating a
  tab works while offline; the merge resolves collisions.

Root-level key naming is part of the schema: `tab:` prefixes are load-bearing.
Renaming a root key is a data migration.

### 6.2 Postgres

```sql
ydoc_state    (room text PK, state bytea, updated_at timestamptz)
room_files    (id text PK, room text, name text, mime text, size bigint, created_at)
deleted_rooms (room text PK, deleted_at timestamptz)
```

- `ydoc_state.state` is `Y.encodeStateAsUpdate(doc)` — the entire merged
  document, not a delta log. See [ADR-003](decisions.md#adr-003-whole-state-snapshots-in-postgres).
- `room_files` is metadata only. It exists so a download can be authorized by
  room and so GC can distinguish live blobs from orphans.
- `deleted_rooms` is a tombstone consulted **before** a room is loaded. See
  [ADR-004](decisions.md#adr-004-durable-tombstones).

### 6.3 Blob store

`DATA_DIR/files/<uuid>`, one file per row. The on-disk name is generated, never
user-supplied, so traversal and collisions are impossible by construction. The
original filename lives in `room_files.name` and is only used for the
`Content-Disposition` header (sanitised).

## 7. Invariants

Break one of these and the failure is silent data loss, not an error.

- **I1 — One process writes a room.** No two Node processes may serve the same
  database. Each holds its own `Y.Doc`, and the last snapshot flush wins.
- **I2 — A save never outlives its room.** `deleteRoom` sets `deleted`, clears
  the debounce timer, and awaits the in-flight save *before* deleting rows.
  Without this, a save started milliseconds earlier resurrects the notepad.
- **I3 — Tombstones are checked before loading.** Loading a deleted room would
  create an empty in-memory room that a stale client can repopulate.
- **I4 — Updates are not echoed to their author.** The connection is the
  transaction origin; the broadcaster skips it.
- **I5 — The client is built with the same `BASE_PATH` as the server.** The
  prefix is baked into asset and API URLs; a mismatch yields 404s or a socket
  aimed at the wrong path.
- **I6 — Blob rows are deleted before blobs.** A crash between the two leaves
  an orphan blob (reclaimable) rather than a row pointing at nothing (a
  permanently broken link).
- **I7 — Only one deployment mode runs at a time.** Compose and PM2 both target
  the same database and both keep rooms in memory.
- **I8 — `tabs` and `files` are only mutated inside a transaction that also
  updates metadata.** A half-updated array is a visible glitch for everyone.
- **I9 — Room ids are validated before touching SQL or the filesystem.**
  `[A-Za-z0-9_-]{1,64}`, enforced at every boundary.

## 8. Flows

### 8.1 Opening a notepad

```
Browser                         Node                          Postgres
   │ GET /n/<room> ───────────────►│ static index.html
   │                               │
   │ WS  /ws/<room> ──────────────►│ upgrade handler validates room
   │                               │ isRoomDeleted? ──────────────►│ (tombstone)
   │                               │ getRoom() ───────────────────►│ SELECT state
   │                               │◄──────────────────────────────│
   │◄── sync step 1 (state vector)─│
   │─── sync step 2 (my updates) ─►│ applyUpdate → broadcast to peers
   │◄── sync step 2 (their diffs) ─│
   │◄── awareness (who is here) ───│
   │                               │
   │ bootstrap: if tabs is empty,  │
   │ create one tab after sync     │
```

The first participant creates the initial tab *after* the first sync, so a
notepad opened from two machines does not end up with two bootstrap tabs in the
common case.

### 8.2 Typing

The client applies the edit locally first, then emits a binary update. The
server applies it to its replica and forwards it to every *other* connection,
with persistence scheduled 750 ms later. Presence (cursors, names) travels on
the awareness channel, which is **not** persisted.

### 8.3 Attachments

```
Browser                          Node                        Disk
   │ POST /api/rooms/:room/files   │                          │
   │  multipart "file" ───────────►│ multer (memory, 25 MB)   │
   │                               │ validate room            │
   │                               │ write uuid blob ────────►│
   │                               │ INSERT room_files ──────►│ (PG)
   │◄── {id,name,mime,size} ───────│                          │
   │ files.push(meta) into Yjs     │  → every peer's sidebar   │
```

Bytes never pass through Yjs. What syncs is a pointer: `{ id, name, mime, size }`.

### 8.4 Deleting a file

`DELETE /api/rooms/:room/files/:id` → delete row → unlink blob → response →
client removes the entry from `files`. Server first, Yjs second, deliberately: a
failed Yjs removal leaves a dead link that self-heals on the next list update,
whereas the reverse order would strand a blob with no row, invisible to GC.

### 8.5 Deleting a notepad

```
Client                      Node                              Postgres
  │ DELETE /api/rooms/:room ──►│                               │
  │                            │ deleteRoom()                  │
  │                            │  mark deleted, clear timer    │
  │◄── 4404 close (all socks) ─│  close every connection       │
  │    show "deleted"          │  await in-flight save  (I2)   │
  │                            │  BEGIN                        │
  │                            │   DELETE room_files           │
  │                            │   DELETE ydoc_state           │
  │                            │   INSERT deleted_rooms        │
  │                            │  COMMIT                       │
  │                            │  unlink blobs                 │
  │◄── 200 {ok,files,blobs} ───│                               │
```

Close code **4404** is in the 4400–4499 range that `y-websocket` treats as
permanent: clients stop reconnecting and surface "deleted" instead of retrying
into a fresh, empty notepad.

### 8.6 Reconnecting to a dead URL

Tombstone checked before load → connection closed 4404 → no room is created.
This is what stops a stale tab, a same-browser BroadcastChannel peer, or a
client that was briefly offline from pushing a cached copy back.

## 9. Persistence and durability

- **Write model:** debounced full-state upsert (`FLUSH_DELAY_MS`, default 750 ms).
- **Additional flush points:** last connection closing, and `SIGTERM`/`SIGINT`.
- **Crash window:** at most one debounce interval of typing. Yjs keeps the
  client copy, so a reconnecting client re-pushes what the server missed — the
  window is normally invisible unless every participant also disconnects.
- **Load model:** read snapshot, `applyUpdate`, then attach listeners (restoring
  state must not count as a change, or every cold start rewrites the row).
- **Compaction:** not needed. Full-state snapshots are self-compacting.
- **Eviction:** rooms with no connections, no pending timer and no in-flight
  save are dropped from memory after `IDLE_ROOM_MS` (10 min). They reload from
  Postgres on demand.

## 10. Concurrency model

- **Within a room:** Yjs guarantees convergence regardless of arrival order.
  The server is an ordering convenience, not a correctness requirement. A client
  that reconnects sends its state vector and exchanges only differences.
- **Across connections:** the server suppresses echo to the origin (I4) and
  otherwise fans out blindly. It never interprets document semantics.
- **Across browser tabs:** `y-websocket` also syncs same-origin providers over
  `BroadcastChannel`. That is desirable (two tabs stay consistent without a
  round trip) and is precisely why deletion needs a durable tombstone rather
  than relying on "the room no longer exists".
- **Across processes:** unsupported (I1). There is no pub/sub; two writers would
  each flush divergent snapshots.

## 11. Failure modes

| Failure | Behaviour | Recovery |
| --- | --- | --- |
| Postgres unreachable | `/api/health` 503; room loads fail; writes lose persistence | Fix DB; clients re-push on reconnect |
| Process killed (SIGKILL) | ≤ `FLUSH_DELAY_MS` of edits lost server-side; clients still hold them | Restart; reconnecting clients re-send |
| Process restarted (SIGTERM) | Rooms flushed, sockets closed 1001 | Clients reconnect and re-sync |
| Blob missing on disk | Download 404s, row remains | Restore from backup; GC will not remove the row |
| Orphan blob | Unreferenced file on disk | Hourly GC (age > 1 h) |
| Tunnel down | Origin unreachable, portfolio unaffected if rule order is right | `systemctl restart cloudflared` |
| Two instances on one DB | Silent loss on every save collision | Stop one (I7) |
| Stale client after delete | 4404, terminal; no resurrection | — |
| Upload mid-flight during delete | Row disappears with the room; blob becomes an orphan | GC |

## 12. Capacity and scaling

Costs are per **open** notepad, not per stored notepad:

- memory ≈ `Y.Doc` overhead + Yjs item overhead for the loaded text, per room,
  held only while someone is connected (or within the 10-minute idle window);
- Postgres writes ≈ one row update per `FLUSH_DELAY_MS` of active typing;
- blob writes are one file per upload, capped by `MAX_FILE_BYTES`.

Scaling out requires changing the ownership model, not adding replicas. The two
viable directions:

1. **Sticky room ownership** — route every connection for a room to the same
   worker, with the room excluded from others. Needs a lobby/registry and
   hand-off on failure.
2. **Shared pub/sub** — a Redis/NATS bus plus one designated writer per room so
   replicas stay consistent. Adds a dependency and a split-brain story.

Until one of those exists, `instances: 1` is a correctness setting.

## 13. Security model

- **Capability URL.** Knowing the room id grants read, write, and delete. This is
  intentional; see [ADR-010](decisions.md#adr-010-url-as-the-only-capability).
- **Guessability.** Room ids are 12 hex characters ≈ 48 bits, generated with
  `crypto.getRandomValues`. Adequate against incidental guessing; not a
  cryptographic access control. Raise to `uid(12)` (96 bits) in
  `src/client/router.tsx` if you want a wider margin.
- **Stored XSS.** Uploads are served with `Content-Disposition: attachment` and
  `X-Content-Type-Options: nosniff`, so an uploaded `.html` cannot execute in the
  app's origin.
- **Path traversal.** Blob filenames are server-generated UUIDs; user input
  never reaches a path.
- **Cross-site writes.** Destructive verbs require preflight (blocked without
  CORS). A cross-origin multipart `POST` can still create junk in a room whose id
  the attacker knows; there is no read access and no rate limiting.
- **Transport.** TLS terminates at Cloudflare; the origin is loopback-only.
- **Optional hardening.** Cloudflare Access in front of the hostname adds
  identity without touching application code.

## 14. Observability

Deliberately minimal: structured-ish `console` lines for startup, deletes, GC
results, persistence failures and WebSocket load failures, plus `/api/health`
reporting DB reachability and in-memory room count.

There are no metrics, traces, or error reporting. At single-host scale, `pm2
logs` and `journalctl -u cloudflared` are the intended tools. The first thing to
add if that stops being enough is a counter for save failures — that is the
failure mode that silently loses data.

## 15. Related documents

- [Sync protocol](sync-protocol.md) — the wire format and handshake.
- [Reference](reference.md) — endpoints, environment variables, schema.
- [Operations](operations.md) — deploy, backup, GC, troubleshooting.
- [Decisions](decisions.md) — why the system is shaped this way.
- [Testing](testing.md) — what the tests assert and what they deliberately do not.

## 16. Glossary

| Term | Meaning |
| --- | --- |
| **notepad / room** | One URL, one `Y.Doc`, one entry in `ydoc_state` |
| **tab** | A member of `tabs` with its own `Y.Text` body |
| **dump** | Informal: a notepad used to throw things into |
| **blob** | One file under `DATA_DIR/files`, named by uuid |
| **tombstone** | A `deleted_rooms` row making a URL permanently dead |
| **origin** | Yjs transaction origin; used to skip echoing to the sender |
| **awareness** | Ephemeral presence (name, colour, cursor); never persisted |
