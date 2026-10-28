import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'

import { Editor } from './Editor'
import { ConfirmDialog } from './ConfirmDialog'
import { FilesPanel } from './FilesPanel'
import { TabBar } from './TabBar'
import { Toast } from './Toast'
import { TopBar } from './TopBar'
import { FILES_OPEN_KEY, NAME_KEY, NOTICE_KEY } from '../constants'
import { deleteRemoteFile, deleteRemoteNotepad } from '../files-api'
import { usePresenceUsers } from '../hooks/usePresenceUsers'
import { useProviderStatus } from '../hooks/useProviderStatus'
import { useUploader } from '../hooks/useUploader'
import { useYArray } from '../hooks/useYArray'
import { pickColor, uid } from '../ui'
import type { FileMeta, PresenceUser, TabMeta } from '../types'

type Props = {
  room: string
  doc: Y.Doc
  provider: WebsocketProvider
}

export function Notepad({ room, doc, provider }: Props) {
  const navigate = useNavigate()

  const tabs = useMemo(() => doc.getArray<TabMeta>('tabs'), [doc])
  const files = useMemo(() => doc.getArray<FileMeta>('files'), [doc])
  const tabList = useYArray(tabs)
  const fileList = useYArray(files)
  const users = usePresenceUsers(provider.awareness)
  const status = useProviderStatus(provider)

  /** Undo is per tab; one shared stack would let a tab undo another's edits. */
  const undoManagers = useRef(new Map<string, Y.UndoManager>())

  const [activeId, setActiveId] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useState(
    () => localStorage.getItem(FILES_OPEN_KEY) === 'true',
  )
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [gone, setGone] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const notify = useCallback((message: string) => {
    setToast({ id: Date.now(), message })
  }, [])

  const { pending, upload } = useUploader(room, files, notify)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const managers = undoManagers.current
    return () => {
      for (const manager of managers.values()) manager.destroy()
      managers.clear()
    }
  }, [])

  useEffect(() => {
    // 4404 means the server decided this notepad no longer exists. y-websocket
    // stops reconnecting for 4400-4499, so we just need to say so.
    const onClosed = (event: { code: number }) => {
      if (event.code === 4404) setGone(true)
    }
    provider.on('closed', onClosed)
    return () => provider.off('closed', onClosed)
  }, [provider])

  useEffect(() => {
    const notice = sessionStorage.getItem(NOTICE_KEY)
    if (!notice) return
    sessionStorage.removeItem(NOTICE_KEY)
    notify(notice)
  }, [notify])

  // ------------------------------------------------------------- bootstrap ---

  useEffect(() => {
    let settled = false
    const run = () => {
      if (settled) return
      settled = true
      const items = tabs.toArray()
      if (items.length === 0) {
        const id = uid(6)
        doc.transact(() => {
          tabs.push([{ id, title: 'untitled' }])
        })
        setActiveId(id)
      } else {
        setActiveId((current) => current ?? items[0]?.id ?? null)
      }
    }

    if (provider.synced) {
      run()
      return
    }

    provider.on('sync', run)
    // Offline first visit: let the person type instead of staring at nothing.
    // If the room turns out to be non-empty, Yjs merges on reconnect.
    const timer = window.setTimeout(run, 1500)
    return () => {
      provider.off('sync', run)
      window.clearTimeout(timer)
    }
  }, [doc, provider, tabs])

  // Keep the selection valid when someone else closes the open tab.
  useEffect(() => {
    if (tabList.length === 0) {
      setActiveId(null)
      return
    }
    setActiveId((current) =>
      current && tabList.some((tab) => tab.id === current)
        ? current
        : (tabList[0]?.id ?? null),
    )
  }, [tabList])

  // ------------------------------------------------------------ tab edits ---

  const createTab = () => {
    const id = uid(6)
    doc.transact(() => {
      tabs.push([{ id, title: 'untitled' }])
    })
    setActiveId(id)
  }

  const renameTab = (id: string, title: string) => {
    const items = tabs.toArray()
    const index = items.findIndex((tab) => tab.id === id)
    const current = items[index]
    if (!current || current.title === title) return
    doc.transact(() => {
      tabs.delete(index, 1)
      tabs.insert(index, [{ ...current, title }])
    })
  }

  const reorderTabs = (fromId: string, beforeId: string) => {
    const items = tabs.toArray()
    const from = items.findIndex((tab) => tab.id === fromId)
    if (from === -1) return
    const [moved] = items.splice(from, 1)
    if (!moved) return
    const target = items.findIndex((tab) => tab.id === beforeId)
    items.splice(target === -1 ? items.length : target, 0, moved)
    doc.transact(() => {
      tabs.delete(0, tabs.length)
      tabs.insert(0, items)
    })
  }

  const closeTab = (id: string) => {
    if (tabs.length <= 1) {
      notify('Keep at least one tab')
      return
    }
    const text = doc.getText(`tab:${id}`)
    if (text.length > 0 && !window.confirm('Delete this tab and its contents?')) {
      return
    }
    const index = tabs.toArray().findIndex((tab) => tab.id === id)
    if (index === -1) return
    doc.transact(() => {
      tabs.delete(index, 1)
      // Delete the text too, so the stored document actually shrinks.
      text.delete(0, text.length)
    })
    undoManagers.current.get(id)?.destroy()
    undoManagers.current.delete(id)
  }

  const undoManagerFor = (id: string): Y.UndoManager => {
    const managers = undoManagers.current
    let manager = managers.get(id)
    if (!manager) {
      manager = new Y.UndoManager(doc.getText(`tab:${id}`))
      managers.set(id, manager)
    }
    return manager
  }

  // ------------------------------------------------------------- top bar ----

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify('Link copied')
    } catch {
      window.prompt('Copy this link', window.location.href)
    }
  }

  const startNew = () => {
    void navigate({ to: '/' })
  }

  const toggleFiles = () => {
    setFilesOpen((open) => {
      localStorage.setItem(FILES_OPEN_KEY, String(!open))
      return !open
    })
  }

  const renameSelf = () => {
    const local = provider.awareness.getLocalState() as
      | { user?: PresenceUser }
      | null
    const current = local?.user?.name ?? ''
    const next = window.prompt('Your name', current)
    if (next === null) return
    const name = next.trim().slice(0, 32) || current
    localStorage.setItem(NAME_KEY, name)
    provider.awareness.setLocalStateField('user', { name, color: pickColor(name) })
  }

  // -------------------------------------------------------------- deleting ---

  const removeFile = async (file: FileMeta) => {
    if (!window.confirm(`Delete "${file.name}" for everyone?`)) return
    try {
      // Server first: if this succeeds but the Yjs removal doesn't reach peers,
      // they see a dead link (recoverable). The reverse order would leave an
      // unreachable blob with no row — invisible to GC forever.
      await deleteRemoteFile(room, file.id)
      const index = files.toArray().findIndex((entry) => entry.id === file.id)
      if (index !== -1) {
        doc.transact(() => files.delete(index, 1))
      }
      notify('File deleted')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Delete failed.')
    }
  }

  const removeNotepad = async () => {
    setDeleting(true)
    try {
      await deleteRemoteNotepad(room)
      sessionStorage.setItem(NOTICE_KEY, 'Notepad deleted')
      void navigate({ to: '/' })
    } catch (error) {
      setDeleting(false)
      setConfirmDelete(false)
      notify(error instanceof Error ? error.message : 'Delete failed.')
    }
  }

  // ------------------------------------------------------- drop and paste ---

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const dropped = event.dataTransfer?.files
      if (dropped?.length) upload([...dropped])
    }
    const onPaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.files
      if (!pasted?.length) return
      // Only hijack the paste when it carries files; text goes to the editor.
      event.preventDefault()
      upload([...pasted])
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [upload])

  const activeTab = activeId
    ? (tabList.find((tab) => tab.id === activeId) ?? null)
    : null

  if (gone) {
    return (
      <div className="gone-state">
        <h1 className="gone-title">This notepad was deleted</h1>
        <p className="gone-body">
          Someone with the link removed it, along with its tabs and files.
        </p>
        <button type="button" className="btn-primary" onClick={startNew}>
          Start a new notepad
        </button>
      </div>
    )
  }

  return (
    <div className={`shell${dragging ? ' is-dragging' : ''}`}>
      <TopBar
        room={room}
        users={users}
        status={status}
        filesCount={fileList.length}
        filesOpen={filesOpen}
        onCopy={() => void copyLink()}
        onNew={startNew}
        onToggleFiles={toggleFiles}
        onRenameSelf={renameSelf}
        onDeleteNotepad={() => setConfirmDelete(true)}
      />

      <TabBar
        tabs={tabList}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={createTab}
        onRename={renameTab}
        onClose={closeTab}
        onReorder={reorderTabs}
      />

      <div className="workspace">
        {activeTab ? (
          <Editor
            key={activeTab.id}
            ytext={doc.getText(`tab:${activeTab.id}`)}
            awareness={provider.awareness}
            undoManager={undoManagerFor(activeTab.id)}
          />
        ) : (
          <div className="editor-host">
            <div className="empty-state">
              <p className="empty-title">No tabs here</p>
              <p className="empty-sub">Create one and start dumping.</p>
              <button type="button" className="btn-primary" onClick={createTab}>
                New tab
              </button>
            </div>
          </div>
        )}

        <FilesPanel
          open={filesOpen}
          files={fileList}
          pending={pending}
          onPick={upload}
          onDelete={(file) => void removeFile(file)}
        />
      </div>

      <Toast message={toast?.message ?? null} />
      <div className="drop-overlay">Drop to add files</div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this notepad?"
        body="Every tab and every uploaded file is removed for everyone. This cannot be undone."
        confirmLabel="Delete notepad"
        busy={deleting}
        requireTyped="delete"
        onConfirm={() => void removeNotepad()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
