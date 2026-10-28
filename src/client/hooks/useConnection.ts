import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { BASE_PATH } from '../base'
import { NAME_KEY } from '../constants'
import { pickColor, randomName } from '../ui'

export type Connection = {
  doc: Y.Doc
  provider: WebsocketProvider
}

/**
 * Owns the Y.Doc + websocket for one room.
 *
 * Created inside an effect rather than useMemo: under StrictMode React mounts,
 * unmounts and remounts, and a useMemo-created provider would leak the first
 * socket because its cleanup belongs to the surviving render.
 */
export function useConnection(room: string): Connection | null {
  const [connection, setConnection] = useState<Connection | null>(null)

  useEffect(() => {
    const doc = new Y.Doc()
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const provider = new WebsocketProvider(
      `${protocol}//${window.location.host}${BASE_PATH}/ws`,
      room,
      doc,
    )

    const name = localStorage.getItem(NAME_KEY) || randomName()
    provider.awareness.setLocalStateField('user', {
      name,
      color: pickColor(name),
    })

    setConnection({ doc, provider })

    return () => {
      provider.destroy()
      doc.destroy()
      setConnection(null)
    }
  }, [room])

  return connection
}
