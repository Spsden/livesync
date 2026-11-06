import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { withBase } from '../base'
import { CreateNotepad } from '../components/CreateNotepad'
import { readRecents, type RecentRoom } from '../recents'
import { timeAgo } from '../ui'

type DirectoryRoom = {
  room: string
  name: string
  updatedAt: string
  locked: boolean
}

function LockIcon() {
  return (
    <svg
      className="room-lock"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="3.5"
        y="7"
        width="9"
        height="6.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [rooms, setRooms] = useState<DirectoryRoom[]>([])
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading')
  const [creating, setCreating] = useState(false)
  const [recents] = useState<RecentRoom[]>(() => readRecents())

  useEffect(() => {
    document.title = 'live-sync'
  }, [])

  // Debounced because every keystroke would otherwise hit Postgres.
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(
      async () => {
        setStatus('loading')
        try {
          const response = await fetch(
            withBase(`/api/rooms?q=${encodeURIComponent(query.trim())}`),
            { signal: controller.signal },
          )
          if (!response.ok) throw new Error(String(response.status))
          const data = (await response.json()) as { rooms: DirectoryRoom[] }
          setRooms(data.rooms)
          setStatus('idle')
        } catch {
          if (controller.signal.aborted) return
          setRooms([])
          setStatus('error')
        }
      },
      query.trim() ? 250 : 0,
    )

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  return (
    <main className="home">
      <div className="home-inner">
        <p className="home-brand">live-sync</p>

        <h1 className="home-title">A notepad you share with a link.</h1>
        <p className="home-lede">
          No accounts. Type together in real time, keep separate tabs, and drop
          files in. Everyone holding the link sees the same thing.
        </p>

        <button
          type="button"
          className="btn-primary home-cta"
          onClick={() => setCreating(true)}
        >
          Create a notepad
        </button>

        <ol className="home-steps">
          <li>
            <strong>Write or paste</strong> anything. It saves itself.
          </li>
          <li>
            <strong>Send the link.</strong> Edits appear live for everyone.
          </li>
          <li>
            <strong>Drop files</strong> to attach them to the notepad.
          </li>
        </ol>

        {recents.length > 0 && (
          <section className="home-section">
            <h2 className="home-h2">Recent</h2>
            <ul className="room-list">
              {recents.map((entry) => (
                <li key={entry.room}>
                  <Link
                    className="room-row"
                    to="/n/$roomId"
                    params={{ roomId: entry.room }}
                  >
                    <span className="room-name">{entry.name}</span>
                    <span className="room-id">/n/{entry.room}</span>
                    <span className="room-when">
                      {timeAgo(new Date(entry.at).toISOString())}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="home-section">
          <div className="home-section-head">
            <h2 className="home-h2">Public notepads</h2>
            <input
              className="home-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or id"
              aria-label="Search public notepads"
              spellCheck={false}
            />
          </div>

          {status === 'error' ? (
            <p className="home-note">The directory is unavailable right now.</p>
          ) : rooms.length > 0 ? (
            <ul className="room-list">
              {rooms.map((entry) => (
                <li key={entry.room}>
                  <Link
                    className="room-row"
                    to="/n/$roomId"
                    params={{ roomId: entry.room }}
                    title="Password required"
                  >
                    {entry.locked && <LockIcon />}
                    <span className="room-name">{entry.name}</span>
                    <span className="room-id">/n/{entry.room}</span>
                    <span className="room-when">{timeAgo(entry.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : status === 'loading' ? (
            <p className="home-note">Searching…</p>
          ) : (
            <p className="home-note">
              {query.trim()
                ? 'No listed notepad matches that.'
                : 'Nothing is listed yet. Notepads appear here only if they were created with a password and set to “Listed”.'}
            </p>
          )}
        </section>

        <p className="home-foot">
          Already have a link? Just open it. Public notepads always require their
          password.
        </p>
      </div>

      <CreateNotepad
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(room) => {
          void navigate({ to: '/n/$roomId', params: { roomId: room } })
        }}
      />
    </main>
  )
}
