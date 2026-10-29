import { useEffect, useState } from 'react'
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
  ready: boolean
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
  ready,
}: Props) {
  const visible = users.slice(0, 5)
  const [draft, setDraft] = useState(name)

  // Remote renames and reconnects must not fight the local draft.
  useEffect(() => setDraft(name), [name])

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
        className={`btn-ghost listed-toggle${listed ? ' is-on' : ''}`}
        aria-pressed={listed}
        disabled={!ready}
        title={
          listed
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
    </header>
  )
}
