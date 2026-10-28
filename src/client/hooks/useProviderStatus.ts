import { useEffect, useState } from 'react'
import type { WebsocketProvider } from 'y-websocket'

export function useProviderStatus(provider: WebsocketProvider): string {
  const [status, setStatus] = useState(() =>
    provider.wsconnected ? 'connected' : 'connecting',
  )

  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => setStatus(status)
    const onSync = (isSynced: boolean) => {
      if (isSynced) setStatus('connected')
    }
    provider.on('status', onStatus)
    provider.on('sync', onSync)
    return () => {
      provider.off('status', onStatus)
      provider.off('sync', onSync)
    }
  }, [provider])

  return status
}
