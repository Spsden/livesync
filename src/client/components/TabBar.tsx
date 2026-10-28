import { useState } from 'react'
import type { TabMeta } from '../types'

type Props = {
  tabs: TabMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, title: string) => void
  onClose: (id: string) => void
  onReorder: (fromId: string, beforeId: string) => void
}

type Editing = { id: string; draft: string }

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onClose,
  onReorder,
}: Props) {
  const [editing, setEditing] = useState<Editing | null>(null)

  const commit = () => {
    if (!editing) return
    const title = editing.draft.trim().slice(0, 60)
    if (title) onRename(editing.id, title)
    setEditing(null)
  }

  return (
    <nav className="tabs" role="tablist" aria-label="Notepad tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        const isEditing = editing?.id === tab.id

        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            className={`tab${isActive ? ' is-active' : ''}`}
            draggable={!isEditing}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(tab.id)
              }
            }}
            onDoubleClick={() => setEditing({ id: tab.id, draft: tab.title })}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', tab.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const from = event.dataTransfer.getData('text/plain')
              if (from && from !== tab.id) onReorder(from, tab.id)
            }}
          >
            {isEditing ? (
              <input
                className="tab-rename"
                autoFocus
                value={editing.draft}
                aria-label="Tab name"
                onChange={(event) =>
                  setEditing({ id: tab.id, draft: event.target.value })
                }
                onClick={(event) => event.stopPropagation()}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commit()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(null)
                  }
                }}
              />
            ) : (
              <span className="tab-title">{tab.title.trim() || 'untitled'}</span>
            )}

            <button
              type="button"
              className="tab-close"
              title="Close tab"
              aria-label="Close tab"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}

      <button
        type="button"
        className="tab-add"
        title="New tab"
        aria-label="New tab"
        onClick={onAdd}
      >
        +
      </button>
    </nav>
  )
}
