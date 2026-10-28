import { useEffect, useState } from 'react'
import type * as Y from 'yjs'

/** Subscribe a React component to a Y.Array without pulling in a binding lib. */
export function useYArray<T>(array: Y.Array<T>): T[] {
  const [items, setItems] = useState<T[]>(() => array.toArray())

  useEffect(() => {
    const update = () => setItems(array.toArray())
    array.observe(update)
    update()
    return () => array.unobserve(update)
  }, [array])

  return items
}
