import { useEffect, useState, type FormEvent } from 'react'
import { createNotepad } from '../access'

type Props = {
  open: boolean
  onClose: () => void
  onCreated: (room: string) => void
}

export function CreateNotepad({ open, onClose, onCreated }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setPin('')
    setError('')
    setBusy(false)
  }, [open])

  if (!open) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (pin.length > 0 && pin.length < 6) {
      setError('Use at least 6 characters, or leave it empty.')
      return
    }

    setBusy(true)
    setError('')
    try {
      const created = await createNotepad(pin || undefined)
      onCreated(created.room)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the notepad.')
      setBusy(false)
    }
  }

  return (
    <div
      className="search-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form className="search-panel create-panel" onSubmit={submit}>
        <h2 className="create-title">New notepad</h2>
        <p className="create-body">
          A password keeps the notepad private and is required before it can be
          listed in the public directory. Leave it empty to share by link only.
        </p>

        <label className="create-field">
          <span>Password (optional)</span>
          <input
            type="password"
            value={pin}
            autoFocus
            autoComplete="new-password"
            placeholder="At least 6 characters"
            onChange={(event) => setPin(event.target.value)}
          />
        </label>

        {error && <p className="unlock-error">{error}</p>}

        <div className="create-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create notepad'}
          </button>
        </div>
      </form>
    </div>
  )
}
