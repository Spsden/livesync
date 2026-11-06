import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { createEditor } from '../editor'

type Reveal = { from: number; to: number }

type Props = {
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  reveal?: Reveal | null
  onRevealed?: () => void
}

/**
 * React owns only the host element; CodeMirror owns everything inside it. The
 * component is keyed by tab id upstream, so switching tabs is a clean
 * destroy/rebuild rather than an in-place reconfiguration.
 */
export function Editor({
  ytext,
  awareness,
  undoManager,
  reveal,
  onRevealed,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = createEditor(host, ytext, awareness, undoManager)
    viewRef.current = view
    view.focus()

    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [ytext, awareness, undoManager])

  // Select and centre a search hit. Declared after the create effect so the
  // view exists by the time this runs on a freshly mounted tab.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !reveal) return

    const limit = view.state.doc.length
    const from = Math.max(0, Math.min(reveal.from, limit))
    const to = Math.max(from, Math.min(reveal.to, limit))

    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    })
    view.focus()
    onRevealed?.()
  }, [reveal, onRevealed])

  return <div className="editor-host" ref={hostRef} />
}
