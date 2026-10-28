import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'

import { config, isValidRoom } from './config.js'
import { migrate, pool, isRoomDeleted } from './db.js'
import { filesRouter, initFiles, removeBlobs } from './files.js'
import { collectOrphanBlobs } from './gc.js'
import {
  getRoom,
  deleteRoom,
  flushRoom,
  flushAll,
  sweepIdleRooms,
  roomCount,
  CLOSE_ROOM_DELETED,
} from './rooms.js'
import {
  readMessage,
  sendSyncStep1,
  sendAwarenessAll,
  dropConnection,
} from './sync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.resolve(here, '../dist/client')
const indexHtml = path.join(clientDir, 'index.html')

const app = express()
app.disable('x-powered-by')
app.use((req, res, next) => {
  // This is shareable-by-URL by design; do not leak rooms into search engines
  // or Referer headers on outbound links.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})

// Everything lives on one router so a single mount point controls the base
// path. The client is built with the same prefix (Vite `base`), so absolute
// URLs in the bundle already line up.
const router = express.Router()

router.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, rooms: roomCount() })
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err) })
  }
})

router.use('/api', filesRouter)

// Deleting a notepad is destructive and unauthenticated, exactly like editing
// it: possession of the URL is the whole permission model. The UI asks for a
// typed confirmation; the API deliberately does not pretend to be stronger.
router.delete('/api/rooms/:room', async (req, res) => {
  const { room } = req.params
  if (!isValidRoom(room)) return res.status(400).json({ error: 'bad room' })

  try {
    const blobIds = await deleteRoom(room)
    const blobsRemoved = await removeBlobs(blobIds)
    console.log(
      `[rooms] deleted ${room} (${blobIds.length} file(s), ${blobsRemoved} blob(s))`,
    )
    res.json({ ok: true, room, files: blobIds.length, blobsRemoved })
  } catch (err) {
    console.error(`[rooms] delete ${room} failed:`, err)
    res.status(500).json({ error: 'delete failed' })
  }
})

router.use('/api', (_req, res) =>
  res.status(404).json({ error: 'no such endpoint' }),
)

router.use(express.static(clientDir, { index: false, maxAge: '1h' }))

// Explicit routes instead of a wildcard: Express 5 changed path matching, and
// two literal routes are easier to reason about than a catch-all regex.
const sendApp = (_req, res) => res.sendFile(indexHtml)
router.get('/', sendApp)
router.get('/n/:room', sendApp)

app.use(config.basePath || '/', router)

if (config.basePath) {
  // Convenience for local runs: / sends you to the mounted app. Behind the
  // tunnel this path never reaches us — the portfolio owns the domain root.
  app.get('/', (_req, res) => res.redirect(302, `${config.basePath}/`))
}

const server = http.createServer(app)

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  let pathname = url.pathname

  // Strip the base path before matching, and refuse anything outside it so a
  // second app on the same tunnel cannot open notepads by accident.
  if (config.basePath) {
    if (pathname !== config.basePath && !pathname.startsWith(`${config.basePath}/`)) {
      socket.destroy()
      return
    }
    pathname = pathname.slice(config.basePath.length) || '/'
  }

  const match = pathname.match(/^\/ws\/([^/]+)\/?$/)
  const room = match?.[1]

  if (!room || !isValidRoom(room)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, room)
  })
})

wss.on('connection', async (ws, _req, roomName) => {
  const queued = []
  /** @type {any} */
  let room = null
  const controlledIds = new Set()

  ws.on('message', (data) => {
    // A fast client can send before the document finishes loading; hold those
    // frames rather than dropping them.
    if (!room) {
      queued.push(data)
      return
    }
    readMessage(ws, room, data, controlledIds)
  })

  ws.on('close', () => {
    if (!room) return
    dropConnection(room, ws, controlledIds)
    if (room.conns.size === 0) {
      flushRoom(room).catch((err) =>
        console.error(`[persist] final flush ${room.name}:`, err),
      )
    }
  })

  ws.on('error', () => ws.terminate())

  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })

  try {
    // Checked before getRoom: loading a tombstoned room would recreate it in
    // memory and let a stale client repopulate it.
    if (await isRoomDeleted(roomName)) {
      ws.close(CLOSE_ROOM_DELETED, 'notepad deleted')
      return
    }
    room = await getRoom(roomName)
  } catch (err) {
    console.error(`[ws] could not load room ${roomName}:`, err)
    ws.close(1011, 'could not load notepad')
    return
  }

  if (ws.readyState !== ws.OPEN) return

  room.conns.add(ws)
  room.lastActive = Date.now()
  sendSyncStep1(ws, room.doc)
  sendAwarenessAll(ws, room.awareness)
  for (const data of queued.splice(0)) readMessage(ws, room, data, controlledIds)
})

// Drop sockets that stop answering pings. Cloudflare and mobile networks both
// leave half-open connections behind, and a stale connection keeps a room
// pinned in memory forever.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000)

const sweeper = setInterval(sweepIdleRooms, 60_000)

const gcTimer = setInterval(
  () => {
    collectOrphanBlobs()
      .then(({ removed }) => {
        if (removed > 0) console.log(`[gc] removed ${removed} orphan blob(s)`)
      })
      .catch((err) => console.error('[gc] sweep failed:', err))
  },
  60 * 60 * 1000,
)

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal}, flushing rooms...`)
  clearInterval(heartbeat)
  clearInterval(sweeper)
  clearInterval(gcTimer)
  for (const ws of wss.clients) ws.close(1001, 'server restarting')
  try {
    await flushAll()
  } catch (err) {
    console.error('[server] flush on shutdown failed:', err)
  }
  server.close(() => process.exit(0))
  // Don't hang forever if a socket refuses to close.
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

async function main() {
  await initFiles()
  await migrate()

  // Reclaim blobs left behind by a crash or a failed delete. Best effort: a
  // read-only or missing volume must not stop the server from starting.
  collectOrphanBlobs()
    .then(({ removed }) => {
      if (removed > 0) console.log(`[gc] removed ${removed} orphan blob(s)`)
    })
    .catch((err) => console.error('[gc] startup sweep failed:', err))

  server.listen(config.port, config.host, () => {
    console.log(`[server] listening on ${config.host}:${config.port}`)
  })
}

main().catch((err) => {
  console.error('[server] startup failed:', err)
  process.exit(1)
})
