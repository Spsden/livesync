import { useEffect, useRef } from 'react'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { createEditor } from '../editor'

type Props = {
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
}

/**
 * React owns only the host element; CodeMirror owns everything inside it. The
 * component is keyed by tab id upstream, so switching tabs is a clean
 * destroy/rebuild rather than an in-place reconfiguration.
 */
export function Editor({ ytext, awareness, undoManager }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = createEditor(host, ytext, awareness, undoManager)
    view.focus()

    return () => view.destroy()
  }, [ytext, awareness, undoManager])

  return <div className="editor-host" ref={hostRef} />
}
