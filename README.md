# live-sync

A shared notepad you reach by URL. Paste a link into any machine, get one
notepad with tabs, live multi-cursor editing, and file attachments. No accounts.

- One URL = one notepad: `/n/<id>`. The home page explains it and creates one.
- Tabs are real, independent documents — add, rename, reorder, close.
- Text syncs as you type; contributors merge offline edits on reconnect.
- Drop or paste files (images, PDFs, logs) and they appear for everyone live.
- Everything persists until someone deletes it. Deleting really deletes.

## Documentation

| Document | Read it when |
| --- | --- |
| [Architecture](docs/architecture.md) | You need the system shape, invariants, flows, failure modes, scaling limits |
| [Sync protocol](docs/sync-protocol.md) | You are touching `server/sync.js` or the Yjs versions |
| [Reference](docs/reference.md) | You need endpoints, env vars, schema, limits |
| [Operations](docs/operations.md) | You are deploying, backing up, or debugging production |
| [Decisions](docs/decisions.md) | You want to know why something is the way it is |
| [Testing](docs/testing.md) | You are changing sync, persistence, or deletion |

Start with the architecture doc if you are new. The short version: one Node
process holds each open notepad as a [Yjs](https://yjs.dev) document in memory,
mirrors snapshots to Postgres, streams attachment bytes to disk, and speaks the
`y-websocket` protocol directly.

## Stack

| Layer | Choice |
| --- | --- |
| Client | React 19 + **TanStack Router**, CodeMirror 6 |
| Sync | Yjs 13 CRDT + `y-codemirror.next`, websocket protocol via `y-protocols` |
| Server | Node 22, Express 5 + `ws` (hand-rolled y-websocket protocol) |
| Text storage | Postgres, one merged Yjs state per room |
| File storage | `DATA_DIR/files` (Docker volume or `./data`), metadata in Yjs |
| Process | PM2 (bare metal) or Docker Compose |
| Ingress | Cloudflare Tunnel (no open ports) |

## Data model

One `Y.Doc` per notepad URL:

```
Y.Doc  (room)
├── tabs:       Y.Array<{ id, title }>     ← tab list + order, merges like text
├── tab:<id>:   Y.Text                     ← body of each tab
└── files:      Y.Array<{ id, name, mime, size }>
```

The tab list being a CRDT is the whole trick: adding a tab, renaming it, or
reordering is the same kind of operation as typing a character, so it converges
without a server referee. Each tab's body is its own `Y.Text`, which keeps undo
scoped per tab and stops one huge document from growing without bound.

Because `files` is also a CRDT array, an attachment uploaded by one person
appears in everyone's sidebar over the same socket — no polling, no refresh.

In Postgres:

| Table | Holds |
| --- | --- |
| `ydoc_state` | one merged Yjs snapshot per room (`bytea`) |
| `room_files` | file metadata, keyed by uuid |
| `deleted_rooms` | tombstone: this URL is dead, forever |

## Quick start (Docker)

```sh
cp .env.example .env      # set POSTGRES_PASSWORD
docker compose up -d --build
```

Open <http://127.0.0.1:3000>. If port 3000 is taken, set `APP_PORT` in `.env`
(this repo's `.env` uses 3100 for exactly that reason).

```sh
docker compose logs -f app    # follow logs
docker compose down           # stop; volumes survive
```

## Deployment with PM2

PM2 runs the Node server directly; Postgres and the file directory belong to the
host. This is the recommended setup when cloudflared also runs on the host.

```sh
cp .env.example .env    # set POSTGRES_PASSWORD, PORT, HOST, DATA_DIR

npm ci
npm run build           # writes dist/client, which the server serves
pm2 start ecosystem.config.cjs
pm2 logs live-sync
pm2 save && pm2 startup # follow the command PM2 prints
```

Typical `.env` for a PM2 host that already runs other apps:

```sh
PORT=3002          # pick a port nothing else uses
HOST=127.0.0.1     # only cloudflared can reach it
DATA_DIR=./data
DB_PORT=5433       # where Postgres is reachable from this host
```

Environment: `ecosystem.config.cjs` passes `--env-file-if-exists=.env`, so the
same `.env` drives PM2, `npm start` and `npm run gc`. The app builds its
connection string from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` and
looks for Postgres on `DB_PORT`, falling back to `PG_PORT`. Already-exported
environment variables win over the file.

Postgres options, either is fine:

```sh
docker compose up -d postgres     # published on PG_PORT (5433 by default)
# or point DB_HOST/DB_PORT at an existing local Postgres
```

Set `HOST=127.0.0.1` so the app is only reachable from the machine itself;
cloudflared connects to it locally and nothing is exposed on the LAN.

**Do not use PM2 cluster mode.** Open rooms live in each process's memory with no
cross-process pub/sub, so two workers would put two people in the same notepad on
different processes and their edits would never meet. `instances: 1`,
`exec_mode: 'fork'`.

Build after every deploy: the server serves the compiled client from
`dist/client`, so a `git pull` without `npm run build` keeps serving old JS.

## Local development

```sh
docker compose up -d postgres

# terminal 1 — API + websocket (reads .env, so no export dance)
PORT=3100 npm run dev:server

# terminal 2 — Vite HMR on :5173, proxying /api and /ws
SERVER_PORT=3100 npm run dev
```

Browse <http://127.0.0.1:5173>. `PORT` and `SERVER_PORT` must agree; both default
to 3000.

Checks:

```sh
npm run typecheck
BASE=http://127.0.0.1:3100 npm run smoke   # two-client sync, files, deletes
```

`scripts/smoke.mjs` is the guard rail for the risky parts: two real clients, tab
and text propagation, concurrent-edit convergence, awareness, file round-trip,
per-file delete, cross-room delete refusal, and a notepad delete that races the
debounced save.

## Cloudflare Tunnel

cloudflared dials out, so no port forwarding or inbound firewall rules. The
websocket upgrade passes through untouched. Two ways to expose it:

### Option A — a subdomain (simplest)

`https://livesync.example.com` → `http://localhost:3002`.

Zero Trust → Networks → Tunnels → your tunnel → **Public Hostname**:
Subdomain `livesync`, Service `HTTP` → `localhost:3002`. No `BASE_PATH`, no
rebuild. This is the option to pick when the app can have its own hostname.

### Option B — under a path (`example.com/livesync`)

The app must be built and run with the prefix, because cloudflared matches on
the path but **forwards it unstripped**:

```sh
# .env
BASE_PATH=/livesync

npm run build              # vite reads .env, so the prefix cannot drift
pm2 restart live-sync --update-env
```

**Dashboard route** (works with a remotely-managed, token-based tunnel — no new
tunnel, no DNS change):

Networking → Tunnels → your tunnel → Routes → **Add route** → Published
application:

| Field | Value |
| --- | --- |
| Subdomain | *(leave empty for the apex)* |
| Domain | `example.com` |
| Path | `/livesync` |
| Service URL | `http://localhost:3002` |

**Ordering matters.** Ingress rules are evaluated top to bottom and the first
match wins. The `/livesync` route must sit *above* the existing apex route that
serves your portfolio, otherwise the apex rule swallows every request. If the
dashboard appended it at the bottom, drag it up — confirm with:

```sh
curl -sS https://example.com/livesync/api/health   # {"ok":true,...}
```

If the dashboard route ordering fights you, use a locally-managed tunnel with an
explicit config instead: copy
[`cloudflared/config.yml.example`](cloudflared/config.yml.example) and validate
before running:

```sh
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://example.com/livesync/n/abc123
```

**The apex caveat.** A hostname can only resolve to one place. Serving a path on
`example.com` means the apex itself must point at the tunnel — which it
already does for your portfolio. That is why this works here: both apps are
reachable from the same machine. If the portfolio were on another box, a
subdomain would be the only sane option.

Docker users can run cloudflared from compose instead:

```sh
docker compose --profile tunnel up -d    # token-based, hostname-level only
```

Compose's token mode has no path rules; use a local config file for Option B.

## Locking it down

The room id is the only secret, so anyone with the link can read, write, and
delete. Generate unguessable ids and you're fine for personal use. For real
control, use **Cloudflare Access** (Zero Trust → Access → Applications →
Self-hosted): add an email policy and visitors authenticate at Cloudflare's edge
before the app sees the request. You keep the no-login feel for invited people
and write no auth.

## Deleting things

| What | How | What happens |
| --- | --- | --- |
| A tab | × in the tab bar | The tab's `Y.Text` is emptied in the same transaction, so stored state shrinks |
| One file | × on the file row | Row + blob removed, entry removed from the shared `files` array, peers update live |
| The notepad | **Delete** → type `delete` | State row, file rows and blobs removed; live clients are closed with code `4404` and show "deleted"; the URL is tombstoned |

**The URL stays dead.** `deleted_rooms` is checked before a room is loaded, so a
stale tab, a browser's cross-tab BroadcastChannel, or a server restart cannot
resurrect a deleted notepad by pushing a cached copy back. Undelete on purpose if
you must:

```sh
docker compose exec -T postgres \
  psql -U livesync -d livesync -c "delete from deleted_rooms where room = 'the-room-id'"
```

That re-enables the URL as an empty notepad; the content is gone.

### Blob garbage collection

Orphan blobs are expected: a notepad delete removes rows first and unlinks
second, and an upload that dies mid-flight never gets a row. The server sweeps
hourly on startup, and you can run it by hand:

```sh
npm run gc     # or: docker compose exec app node scripts/gc.mjs
```

It only removes files with **no row** that are **older than an hour** (young ones
may belong to an in-flight upload). It needs exactly the same `DATABASE_URL` and
`DATA_DIR` as the server — pointing it at the wrong directory would delete live
attachments.

## Backups

Two things hold data: Postgres (text + tombstones) and the files directory.

```sh
mkdir -p backups

# Docker Postgres
docker compose exec -T postgres \
  pg_dump -U livesync livesync | gzip > "backups/db-$(date +%F).sql.gz"

# Files (Docker volume)
docker run --rm -v live-sync_app_data:/data:ro -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/files-$(date +%F).tgz" -C /data .

# Files (PM2, DATA_DIR=./data)
tar czf "backups/files-$(date +%F).tgz" ./data
```

Restore:

```sh
gunzip -c backups/db-2026-10-28.sql.gz | \
  docker compose exec -T postgres psql -U livesync -d livesync
```

## Known limits

- **Single instance.** Open rooms live in memory and are mirrored to Postgres;
  there is no cross-replica pub/sub, so one process only.
- **Crash window.** State is written 750 ms after the last keystroke, plus on
  last-disconnect and on SIGTERM. A hard kill loses a fraction of a second.
- **Uploads are buffered in memory** before hitting disk, bounded by
  `MAX_FILE_BYTES` (25 MB default). Ten concurrent 25 MB uploads = 250 MB RAM.
- **No rate limiting.** A public instance with a guessable link is abusable; put
  Cloudflare Access in front if you care.
- **Delete is all-or-nothing per file.** No trash, no undo, no revision history.

## Design decisions worth knowing

**Why Yjs 13, not 14.** `@y/websocket-server` (the official successor to the
`y-websocket` server) depends on Yjs 14 prerelease, while `y-codemirror.next`
peers on Yjs 13. Two copies of Yjs in one process break its shared registry, so
the server speaks the ~120-line protocol in `server/sync.js` instead.

**Why tombstones live in Postgres.** An in-memory tombstone would evaporate on
restart, and the first stale tab to reconnect would recreate the notepad it had
just deleted. Durability is the point.

**Why `4404` and not a plain close.** `y-websocket` treats close codes 4400–4499
as permanent: clients stop reconnecting and emit a terminal `closed` event, which
is what lets the UI say "deleted" instead of retrying forever.

**Why whole-state snapshots.** One `bytea` row per room holding
`Y.encodeStateAsUpdate(doc)`. Appending deltas would need compaction logic and
still read the same on load; for notepads this is simpler and fast enough.

**Why `BASE_PATH` is build-time.** Vite bakes asset URLs and the router basepath
into the bundle, so the prefix cannot change at runtime. Server and client must
agree on one value, which is why `vite.config.ts` reads `BASE_PATH` out of `.env`
(not just the shell) — a plain `npm run build` then cannot produce a root-mounted
bundle for a path-hosted deployment. Mismatches show up as 404s for `/assets/*`
or a websocket aimed at the wrong path.

**Why no TanStack Query.** All live state is in Yjs, not the HTTP cache. There is
nothing to invalidate. TanStack Router earns its place (typed params,
`beforeLoad` validation, redirects); Query would be ceremony around a mutation.

**Why not TanStack Start.** Websocket-first client plus a raw HTTP upgrade
handler. SSR and server functions buy nothing, and wrapping the `ws` upgrade in a
server framework is friction.

## Roadmap

- [ ] Markdown preview toggle per tab
- [ ] Trash/restore instead of hard delete
- [ ] Rate limiting and per-room size caps
- [ ] Optional Cloudflare Access setup script
