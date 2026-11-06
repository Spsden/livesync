import { useEffect, useState } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import { fetchAccess, type RoomAccess } from '../access'
import { Notepad } from '../components/Notepad'
import { UnlockRoom } from '../components/UnlockRoom'
import { useConnection } from '../hooks/useConnection'

const route = getRouteApi('/n/$roomId')

export function RoomPage() {
  const { roomId } = route.useParams()

  // Keyed so a room change mounts a fresh tree. Without this the previous
  // room's access/connection leak into the first render of the new room, and
  // the notepad mounts (consuming one-shot state like the "deleted" notice)
  // only to be torn down again when the access check resolves.
  return <RoomPageInner key={roomId} roomId={roomId} />
}

function RoomPageInner({ roomId }: { roomId: string }) {
  const [access, setAccess] = useState<RoomAccess | null>(null)
  const [failed, setFailed] = useState(false)

  // Access is checked before the websocket is created: a locked notepad must
  // not mount the editor, or the bootstrap tab would create local content that
  // merges into the document once someone unlocks it.
  useEffect(() => {
    let cancelled = false

    fetchAccess(roomId)
      .then((next) => {
        if (!cancelled) setAccess(next)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [roomId])

  if (failed) {
    return <div className="app-loading">Could not open this notepad.</div>
  }

  if (!access) {
    return <div className="app-loading">Opening notepad…</div>
  }

  if (access.locked && !access.unlocked) {
    return (
      <UnlockRoom
        room={roomId}
        onUnlocked={() => setAccess({ ...access, unlocked: true })}
      />
    )
  }

  return <NotepadConnection room={roomId} locked={access.locked} />
}

function NotepadConnection({ room, locked }: { room: string; locked: boolean }) {
  const connection = useConnection(room)

  if (!connection) {
    return <div className="app-loading">Opening notepad…</div>
  }

  return (
    <Notepad
      key={room}
      room={room}
      doc={connection.doc}
      provider={connection.provider}
      locked={locked}
    />
  )
}
