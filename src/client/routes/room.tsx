import { getRouteApi } from '@tanstack/react-router'
import { Notepad } from '../components/Notepad'
import { useConnection } from '../hooks/useConnection'

const route = getRouteApi('/n/$roomId')

export function RoomPage() {
  const { roomId } = route.useParams()
  const connection = useConnection(roomId)

  if (!connection) {
    return <div className="app-loading">Opening notepad…</div>
  }

  return (
    <Notepad
      key={roomId}
      room={roomId}
      doc={connection.doc}
      provider={connection.provider}
    />
  )
}
