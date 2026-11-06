import { useEffect, useRef, useState } from 'react'
import { BASE_PATH } from '../base'
import type { PresenceUser } from '../types'
import { initials } from '../ui'

type Props = {
  room: string
  name: string
  listed: boolean
  users: PresenceUser[]
  status: string
  filesCount: number
  filesOpen: boolean
  onCopy: () => void
  onNew: () => void
  onToggleFiles: () => void
  onRenameSelf: () => void
  onDeleteNotepad: () => void
  onRename: (name: string) => void
  onToggleListed: () => void
  onSearch: () => void
  ready: boolean
  /** False when the notepad has no password, so it cannot be published. */
  canList: boolean
}

export function TopBar({
  room,
  name,
  listed,
  users,
  status,
  filesCount,
  filesOpen,
  onCopy,
  onNew,
  onToggleFiles,
  onRenameSelf,
  onDeleteNotepad,
  onRename,
  onToggleListed,
  onSearch,
  ready,
  canList,
}: Props) {
  const visible = users.slice(0, 5)
  const [draft, setDraft] = useState(name)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Remote renames and reconnects must not fight the local draft.
  useEffect(() => setDraft(name), [name])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const renameNotepad = () => {
    const next = window.prompt('Notepad name', name)
    if (next === null) return
    const clean = next.trim()
    if (clean && clean !== name) onRename(clean)
  }

  const commit = () => {
    const next = draft.trim()
    if (next && next !== name) onRename(next)
    else setDraft(name)
  }

  return (
    <header className="topbar">
      <a className="brand" href={`${BASE_PATH}/`} title="Back to the home page">
        live-sync
      </a>

      <input
        className="notepad-name"
        value={draft}
        maxLength={80}
        spellCheck={false}
        aria-label="Notepad name"
        placeholder={ready ? 'Untitled notepad' : 'Loading…'}
        disabled={!ready}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(name)
            event.currentTarget.blur()
          }
        }}
      />

      <button
        type="button"
        className="btn-ghost icon-btn"
        onClick={onSearch}
        title="Search this notepad (Ctrl/⌘ F)"
        aria-label="Search this notepad"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M10.5 10.5 14 14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <button
        type="button"
        className={`btn-ghost listed-toggle${listed ? ' is-on' : ''}`}
        aria-pressed={listed}
        disabled={!ready || !canList}
        title={
          !canList
            ? 'Create a notepad with a password to publish it'
            : listed
              ? 'Listed in the public directory — click to unlist'
              : 'Add this notepad to the public directory'
        }
        onClick={onToggleListed}
      >
        {listed ? 'Listed' : 'Unlisted'}
      </button>

      <button
        type="button"
        className="room-pill"
        title="Copy link to this notepad"
        onClick={onCopy}
      >
        <span className="room-id">/n/{room}</span>
      </button>

      <div className="spacer" />

      <div
        className="presence"
        role="button"
        tabIndex={0}
        title="Click to change your name"
        onClick={onRenameSelf}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onRenameSelf()
          }
        }}
      >
        {visible.map((user, index) => (
          <span
            key={`${user.name}-${index}`}
            className="avatar"
            style={{ background: user.color }}
            title={user.name}
          >
            {initials(user.name)}
          </span>
        ))}
        {users.length > visible.length && (
          <span className="avatar is-more">+{users.length - visible.length}</span>
        )}
        {users.length === 0 && <span className="presence-empty">offline</span>}
      </div>

      <span className="conn" data-state={status} title={status} aria-hidden="true" />

      <button type="button" className="btn-ghost" onClick={onNew} title="New notepad">
        New
      </button>

      <button
        type="button"
        className="btn-ghost"
        onClick={onToggleFiles}
        title="Show files"
        aria-pressed={filesOpen}
      >
        Files{filesCount > 0 ? ` (${filesCount})` : ''}
      </button>

      <button
        type="button"
        className="btn-ghost is-danger"
        onClick={onDeleteNotepad}
        title="Delete this notepad and all its files"
      >
        Delete
      </button>

      <div className="mobile-menu" ref={menuRef}>
        <button
          type="button"
          className="btn-ghost icon-btn"
          aria-label="More actions"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>

        {menuOpen && (
          <div className="mobile-menu-panel" role="menu">
            <p className="mobile-menu-title">{name}</p>
            <button
              type="button"
              disabled={!ready}
              onClick={() => {
                setMenuOpen(false)
                renameNotepad()
              }}
            >
              Rename notepad
            </button>
            <button
              type="button"
              disabled={!ready || !canList}
              onClick={() => {
                setMenuOpen(false)
                onToggleListed()
              }}
            >
              {listed ? 'Remove from directory' : 'List in directory'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onToggleFiles()
              }}
            >
              Files{filesCount > 0 ? ` (${filesCount})` : ''}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onNew()
              }}
            >
              New notepad
            </button>
            <button
              type="button"
              className="is-danger"
              onClick={() => {
                setMenuOpen(false)
                onDeleteNotepad()
              }}
            >
              Delete notepad
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
