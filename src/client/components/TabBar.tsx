import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { deriveTitle, hasManualTitle } from '../tab-title'
import type { TabMeta } from '../types'

type Props = {
  doc: Y.Doc
  tabs: TabMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, title: string) => void
  onClose: (id: string) => void
  onReorder: (fromId: string, beforeId: string) => void
}

type Editing = { id: string; draft: string }

function TabLabel({ tab, doc }: { tab: TabMeta; doc: Y.Doc }) {
  const manual = hasManualTitle(tab)
  const [derived, setDerived] = useState(() =>
    deriveTitle(doc.getText(`tab:${tab.id}`).toString()),
  )

  useEffect(() => {
    if (manual) return
    const ytext = doc.getText(`tab:${tab.id}`)

    let timer: number | undefined
    const update = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setDerived(deriveTitle(ytext.toString()))
      }, 250)
    }

    ytext.observe(update)
    update()
    return () => {
      window.clearTimeout(timer)
      ytext.unobserve(update)
    }
  }, [doc, tab.id, manual])

  return <span className="tab-title">{manual ? tab.title : derived}</span>
}

export function TabBar({
  doc,
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
            onDoubleClick={() =>
              setEditing({
                id: tab.id,
                draft: hasManualTitle(tab)
                  ? tab.title
                  : deriveTitle(doc.getText(`tab:${tab.id}`).toString()),
              })
            }
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
              <TabLabel tab={tab} doc={doc} />
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
