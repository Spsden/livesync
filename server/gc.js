import fsp from 'node:fs/promises'
import path from 'node:path'
import { allFileIds } from './db.js'
import { filesDir } from './files.js'

/**
 * Delete blobs that no row points at.
 *
 * Orphans are expected, not exceptional: a notepad delete removes rows first
 * and unlinks second, an unlink can fail, and an upload that dies after writing
 * the blob never inserts a row at all.
 *
 * The age guard is the important part — a blob that was just written may belong
 * to an upload whose row is still in flight, so young files are left alone.
 */
export async function collectOrphanBlobs({ minAgeMs = 60 * 60 * 1000 } = {}) {
  const known = await allFileIds()
  const entries = await fsp.readdir(filesDir).catch(() => [])

  let removed = 0
  let kept = 0

  for (const entry of entries) {
    if (known.has(entry)) continue

    const full = path.join(filesDir, entry)
    const stat = await fsp.stat(full).catch(() => null)
    if (!stat?.isFile()) continue

    if (Date.now() - stat.mtimeMs < minAgeMs) {
      kept += 1
      continue
    }

    try {
      await fsp.rm(full, { force: true })
      removed += 1
    } catch (err) {
      console.error(`[gc] could not remove ${entry}:`, err)
    }
  }

  return { removed, kept, known: known.size }
}
