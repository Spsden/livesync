import { useEffect, useState } from 'react'
import type * as Y from 'yjs'

export type NotepadMeta = {
  name: string
  listed: boolean
}

const META_MAP = 'meta'

export function cleanName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ').slice(0, 80)
  return trimmed || 'untitled'
}

export function readMeta(doc: Y.Doc): NotepadMeta {
  const meta = doc.getMap(META_MAP)
  const raw = meta.get('name')
  return {
    name: cleanName(typeof raw === 'string' ? raw : ''),
    listed: meta.get('listed') === true,
  }
}

/** The notepad's name and directory visibility, kept in the shared document. */
export function useNotepadMeta(doc: Y.Doc): NotepadMeta {
  const [value, setValue] = useState(() => readMeta(doc))

  useEffect(() => {
    const meta = doc.getMap(META_MAP)
    const update = () => setValue(readMeta(doc))
    meta.observe(update)
    update()
    return () => meta.unobserve(update)
  }, [doc])

  return value
}

export function setNotepadName(doc: Y.Doc, name: string): void {
  doc.getMap(META_MAP).set('name', cleanName(name))
}

export function setNotepadListed(doc: Y.Doc, listed: boolean): void {
  doc.getMap(META_MAP).set('listed', listed)
}
