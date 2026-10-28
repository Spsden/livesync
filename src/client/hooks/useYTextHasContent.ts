import { useEffect, useState } from 'react'
import type * as Y from 'yjs'

/**
 * Tracks whether a tab's text has anything in it, without subscribing the
 * component to the text itself. React only re-renders when the boolean flips,
 * so typing does not cause a render per keystroke upstream.
 */
export function useYTextHasContent(ytext: Y.Text | null): boolean {
  const [hasContent, setHasContent] = useState(() =>
    ytext ? ytext.length > 0 : false,
  )

  useEffect(() => {
    if (!ytext) {
      setHasContent(false)
      return
    }
    const update = () => setHasContent(ytext.length > 0)
    ytext.observe(update)
    update()
    return () => ytext.unobserve(update)
  }, [ytext])

  return hasContent
}
