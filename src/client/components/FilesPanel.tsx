import { useRef } from 'react'
import { withBase } from '../base'
import type { PendingUpload } from '../hooks/useUploader'
import type { FileMeta } from '../types'
import { formatBytes } from '../ui'

type Props = {
  open: boolean
  files: FileMeta[]
  pending: PendingUpload[]
  onPick: (files: File[]) => void
  onDelete: (file: FileMeta) => void
}

export function FilesPanel({ open, files, pending, onPick, onDelete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const newestFirst = [...files].reverse()

  return (
    <aside className={`files-panel${open ? ' is-open' : ''}`}>
      <div className="panel-head">
        <span className="panel-title">Files</span>
        <span className="panel-count">{files.length}</span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => inputRef.current?.click()}
        >
          Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = event.target.files
            if (picked) onPick([...picked])
            event.target.value = ''
          }}
        />
      </div>

      <ul className="file-list">
        {pending.map((item) => (
          <li key={item.key} className="file-item is-pending">
            <div className="file-row">
              <span className="file-name">{item.name}</span>
            </div>
            <span className="file-meta">{item.percent}%</span>
          </li>
        ))}

        {newestFirst.map((file) => (
          <li key={file.id} className="file-item">
            <div className="file-row">
              <a
                className="file-name"
                href={withBase(`/api/files/${encodeURIComponent(file.id)}`)}
                download={file.name}
                title={file.name}
                rel="noopener"
              >
                {file.name}
              </a>
              <button
                type="button"
                className="file-delete"
                title="Delete file for everyone"
                aria-label={`Delete ${file.name}`}
                onClick={() => onDelete(file)}
              >
                ×
              </button>
            </div>
            <span className="file-meta">{formatBytes(file.size)}</span>
          </li>
        ))}

        {newestFirst.length === 0 && pending.length === 0 && (
          <li className="file-empty">Nothing here yet.</li>
        )}
      </ul>

      <p className="panel-hint">Drop or paste files anywhere in the notepad.</p>
    </aside>
  )
}
