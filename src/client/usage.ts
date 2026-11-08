import { withBase } from './base'

export type NotepadUsage = {
  noteBytes: number
  fileBytes: number
  used: number
  limit: number
}

export async function fetchUsage(room: string): Promise<NotepadUsage> {
  const response = await fetch(
    withBase(`/api/rooms/${encodeURIComponent(room)}/usage`),
  )
  if (!response.ok) throw new Error(`usage check failed (${response.status})`)
  return (await response.json()) as NotepadUsage
}
