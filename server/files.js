import { Router } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, isValidRoom } from './config.js'
import { insertFile, getFile, deleteFileRecord } from './db.js'

export const filesDir = path.join(config.dataDir, 'files')

export async function initFiles() {
  await fsp.mkdir(filesDir, { recursive: true })
}

const blobPath = (id) => path.join(filesDir, id)

/** Unlink blobs by id. Missing files are fine; GC would collect them anyway. */
export async function removeBlobs(ids) {
  let removed = 0
  for (const id of ids) {
    try {
      await fsp.rm(blobPath(id), { force: true })
      removed += 1
    } catch (err) {
      console.error(`[files] could not unlink ${id}:`, err)
    }
  }
  return removed
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes, files: 1 },
})

export const filesRouter = Router()

filesRouter.post('/rooms/:room/files', (req, res, next) => {
  const { room } = req.params
  if (!isValidRoom(room)) return res.status(400).json({ error: 'bad room' })

  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `file too large (limit ${Math.round(config.maxFileBytes / 1024 / 1024)}MB)`,
        })
      }
      return res.status(400).json({ error: 'upload failed' })
    }
    next()
  })
}, async (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'no file field' })

  const { room } = req.params
  const id = randomUUID()
  const name = sanitizeName(file.originalname)
  const mime = file.mimetype || 'application/octet-stream'

  // The on-disk name is a uuid we generated. The user-supplied name never
  // touches the path, so traversal and collision are both impossible.
  try {
    await fsp.writeFile(path.join(filesDir, id), file.buffer)
  } catch (err) {
    console.error('[files] write failed:', err)
    return res.status(500).json({ error: 'could not store file' })
  }

  const meta = { id, room, name, mime, size: file.size }
  try {
    await insertFile(meta)
  } catch (err) {
    await fsp.rm(path.join(filesDir, id), { force: true })
    console.error('[files] row failed:', err)
    return res.status(500).json({ error: 'could not record file' })
  }

  res.json({ id, name, mime, size: file.size, url: `/api/files/${id}` })
})

filesRouter.delete('/rooms/:room/files/:id', async (req, res) => {
  const { room, id } = req.params
  if (!isValidRoom(room)) return res.status(400).json({ error: 'bad room' })

  // Scoped by room on purpose: a blob id leaked from another notepad must not
  // be deletable from this one.
  const row = await deleteFileRecord(room, id)
  if (!row) return res.status(404).json({ error: 'not found' })

  await removeBlobs([row.id])
  res.json({ ok: true, id: row.id })
})

filesRouter.get('/files/:id', async (req, res) => {
  const row = await getFile(req.params.id)
  if (!row) return res.status(404).json({ error: 'not found' })

  const diskPath = path.join(filesDir, row.id)
  try {
    await fsp.access(diskPath, fs.constants.R_OK)
  } catch {
    console.error(`[files] row ${row.id} has no file on disk`)
    return res.status(404).json({ error: 'not found' })
  }

  res.setHeader('Content-Type', row.mime)
  res.setHeader('Content-Disposition', contentDisposition(row.name))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Ids are uuids and content is never rewritten, so caching is safe.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  fs.createReadStream(diskPath).pipe(res)
})

function sanitizeName(name) {
  const base = path.basename(name || 'file')
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || 'file').slice(0, 200)
}

function contentDisposition(name) {
  const ascii = name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
