import { withBase } from './base'
import type { FileMeta } from './types'

/**
 * Uploads one file and reports progress. XHR rather than fetch: fetch has no
 * upload progress events, and a large dump with no feedback feels broken.
 */
export function uploadFile(
  room: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<FileMeta> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', withBase(`/api/rooms/${encodeURIComponent(room)}/files`))

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return
      onProgress?.(Math.round((event.loaded / event.total) * 100))
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as FileMeta)
        } catch {
          reject(new Error('Upload returned an unreadable response.'))
        }
        return
      }
      reject(
        new Error(
          xhr.status === 413
            ? 'That file is bigger than the limit for this notepad.'
            : `Upload failed (${xhr.status}).`,
        ),
      )
    })

    xhr.addEventListener('error', () =>
      reject(new Error('Upload failed — network error.')),
    )

    xhr.send(form)
  })
}

/** 404 is treated as success: the goal is "this file is gone", not a receipt. */
export async function deleteRemoteFile(room: string, id: string): Promise<void> {
  const response = await fetch(
    withBase(`/api/rooms/${encodeURIComponent(room)}/files/${encodeURIComponent(id)}`),
    { method: 'DELETE' },
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete failed (${response.status}).`)
  }
}

export async function deleteRemoteNotepad(room: string): Promise<void> {
  const response = await fetch(withBase(`/api/rooms/${encodeURIComponent(room)}`), {
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new Error(`Delete failed (${response.status}).`)
  }
}
