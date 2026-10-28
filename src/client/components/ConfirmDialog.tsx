import { useEffect, useRef, useState } from 'react'

type Props = {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  busy?: boolean
  /** If set, the user must type this exact string before confirming. */
  requireTyped?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy = false,
  requireTyped,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const blocked = busy || (requireTyped ? typed.trim() !== requireTyped : false)

  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(event) => {
        // Escape: close via React state, not the browser's default.
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <h2 className="dialog-title">{title}</h2>
      <p className="dialog-body">{body}</p>

      {requireTyped && (
        <label className="dialog-field">
          <span>
            Type <code>{requireTyped}</code> to confirm
          </span>
          <input
            value={typed}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !blocked) onConfirm()
            }}
          />
        </label>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={onConfirm}
          disabled={blocked}
        >
          {busy ? 'Deleting…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
