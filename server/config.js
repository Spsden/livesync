import { randomBytes } from 'node:crypto'

const env = process.env

/**
 * Compose injects DATABASE_URL for the container (host = `postgres`). Bare
 * metal — PM2, `npm start` — has no such thing, so fall back to the POSTGRES_*
 * variables already in .env. PG_PORT is the host port compose publishes
 * Postgres on, which is exactly what a host process needs to connect to.
 */
function defaultDatabaseUrl() {
  const user = encodeURIComponent(env.POSTGRES_USER ?? 'livesync')
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? 'livesync')
  const database = env.POSTGRES_DB ?? 'livesync'
  const host = env.DB_HOST ?? '127.0.0.1'
  const port = env.DB_PORT ?? env.PG_PORT ?? '5432'
  return `postgres://${user}:${password}@${host}:${port}/${database}`
}

/**
 * Mount the whole app under a path prefix (e.g. /livesync) instead of the
 * domain root. Empty string means root. Normalised to no trailing slash so
 * `${basePath}/api` is always well formed.
 */
function normaliseBasePath(raw) {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export const config = {
  port: Number(env.PORT ?? 3000),
  basePath: normaliseBasePath(env.BASE_PATH),
  // Docker publishes through the container network, so it needs 0.0.0.0.
  // A PM2 host behind cloudflared should set HOST=127.0.0.1 and stay private.
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? defaultDatabaseUrl(),
  dataDir: env.DATA_DIR ?? './data',
  // Per-file ceiling. A file can never exceed the notepad budget below.
  maxFileBytes: Number(env.MAX_FILE_BYTES ?? 20 * 1024 * 1024),
  // Combined budget per notepad: encoded Yjs snapshot + all attachment bytes.
  maxNotepadBytes: Number(env.MAX_NOTEPAD_BYTES ?? 20 * 1024 * 1024),
  // How long to batch doc changes before writing the merged state to Postgres.
  // A crash can lose at most this window.
  flushDelayMs: Number(env.FLUSH_DELAY_MS ?? 750),
  // Drop idle documents from memory once nobody has been connected for this long.
  idleRoomMs: Number(env.IDLE_ROOM_MS ?? 10 * 60 * 1000),
  // Signs per-room unlock cookies. Unset means a random secret per boot, which
  // invalidates every unlock on restart — fine locally, not in production.
  cookieSecret: env.COOKIE_SECRET ?? randomBytes(32).toString('hex'),
  cookieMaxAgeMs: Number(env.COOKIE_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000),
  pinAttempts: Number(env.PIN_ATTEMPTS ?? 5),
  pinWindowMs: Number(env.PIN_WINDOW_MS ?? 5 * 60 * 1000),

  // ---- abuse ceilings -------------------------------------------------------
  // Per-IP HTTP budgets. Normal app use is a handful of requests a minute —
  // the SPA talks almost exclusively over WebSocket once loaded.
  httpLimit: Number(env.HTTP_LIMIT ?? 600),
  httpWindowMs: Number(env.HTTP_WINDOW_MS ?? 5 * 60 * 1000),
  // Room creation is unauthenticated by design, so it needs its own tight
  // budget: it is the one endpoint that can grow the database without a URL.
  createLimit: Number(env.CREATE_LIMIT ?? 10),
  createWindowMs: Number(env.CREATE_WINDOW_MS ?? 60 * 60 * 1000),
  uploadLimit: Number(env.UPLOAD_LIMIT ?? 30),
  uploadWindowMs: Number(env.UPLOAD_WINDOW_MS ?? 60 * 60 * 1000),
  // Global ceilings: even within per-IP budgets, the service as a whole must
  // never be able to fill the disk or grow rooms without bound.
  maxRooms: Number(env.MAX_ROOMS ?? 2000),
  maxTotalFileBytes: Number(env.MAX_TOTAL_FILE_BYTES ?? 5 * 1024 * 1024 * 1024),
  // WebSocket ceilings. Payload is small: Yjs updates and awareness frames
  // are bytes-to-kilobytes, so 256KB is generous.
  wsMaxPayloadBytes: Number(env.WS_MAX_PAYLOAD_BYTES ?? 256 * 1024),
  wsMaxPerIp: Number(env.WS_MAX_PER_IP ?? 20),
  wsMaxTotal: Number(env.WS_MAX_TOTAL ?? 500),
  wsMsgPerSec: Number(env.WS_MSG_PER_SEC ?? 300),
}

// Room names are the only secret in the system, so they are URL-safe and
// bounded. Anything else is rejected before it reaches the filesystem or SQL.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isValidRoom = (room) => typeof room === 'string' && ROOM_RE.test(room)
