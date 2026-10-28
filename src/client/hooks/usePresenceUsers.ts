import { useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { PresenceUser } from '../types'

function readUsers(awareness: Awareness): PresenceUser[] {
  return [...awareness.getStates().values()]
    .map((state) => (state as { user?: PresenceUser }).user)
    .filter((user): user is PresenceUser => Boolean(user))
}

export function usePresenceUsers(awareness: Awareness): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>(() => readUsers(awareness))

  useEffect(() => {
    const update = () => setUsers(readUsers(awareness))
    awareness.on('change', update)
    update()
    return () => awareness.off('change', update)
  }, [awareness])

  return users
}
