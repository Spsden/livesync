import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { searchNotepad, type SearchHit } from '../search'
import type { TabMeta } from '../types'

type Props = {
  open: boolean
  tabs: TabMeta[]
  readText: (tabId: string) => string
  onClose: () => void
  onOpenResult: (hit: SearchHit) => void
}

function Highlighted({ hit }: { hit: SearchHit }) {
  if (hit.snippetLength <= 0) return <>{hit.snippet}</>

  const end = hit.snippetStart + hit.snippetLength
  return (
    <>
      {hit.snippet.slice(0, hit.snippetStart)}
      <mark>{hit.snippet.slice(hit.snippetStart, end)}</mark>
      {hit.snippet.slice(end)}
    </>
  )
}

export function NotepadSearch({
  open,
  tabs,
  readText,
  onClose,
  onOpenResult,
}: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setSelected(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // Small debounce: typing scans every tab body, which is cheap but not free.
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      setHits(searchNotepad(tabs, readText, query))
      setSelected(0)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [open, query, tabs, readText])

  if (!open) return null

  const tabCount = new Set(hits.map((hit) => hit.tabId)).size

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, Math.max(0, hits.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(0, current - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[selected]
      if (hit) onOpenResult(hit)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="search-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="search-panel" role="dialog" aria-label="Search this notepad">
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          placeholder="Search this notepad — titles and text, typos ok"
          aria-label="Search this notepad"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="search-meta">
          {query.trim()
            ? hits.length > 0
              ? `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${tabCount} tab${tabCount === 1 ? '' : 's'}`
              : 'no matches'
            : `${tabs.length} tab${tabs.length === 1 ? '' : 's'} in this notepad`}
        </div>

        {hits.length > 0 && (
          <ul className="search-results">
            {hits.map((hit, index) => (
              <li key={hit.tabId}>
                <button
                  type="button"
                  className={`search-hit${index === selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => onOpenResult(hit)}
                >
                  <span className="search-tab">{hit.tabTitle || 'untitled'}</span>
                  <span className="search-snippet">
                    <Highlighted hit={hit} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {query.trim() !== '' && hits.length === 0 && (
          <p className="search-empty">
            Nothing in this notepad matches. Try fewer words.
          </p>
        )}
      </div>
    </div>
  )
}
