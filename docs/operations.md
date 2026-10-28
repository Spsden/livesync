# Operations

How to run, deploy, back up and repair this system. Configuration values are in
[reference.md](reference.md); design rationale is in
[architecture.md](architecture.md).

## Current deployment

| Item | Value |
| --- | --- |
| Public URL | `https://livesync.surajpratap.space` |
| Origin | `127.0.0.1:3002`, PM2 app `live-sync` |
| Tunnel | locally-managed, `/etc/cloudflared/config.yml`, systemd `cloudflared` |
| Database | Docker Compose `postgres`, published on `127.0.0.1:5433` |
| Blobs | `./data/files` (PM2 `cwd`) |
| Base path | empty (dedicated subdomain) |

Everything below uses generic hostnames; substitute as needed.

## Prerequisites

- Node.js ≥ 22 (the app uses `--env-file-if-exists` and `fetch`)
- Postgres 15+
- `cloudflared` for ingress
- `pm2` for supervision

## First-time deploy (PM2)

`ecosystem.config.cjs` runs one `fork` instance and reads `.env` via
`--env-file-if-exists`. It never uses cluster mode — see invariant I1.

```sh
cp .env.example .env      # set POSTGRES_PASSWORD
$EDITOR .env              # PORT, HOST, DATA_DIR, DB_PORT, BASE_PATH
npm ci
npm run build             # required: the server serves dist/client
pm2 start ecosystem.config.cjs
pm2 save                  # survive reboot
pm2 startup               # one-time, if PM2 is not already a boot service
```

A PM2 `.env` for this shape:

```sh
PORT=3002
HOST=127.0.0.1          # loopback only; cloudflared connects locally
DATA_DIR=./data
DB_PORT=5433            # wherever Postgres is reachable from this host
BASE_PATH=              # empty: dedicated subdomain
```

Verify before involving the edge:

```sh
curl -s http://127.0.0.1:3002/api/health     # {"ok":true,"rooms":0}
pm2 logs live-sync --lines 20 --nostream
```

### Postgres

Either run the Compose service or point at an existing server:

```sh
docker compose up -d postgres     # publishes 127.0.0.1:${PG_PORT} (5433)
```

The app builds its URL from `POSTGRES_*` + `DB_PORT` (falling back to `PG_PORT`),
so no duplicate connection string is needed.

### Tunnel and DNS

Use a dedicated subdomain. It is additive and cannot affect other hostnames.

```sh
cloudflared tunnel create live-sync          # if you do not already have one
cloudflared tunnel route dns <tunnel> livesync.example.com
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /home/<you>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: livesync.example.com
    service: http://127.0.0.1:3002
  - service: http_status:404
```

```sh
cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
systemctl restart cloudflared
curl -s https://livesync.example.com/api/health
```

Keep one authoritative copy. If you edit a home copy and `/etc` separately, a
validation run can silently check a different file than the service uses.

**Hosting under a path instead** (`example.com/livesync`) requires
`BASE_PATH=/livesync` at build *and* runtime, plus a regex `path` ingress rule
placed before the apex rule. cloudflared does not strip the prefix. See
[`cloudflared/config.yml.example`](../cloudflared/config.yml.example).

## Updating

```sh
git pull
npm ci
npm run build                     # always: dist/client is what users load
pm2 restart live-sync --update-env
curl -s https://livesync.example.com/api/health
```

`--update-env` is required for `.env` changes to take effect; without it PM2
restarts with the cached environment.

Do **not** run `pm2 restart live-sync` while a second copy is running from Docker
against the same database.

### Docker alternative

```sh
docker compose up -d --build
docker compose --profile tunnel up -d    # token-based tunnel, hostname-level only
```

Compose injects its own `PORT`, `DATABASE_URL`, `DATA_DIR` and `BASE_PATH`. For a
path mount, build with the arg: `BASE_PATH=/livesync docker compose build`.

## Backups

Two independent halves. A dump without the other half is a partial restore.

```sh
mkdir -p backups

# text, file metadata, tombstones
docker compose exec -T postgres \
  pg_dump -U livesync livesync | gzip > "backups/db-$(date +%F).sql.gz"

# blobs (PM2 layout)
tar czf "backups/files-$(date +%F).tgz" ./data

# blobs (Compose volume)
docker run --rm -v live-sync_app_data:/data:ro -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/files-$(date +%F).tgz" -C /data .
```

Restore:

```sh
gunzip -c backups/db-2026-10-28.sql.gz | \
  docker compose exec -T postgres psql -U livesync -d livesync
tar xzf backups/files-2026-10-28.tgz          # into DATA_DIR
```

Restore both, then `pm2 restart live-sync`. A `room_files` row without its blob
downloads 404; a blob without its row is reclaimed by GC after an hour.

Schedule it (cron/systemd timer) and **restore once into a scratch database**
before trusting it.

## Garbage collection

Orphan blobs are expected: deletes unlink after removing rows, and an upload that
dies mid-flight never gets a row.

```sh
npm run gc        # honors GC_MIN_AGE_MS, default 1 hour
```

It runs automatically on startup and hourly in-process. The age guard protects
uploads whose row has not been inserted yet.

> GC must run with the **same** `DATABASE_URL` and `DATA_DIR` as the server.
> Pointed at the right directory with the wrong database, it would delete live
> attachments.

## Deleting data

**One notepad** — the UI (Delete → type `delete`) or:

```sh
curl -X DELETE https://livesync.example.com/api/rooms/<room>
```

Removes state, file rows, blobs and live connections; writes a tombstone.

**Undelete a URL** (content is not recoverable):

```sh
docker compose exec -T postgres psql -U livesync -d livesync \
  -c "delete from deleted_rooms where room = '<room>'"
```

**Wipe everything** (irreversible):

```sh
docker compose exec -T postgres psql -U livesync -d livesync \
  -c "truncate ydoc_state, room_files, deleted_rooms"
rm -f data/files/*
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `https://livesync.../api/health` returns the *portfolio* | ingress rule missing or ordered after the apex rule | put the hostname rule before the catch-all; `tunnel ingress rule <url>` |
| 404 from Cloudflare on every path | tunnel running old config | `sudo cp` config, `systemctl restart cloudflared` |
| 1033 / 502 | origin not listening, or wrong port | `ss -ltnp \| grep 3002`, `pm2 logs live-sync` |
| Page loads, websocket never connects | `HOST`/port mismatch, or `BASE_PATH` differs between build and server | check `ws` URL in devtools; rebuild |
| Assets 404 after deploy | built with a different `BASE_PATH` | `npm run build` with the intended `.env` |
| Users on stale JS | `npm run build` skipped | rebuild; hard refresh |
| `{"ok":false}` / 503 | Postgres down or wrong `DB_PORT` | `docker compose ps postgres`, test `psql` |
| Edits vanish after restart | writing to the wrong database / volume | verify `DATABASE_URL` and the Compose volume |
| Upload `413` | size limit | raise `MAX_FILE_BYTES` (and restart) |
| Download 404 but row exists | blob missing, usually wrong `DATA_DIR` under PM2 | check `pm2 describe live-sync` `cwd` |
| "This notepad was deleted" for a live URL | tombstone present | delete the `deleted_rooms` row if intended |
| Cursors never disappear | client disconnected uncleanly | heartbeat terminates in ≤ 60 s; check `SOCKETIO`-style proxy timeouts |
| `.env` change ignored | PM2 cached env | `pm2 restart live-sync --update-env` |

## Logs

```sh
pm2 logs live-sync --lines 100
journalctl -u cloudflared -n 100 --no-pager
docker compose logs -f postgres
```

Application log lines worth alerting on (they indicate data loss, not noise):

- `[persist] room <id> failed to save:` — snapshot not written
- `[gc] ... failed` — blob reclamation broken
- `[files] write failed` / `[files] row failed` — upload path broken

## Upgrading dependencies

The Yjs pin is deliberate; see [decisions.md](decisions.md#adr-002-pin-yjs-13-and-implement-the-protocol).
Before bumping anything in that family:

```sh
npm ls yjs          # exactly one version must resolve
npm run typecheck
BASE=http://127.0.0.1:3002 npm run smoke
```

Then run the browser suite in [testing.md](testing.md) against a staging port.
