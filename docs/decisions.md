# Decision log

Architecture decisions in ADR form: what was decided, what it cost, and what was
rejected. Read [architecture.md](architecture.md) for how the pieces fit.

---

## ADR-001: Yjs instead of Etherpad

**Status:** accepted (supersedes the initial Etherpad prototype)

**Context.** The first build used Etherpad 3.3.11 (Apache-2.0) in Docker behind a
tunnel. It solved realtime text and persistence well, but two requirements came
up that it cannot express: a notepad with **multiple tabs**, and **file
attachments**. Etherpad's unit is one pad = one text document; there is no API or
plugin surface for several documents in one pad, and the only attachment path was
a third-party images-only plugin last published in January 2024 against a 1.x
peer dependency.

**Decision.** Replace the application layer with a small Node + Yjs service.
Keep the operational layer (Postgres, tunnel, deployment story).

**Consequences.**

- Tabs become an array of independent `Y.Text`s; attachments become a synced
  array of pointers. Both are native to the data model.
- We own the UI, admin tooling, rate limiting, and the editor integration that
  Etherpad provided.
- The authentication model becomes "the URL is the secret" rather than a choice.

---

## ADR-002: Pin Yjs 13 and implement the protocol

**Status:** accepted

**Context.** The official server (`@y/websocket-server`) depends on Yjs 14
(prequel). The editor binding (`y-codemirror.next`) peers on Yjs 13. Yjs compares
types by identity, so two copies of the library in one process corrupt shared
state in ways that are hard to diagnose.

**Decision.** Pin `yjs@13.6.33` across client and server, and implement the
~120-line `y-websocket` protocol in `server/sync.js` using `y-protocols` and
`lib0`, which the client already uses.

**Consequences.**

- One Yjs version, no identity split. `npm ls yjs` is a deployment check.
- The protocol is stable, documented (`docs/sync-protocol.md`) and covered by the
  smoke test.
- Moving to Yjs 14 later means replacing both the server module and the editor
  binding, not just bumping a version.
- We inherit responsibility for keepalive, close codes and background-awareness
  cleanup that a library would have handled.

---

## ADR-003: Whole-state snapshots in Postgres

**Status:** accepted

**Context.** A Yjs document must be persisted. Options considered: an append-only
log of updates, the bundled LevelDB persistence (`y-leveldb`), a dedicated sync
service (`y-sweet`/Jamsocket), or periodic full-state snapshots.

**Decision.** Store one merged `Y.encodeStateAsUpdate(doc)` per room in a single
`bytea` column, upserted after a 750 ms debounce and on disconnect/shutdown.

**Consequences.**

- No compaction logic, no replay growth, and a cold start is a single row read.
- Maximum server-side loss on `SIGKILL` is the debounce window; a reconnecting
  client re-pushes what the server missed.
- No revision history — that would need a separate append-only store.
- Snapshots of very large documents rewrite the whole row; acceptable for text
  notepads, wrong for multi-megabyte documents at high edit rates.

---

## ADR-004: Durable tombstones

**Status:** accepted

**Context.** The first delete implementation removed the state row and closed
connections, yet a "deleted" notepad reappeared intact. Two independent causes:

1. A debounced save could still be in flight and rewrite the row after the
   delete committed.
2. `y-websocket` syncs same-room providers in-process over `BroadcastChannel`, so
   a stale tab could hand its cached document to a new connection, which then
   pushed it to the server. This is not a test artifact — it happens between two
   tabs of the same browser.

**Decision.** Two mechanisms:

- Deletion marks the room `deleted`, clears the debounce timer, closes sockets
  with `4404`, awaits any in-flight save, then deletes rows **and** inserts a
  `deleted_rooms` tombstone in one transaction.
- Tombstones are checked **before** a room is loaded, so a deleted URL cannot be
  recreated by any client path, including after a server restart.

**Consequences.**

- A deleted URL is permanently dead; "undelete" is an explicit SQL operation.
- One tiny row per deleted notepad accumulates forever (cheap; prune by hand if
  it ever matters).
- The client must treat `4404` as terminal and show a deleted state rather than
  reconnecting — otherwise it would fight the tombstone in a loop.

---

## ADR-005: Files on local disk, not object storage

**Status:** accepted

**Context.** Attachments need bytes somewhere. Options: S3/R2 with presigned
uploads, the MinIO instance already running on the host, or the local filesystem.

**Decision.** Write blobs to `DATA_DIR/files/<uuid>` after a memory-buffered
multipart upload, with metadata in Postgres.

**Consequences.**

- No cloud credentials, no presigned-URL flow, no CORS; uploads work on a host
  with no external dependencies.
- Backups are two halves (database + directory) and must be kept consistent.
- Per-file cap is enforced by RAM (25 MB buffered per concurrent upload), not by
  streaming to disk.
- Horizontal scale-out would require object storage; the module boundary
  (`server/files.js`) is small enough to swap.
- Blob garbage collection becomes our problem; see the age-guarded sweep.

**Rejected.** MinIO was available on the same host, but adds a second system of
record and credentials for no benefit at this scale.

---

## ADR-006: React + TanStack Router, without Query or Start

**Status:** accepted

**Context.** The client needs routing, an editor, and reactive rendering of Yjs
state. "Use TanStack" is ambiguous across Router, Query, Start and Table.

**Decision.** React 19 with **TanStack Router** (code-based routes, typed params,
`beforeLoad` validation and redirects). No TanStack Query. No TanStack Start.

**Consequences.**

- Route-level concerns (`/`, `/n/$roomId`, id minting, malformed-id rejection)
  are declarative and typed. The router's `basepath` handles path mounting.
- Live state is Yjs, not an HTTP cache: there is nothing to invalidate, so Query
  would wrap a single upload mutation in ceremony.
- The app is websocket-first with a raw HTTP upgrade handler; SSR and server
  functions buy nothing, and hosting a `ws` upgrade inside a server framework is
  friction.
- Yjs reactivity is a ~10-line `useYArray` / `usePresenceUsers` hook pair rather
  than a binding library.

---

## ADR-007: One process, no cluster

**Status:** accepted (constraint, not preference)

**Context.** PM2 makes `instances: N` a one-word change. Each process would load
its own `Y.Doc` per room and flush its own snapshots to the same rows.

**Decision.** `exec_mode: fork`, `instances: 1`, documented as invariant I1.

**Consequences.**

- Two people in the same notepad always reach the same process.
- Throughput is bounded by one core for protocol work.
- Scaling requires room ownership or shared pub/sub (see architecture §12), not
  a config flag. Cluster mode is a data-loss bug, not a performance setting.

---

## ADR-008: `BASE_PATH` is build-time

**Status:** accepted

**Context.** The app can be mounted at the root or under a prefix. Asset URLs,
API calls, the websocket path and the router basepath all depend on it.

**Decision.** One `BASE_PATH` value is read at **build** time by
`vite.config.ts` (from `.env` or the shell) and at **runtime** by the server.

**Consequences.**

- Changing the mount point requires a rebuild, not a restart.
- `vite.config.ts` reads `.env` explicitly, so a plain `npm run build` cannot
  silently produce a root-mounted bundle for a path deployment.
- Build and runtime values must match; the failure mode is 404s or a socket to
  the wrong path, not a startup error.

---

## ADR-009: Subdomain over path

**Status:** accepted

**Context.** The app was initially targeted at `example.com/livesync`. The origin
already served a portfolio on the apex through the same tunnel.

**Decision.** Serve `livesync.example.com` instead.

**Consequences.**

- No `BASE_PATH`, no route-ordering risk, no shared-origin cookies, and the apex
  ingress rules are untouched.
- Costs one DNS record and one ingress rule; Universal SSL covers the first-level
  subdomain.
- Path mounting remains supported for cases where a subdomain is unavailable.

---

## ADR-010: URL as the only capability

**Status:** accepted

**Context.** The product idea is "paste a link and it works". Accounts would
contradict that, but the same URL grants edit **and** delete rights.

**Decision.** No authentication. The room id is an unguessable capability. Access
control, if wanted, is layered at the edge (Cloudflare Access) rather than in the
application.

**Consequences.**

- Zero onboarding; anyone with the link can edit or destroy the notepad.
- Room ids are 48-bit (`uid(6)`); adequate against guessing, not a substitute for
  access control. Raise to `uid(12)` for a wider margin.
- No audit trail of who changed what.
- Rate limiting and abuse handling are absent; an edge policy is the intended
  lever.
