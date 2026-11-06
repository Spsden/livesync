import type { TabMeta } from './types'

export type SearchHit = {
  tabId: string
  tabTitle: string
  score: number
  /** Match offset inside the tab's text, used to select it in the editor. */
  offset: number
  length: number
  snippet: string
  snippetStart: number
  snippetLength: number
}

type ContentMatch = { score: number; index: number; length: number }

const SNIPPET_BEFORE = 44
const SNIPPET_AFTER = 96
const WORD = /[\p{L}\p{N}_'-]+/gu

/**
 * How much typo tolerance a token earns. Three characters or fewer get none:
 * "add" vs "and" is one edit away, and accepting that makes results noise.
 */
function maxDistance(token: string): number {
  if (token.length <= 3) return 0
  if (token.length <= 5) return 1
  return 2
}

/** Bounded Levenshtein: bails out as soon as the best row exceeds `max`. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false

  let prev = new Uint16Array(b.length + 1)
  let curr = new Uint16Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      )
      curr[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return false
    const swap = prev
    prev = curr
    curr = swap
  }
  return (prev[b.length] ?? 0) <= max
}

/**
 * Finds one token: exact substring beats a word prefix, which beats a fuzzy
 * word. Returns the earliest occurrence at the highest weight found.
 */
function findToken(
  haystack: string,
  lower: string,
  token: string,
): { index: number; length: number; weight: number } | null {
  const exact = lower.indexOf(token)
  if (exact !== -1) return { index: exact, length: token.length, weight: 120 }

  const max = maxDistance(token)
  const first = token[0]

  let prefix: { index: number; length: number; weight: number } | null = null
  let fuzzy: { index: number; length: number; weight: number } | null = null

  const wordRe = new RegExp(WORD.source, 'gu')
  let match: RegExpExecArray | null
  while ((match = wordRe.exec(haystack)) !== null) {
    const raw = match[0]
    const word = raw.toLowerCase()

    if (word.startsWith(token)) {
      prefix = { index: match.index, length: token.length, weight: 80 }
      break
    }

    if (
      !fuzzy &&
      max > 0 &&
      first !== undefined &&
      word[0] === first &&
      Math.abs(word.length - token.length) <= max &&
      withinDistance(word, token, max)
    ) {
      fuzzy = { index: match.index, length: raw.length, weight: 45 }
    }
  }

  return prefix ?? fuzzy
}

/** Every token must match, in any order. The full phrase scores highest. */
function matchAll(
  haystack: string,
  tokens: string[],
  phrase: string,
): ContentMatch | null {
  const lower = haystack.toLowerCase()

  if (phrase && lower.includes(phrase)) {
    const index = lower.indexOf(phrase)
    return { score: 400 + tokens.length * 20, index, length: phrase.length }
  }

  let score = 0
  let firstIndex = -1
  let firstLength = 0

  for (const token of tokens) {
    const found = findToken(haystack, lower, token)
    if (!found) return null
    score += found.weight
    if (firstIndex === -1) {
      firstIndex = found.index
      firstLength = found.length
    }
  }

  return { score, index: Math.max(0, firstIndex), length: firstLength }
}

/**
 * Newlines become spaces so the snippet's offsets still line up with the match.
 * Trimming only happens after the offset is measured.
 */
function snippetAround(text: string, index: number, length: number) {
  const start = Math.max(0, index - SNIPPET_BEFORE)
  const end = Math.min(text.length, index + length + SNIPPET_AFTER)
  const raw = text.slice(start, end).replace(/\n/g, ' ')
  const lead = raw.length - raw.trimStart().length
  const snippet = raw.trim()
  const snippetStart = Math.max(0, Math.min(snippet.length, index - start - lead))

  return {
    snippet,
    snippetStart,
    snippetLength: Math.min(length, snippet.length - snippetStart),
  }
}

/**
 * Fuzzy search across every tab of one notepad: titles and bodies.
 * Runs entirely against the local Yjs replica, so it is private and offline.
 */
export function searchNotepad(
  tabs: TabMeta[],
  readText: (tabId: string) => string,
  rawQuery: string,
  limit = 20,
): SearchHit[] {
  const tokens = rawQuery
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)

  if (tokens.length === 0) return []
  const phrase = tokens.join(' ')

  const hits: SearchHit[] = []

  for (const tab of tabs) {
    const text = readText(tab.id)
    const body = matchAll(text, tokens, phrase)
    const title = matchAll(tab.title, tokens, phrase)

    if (!body && !title) continue

    let hit: SearchHit
    if (body) {
      hit = {
        tabId: tab.id,
        tabTitle: tab.title,
        score: body.score,
        offset: body.index,
        length: body.length,
        ...snippetAround(text, body.index, body.length),
      }
    } else {
      // Title-only hit: opening it just switches tabs.
      hit = {
        tabId: tab.id,
        tabTitle: tab.title,
        score: (title?.score ?? 0) + 25,
        offset: 0,
        length: 0,
        snippet: text.slice(0, 120).replace(/\n/g, ' ').trim(),
        snippetStart: 0,
        snippetLength: 0,
      }
    }

    const firstToken = tokens[0]
    if (firstToken && tab.title.toLowerCase().includes(firstToken)) {
      hit.score += 15
    }

    hits.push(hit)
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}
