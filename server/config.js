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
  maxFileBytes: Number(env.MAX_FILE_BYTES ?? 25 * 1024 * 1024),
  // How long to batch doc changes before writing the merged state to Postgres.
  // A crash can lose at most this window.
  flushDelayMs: Number(env.FLUSH_DELAY_MS ?? 750),
  // Drop idle documents from memory once nobody has been connected for this long.
  idleRoomMs: Number(env.IDLE_ROOM_MS ?? 10 * 60 * 1000),
}

// Room names are the only secret in the system, so they are URL-safe and
// bounded. Anything else is rejected before it reaches the filesystem or SQL.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isValidRoom = (room) => typeof room === 'string' && ROOM_RE.test(room)
