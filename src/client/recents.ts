const KEY = 'livesync:recents'
const MAX = 20

export type RecentRoom = {
  room: string
  name: string
  at: number
}

/**
 * Local-only history. Deliberately not server-side: "where are my notepads"
 * should not require the server to remember who visited what.
 */
export function readRecents(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is RecentRoom =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as RecentRoom).room === 'string' &&
          typeof (item as RecentRoom).name === 'string' &&
          typeof (item as RecentRoom).at === 'number',
      )
      .slice(0, MAX)
  } catch {
    return []
  }
}

export function rememberRoom(room: string, name: string): void {
  const rest = readRecents().filter((item) => item.room !== room)
  rest.unshift({ room, name, at: Date.now() })
  try {
    localStorage.setItem(KEY, JSON.stringify(rest.slice(0, MAX)))
  } catch {
    // Storage full or unavailable: recents are a convenience, never required.
  }
}
