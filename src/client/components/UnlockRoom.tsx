import { useState, type FormEvent } from 'react'
import { unlockRoom } from '../access'
import { BASE_PATH } from '../base'

type Props = {
  room: string
  onUnlocked: () => void
}

export function UnlockRoom({ room, onUnlocked }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!pin || busy) return

    setBusy(true)
    setError('')
    const result = await unlockRoom(room, pin)
    if (result.ok) {
      onUnlocked()
      return
    }
    setError(result.error ?? 'wrong password')
    setBusy(false)
  }

  return (
    <main className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <p className="unlock-brand">live-sync</p>
        <h1 className="unlock-title">This notepad is locked</h1>
        <p className="unlock-body">
          Enter the password you were given for <code>/n/{room}</code>.
        </p>

        <input
          className="unlock-input"
          type="password"
          value={pin}
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Notepad password"
          onChange={(event) => setPin(event.target.value)}
        />

        {error && <p className="unlock-error">{error}</p>}

        <button
          type="submit"
          className="btn-primary"
          disabled={busy || pin.length === 0}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>

        <a className="unlock-home" href={`${BASE_PATH}/`}>
          Back to home
        </a>
      </form>
    </main>
  )
}
