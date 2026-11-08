// Generic abuse limits for HTTP and WebSocket paths. In-memory on purpose:
// the server runs as a single fork (see ecosystem.config.cjs), so per-process
// state is authoritative. Style follows the pin attempt limiter in pin.js.

const windows = new Map()

/**
 * Fixed-window counter: `key` may make `limit` hits per `windowMs`. Keys are
 * namespaced by the caller (`http|1.2.3.4`, `create|1.2.3.4`, ...).
 */
export function hit(key, limit, windowMs) {
  const now = Date.now()
  let entry = windows.get(key)
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs }
    windows.set(key, entry)
  }
  entry.count += 1
  return {
    allowed: entry.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  }
}

/** Express middleware: 429 with Retry-After once the per-IP budget is spent. */
export function httpLimit({ limit, windowMs, keyPrefix, message }) {
  return (req, res, next) => {
    const { allowed, retryAfterSec } = hit(
      `${keyPrefix}|${req.ip ?? 'unknown'}`,
      limit,
      windowMs,
    )
    if (allowed) return next()
    res.setHeader('Retry-After', retryAfterSec)
    res.status(429).json({ error: message })
  }
}

/**
 * Token bucket for sustained rates (WS messages). `capacity` tokens refill at
 * `refillPerSec`; one message costs one token, bursts up to capacity pass.
 */
export function messageBucket(capacity, refillPerSec) {
  let tokens = capacity
  let last = Date.now()
  return function take() {
    const now = Date.now()
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

/**
 * Real client IP for upgrade requests, where Express and its `trust proxy`
 * never run. Cloudflare sets CF-Connecting-IP; the tunnel is the only way in
 * (the listener is bound to localhost), so the header is trustworthy.
 */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf) return cf
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

// Sweep occasionally so one-off visitors don't linger in the map forever.
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key)
  }
}, 60_000)
sweeper.unref()
