// Verifies the abuse ceilings: per-IP HTTP budgets, upload and room-create
// limits, WebSocket connection caps, message-flood cutoffs, and that garbage
// frames close a socket instead of crashing the process.
//
// Run it against a throwaway server with tiny limits and a test database:
//
//   PORT=3221 HOST=127.0.0.1 DATA_DIR=/tmp/abuse DATABASE_URL=... \
//   CREATE_LIMIT=3 CREATE_WINDOW_MS=60000 \
//   UPLOAD_LIMIT=2 UPLOAD_WINDOW_MS=60000 \
//   HTTP_LIMIT=40 HTTP_WINDOW_MS=60000 \
//   WS_MAX_PER_IP=3 WS_MSG_PER_SEC=5 \
//   node --env-file-if-exists=.env server/index.js
//
//   BASE=http://127.0.0.1:3221 node scripts/abuse.mjs

import WebSocket from 'ws'

const base = process.env.BASE ?? 'http://127.0.0.1:3221'
const wsBase = base.replace(/^http/, 'ws') + '/ws'
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`)
  else {
    failures += 1
    console.error(`FAIL ${name} ${detail}`)
  }
}

const rid = () => Math.random().toString(36).slice(2, 10)

// 1. Create the room used by the upload and WebSocket checks first, then
// exhaust the remaining two create slots. Delete every created room before
// exhausting the global HTTP budget.
const room = `abuse-u-${rid()}`
const createdRooms = []
const firstCreate = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ room }),
})
check('test room created', firstCreate.status === 200, `status=${firstCreate.status}`)
if (firstCreate.status === 200) createdRooms.push(room)

const createStatuses = []
for (let i = 0; i < 4; i++) {
  const candidate = `abuse-c-${rid()}`
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: candidate }),
  })
  createStatuses.push(res.status)
  if (res.status === 200) createdRooms.push(candidate)
  if (res.status === 429) {
    check('create 429 has Retry-After', Boolean(res.headers.get('retry-after')))
  }
}
check(
  'create limited at 3',
  createStatuses.join(',') === '200,200,429,429',
  createStatuses.join(','),
)

// 2. Upload budget: UPLOAD_LIMIT=2 per window.
const uploadStatuses = []
for (let i = 0; i < 3; i++) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(64)]), 'f.bin')
  const res = await fetch(`${base}/api/rooms/${room}/files`, {
    method: 'POST',
    body: form,
  })
  uploadStatuses.push(res.status)
}
check(
  'upload limited at 2',
  uploadStatuses.join(',') === '200,200,429',
  uploadStatuses.join(','),
)

// 3. WS per-IP cap: WS_MAX_PER_IP=3. The fourth handshake is refused with
// HTTP 503 before the server allocates another WebSocket.
const openWs = (r) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/${r}`)
    const state = { ws, opened: false, closeCode: null, error: null }
    ws.on('open', () => {
      state.opened = true
      resolve(state)
    })
    ws.on('close', (code) => {
      state.closeCode = code
      if (!state.opened) resolve(state)
    })
    ws.on('error', (err) => {
      state.error = err.message
      if (!state.opened) resolve(state)
    })
  })
const conns = []
for (let i = 0; i < 4; i++) conns.push(await openWs(room))
check('first 3 ws open', conns.slice(0, 3).every((c) => c.opened))
check(
  '4th ws refused 503',
  !conns[3].opened && conns[3].error?.includes('503'),
  `error=${conns[3].error}`,
)

// 4. Message flood: WS_MSG_PER_SEC=5 (bucket capacity 10) must close the
//    socket. A separate malformed frame must close with 1003.
const flooded = await new Promise((resolve) => {
  const ws = conns[0].ws
  ws.on('close', (code) => resolve(code))
  // 3 is a valid query-awareness message, so only the rate ceiling should
  // close this socket (rather than the malformed-frame handler).
  for (let i = 0; i < 100; i++) ws.send(new Uint8Array([3]))
  setTimeout(() => resolve('still-open'), 3000)
})
check(
  'flood closed 1008',
  flooded === 1008,
  `code=${flooded}`,
)

const malformed = await openWs(room)
if (malformed.opened) malformed.ws.send(new Uint8Array([0]))
const malformedCode = await new Promise((resolve) => {
  if (malformed.closeCode !== null) return resolve(malformed.closeCode)
  malformed.ws.once('close', resolve)
  setTimeout(() => resolve('still-open'), 3000)
})
check('malformed frame closed 1003', malformedCode === 1003, `code=${malformedCode}`)

// 5. The server survived the flood and the malformed frame.
const health = await fetch(`${base}/api/health`)
check('server alive after flood', health.status === 200, `status=${health.status}`)

for (const c of [...conns, malformed]) c.ws.terminate()
for (const created of createdRooms) {
  const res = await fetch(`${base}/api/rooms/${created}`, { method: 'DELETE' })
  check(`cleaned up ${created}`, res.status === 200, `status=${res.status}`)
}

// 6. Global HTTP budget: HTTP_LIMIT=40 per window (some already spent above).
let saw429 = false
for (let i = 0; i < 60; i++) {
  const res = await fetch(`${base}/api/health`)
  if (res.status === 429) {
    saw429 = true
    break
  }
}
check('global http limit trips', saw429)

console.log(failures === 0 ? '\nABUSE OK' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
