import { withBase } from './base'
import { uid } from './ui'

export type RoomAccess = {
  room: string
  locked: boolean
  unlocked: boolean
  listed: boolean
}

export async function fetchAccess(room: string): Promise<RoomAccess> {
  const response = await fetch(
    withBase(`/api/rooms/${encodeURIComponent(room)}/access`),
  )
  if (!response.ok) throw new Error(`access check failed (${response.status})`)
  return (await response.json()) as RoomAccess
}

export async function unlockRoom(
  room: string,
  pin: string,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(
    withBase(`/api/rooms/${encodeURIComponent(room)}/unlock`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    },
  )

  if (response.ok) return { ok: true }

  let message = `unlock failed (${response.status})`
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    // keep the status-based message
  }
  return { ok: false, error: message }
}

/**
 * Creates the notepad row (and its password) before navigating. If a password
 * was chosen we unlock immediately, so the creator is not asked for the
 * password they just typed.
 */
export async function createNotepad(
  pin?: string,
): Promise<{ room: string; locked: boolean }> {
  const room = uid(6)

  const response = await fetch(withBase('/api/rooms'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pin ? { room, pin } : { room }),
  })

  if (!response.ok) {
    let message = `could not create notepad (${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // keep the status-based message
    }
    throw new Error(message)
  }

  if (pin) await unlockRoom(room, pin)
  return { room, locked: Boolean(pin) }
}
