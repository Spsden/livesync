import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.js'
import { getRoomAccess } from './db.js'

const scrypt = promisify(scryptCallback)

export const MIN_PIN_LENGTH = 6

export function isValidPin(pin) {
  return typeof pin === 'string' && pin.length >= MIN_PIN_LENGTH && pin.length <= 128
}

export async function hashPin(pin) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(pin, salt, 32)
  return { salt, hash: derived.toString('hex') }
}

/** scrypt is deliberately slow; that is why unlocking is rate limited. */
export async function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false
  const derived = await scrypt(pin, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

// ------------------------------------------------------------------ cookies ---

export const cookieName = (room) => `ls_room_${room}`

function sign(room, version) {
  return createHmac('sha256', config.cookieSecret)
    .update(`${room}:${version}`)
    .digest('base64url')
}

export function issueCookie(room, version) {
  return `${version}.${sign(room, version)}`
}

export function cookieIsValid(value, room, version) {
  if (typeof value !== 'string') return false
  const separator = value.indexOf('.')
  if (separator === -1) return false

  const rawVersion = value.slice(0, separator)
  const mac = value.slice(separator + 1)
  if (Number(rawVersion) !== version) return false

  const expected = sign(room, version)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function readCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals === -1) continue
    if (part.slice(0, equals).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(equals + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

// ------------------------------------------------------------------- access ---

/**
 * Whether a room needs a password and whether this request has already passed
 * it. A room with no `rooms` row (pre-directory) is open.
 */
export async function roomAccess(room, req) {
  const row = await getRoomAccess(room)
  if (!row || !row.pin_hash) {
    return { locked: false, unlocked: true, listed: Boolean(row?.listed) }
  }
  return {
    locked: true,
    unlocked: cookieIsValid(
      readCookie(req, cookieName(room)),
      room,
      row.pin_version,
    ),
    listed: row.listed === true,
  }
}

/** Express middleware for endpoints that mutate or read a locked notepad. */
export async function requireRoomAccess(req, res, next) {
  try {
    const { room } = req.params
    const access = await roomAccess(room, req)
    if (access.locked && !access.unlocked) {
      return res.status(401).json({ error: 'notepad is locked' })
    }
    next()
  } catch (error) {
    next(error)
  }
}

// ------------------------------------------------------------ rate limiting ---

const attempts = new Map()

export function pinAttemptKey(req, room) {
  return `${room}|${req.ip ?? 'unknown'}`
}

export function pinRateLimited(key) {
  const entry = attempts.get(key)
  if (!entry) return false
  if (entry.resetAt < Date.now()) {
    attempts.delete(key)
    return false
  }
  return entry.count >= config.pinAttempts
}

export function notePinFailure(key) {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + config.pinWindowMs })
  } else {
    entry.count += 1
  }

  if (attempts.size > 5000) {
    for (const [candidate, value] of attempts) {
      if (value.resetAt < now) attempts.delete(candidate)
    }
  }
}

export function clearPinFailures(key) {
  attempts.delete(key)
}
