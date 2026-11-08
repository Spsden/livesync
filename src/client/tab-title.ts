import type { TabMeta } from './types'

export const UNTITLED = 'untitled'

/** A title the user typed. Anything else is derived from the content. */
export function hasManualTitle(tab: TabMeta): boolean {
  const title = tab.title.trim()
  return title !== '' && title !== UNTITLED
}

/**
 * First non-empty line, stripped of markdown markers, clipped to a readable
 * length. Computed at display time so it stays live and needs no writes.
 */
export function deriveTitle(
  text: string,
  maxChars = 42,
  maxWords = 8,
): string {
  const first = text.split('\n').find((line) => line.trim() !== '')
  if (!first) return UNTITLED

  const cleaned = first
    .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return UNTITLED

  let out = cleaned.split(' ').slice(0, maxWords).join(' ')
  if (out.length > maxChars) {
    out = out.slice(0, maxChars)
    const space = out.lastIndexOf(' ')
    if (space > 12) out = out.slice(0, space)
  }

  return out.length < cleaned.length ? `${out}…` : out
}
