import { BASE_PATH } from '../base'
import type { PresenceUser } from '../types'
import { initials } from '../ui'

type Props = {
  room: string
  users: PresenceUser[]
  status: string
  filesCount: number
  filesOpen: boolean
  onCopy: () => void
  onNew: () => void
  onToggleFiles: () => void
  onRenameSelf: () => void
  onDeleteNotepad: () => void
}

export function TopBar({
  room,
  users,
  status,
  filesCount,
  filesOpen,
  onCopy,
  onNew,
  onToggleFiles,
  onRenameSelf,
  onDeleteNotepad,
}: Props) {
  const visible = users.slice(0, 5)

  return (
    <header className="topbar">
      <a className="brand" href={`${BASE_PATH}/`} title="Start a new notepad">
        live-sync
      </a>

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
