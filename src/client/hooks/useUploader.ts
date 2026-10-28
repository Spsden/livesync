import { useCallback, useState } from 'react'
import type * as Y from 'yjs'
import { uploadFile } from '../files-api'
import type { FileMeta } from '../types'

export type PendingUpload = {
  key: string
  name: string
  percent: number
}

export function useUploader(
  room: string,
  files: Y.Array<FileMeta>,
  onError: (message: string) => void,
) {
  const [pending, setPending] = useState<PendingUpload[]>([])

  const upload = useCallback(
    (batch: File[]) => {
      for (const file of batch) {
        const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`
        setPending((current) => [...current, { key, name: file.name, percent: 0 }])

        uploadFile(room, file, (percent) => {
          setPending((current) =>
            current.map((item) => (item.key === key ? { ...item, percent } : item)),
          )
        })
          .then((stored) => {
            // Publishing the metadata into Yjs is what makes the file show up
            // for everyone else, over the same socket as the text.
            files.push([
              {
                id: stored.id,
                name: stored.name,
                mime: stored.mime,
                size: stored.size,
              },
            ])
          })
          .catch((error: unknown) => {
            onError(
              error instanceof Error ? error.message : 'Upload failed.',
            )
          })
          .finally(() => {
            setPending((current) => current.filter((item) => item.key !== key))
          })
      }
    },
    [room, files, onError],
  )

  return { pending, upload }
}
