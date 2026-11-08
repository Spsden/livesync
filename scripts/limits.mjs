// Verifies the per-notepad storage budget.
//
// Run it against a throwaway server with small limits (same database, unique
// room ids), so the test is fast and does not disturb production:
//
//   PORT=3210 HOST=127.0.0.1 DATA_DIR=/tmp/limits \
//   MAX_NOTEPAD_BYTES=1048576 MAX_FILE_BYTES=1048576 \
//   node --env-file-if-exists=.env server/index.js
//
//   BASE=http://127.0.0.1:3210 LIMIT_MB=1 npm run limits

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const base = process.env.BASE ?? 'http://127.0.0.1:3210'
const wsBase = base.replace(/^http/, 'ws') + '/ws'
const limitMb = Number(process.env.LIMIT_MB ?? 1)
const budget = limitMb * 1024 * 1024

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    throw new Error(message)
  }
}

async function createRoom(room) {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room }),
  })
  assert(response.ok, `create ${room} (${response.status})`)
}

async function upload(room, bytes) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)]), 'blob.bin')
  return fetch(`${base}/api/rooms/${room}/files`, { method: 'POST', body: form })
}

async function deleteRoom(room) {
  await fetch(`${base}/api/rooms/${room}`, { method: 'DELETE' })
}

const filesRoom = `limits-files-${Math.random().toString(36).slice(2, 8)}`
const notesRoom = `limits-notes-${Math.random().toString(36).slice(2, 8)}`

try {
  await createRoom(filesRoom)

  const first = await upload(filesRoom, Math.round(budget * 0.6))
  assert(first.ok, `first upload accepted (${first.status})`)
  const firstFile = await first.json()

  const usedAfterFirst = await (
    await fetch(`${base}/api/rooms/${filesRoom}/usage`)
  ).json()
  assert(
    usedAfterFirst.used >= Math.round(budget * 0.6),
    `usage reports the upload (${usedAfterFirst.used})`,
  )
  assert(usedAfterFirst.limit === budget, `usage reports the budget (${usedAfterFirst.limit})`)

  const second = await upload(filesRoom, Math.round(budget * 0.6))
  assert(second.status === 413, `second upload refused (${second.status})`)
  const body = await second.json().catch(() => ({}))

  const usedAfterReject = await (
    await fetch(`${base}/api/rooms/${filesRoom}/usage`)
  ).json()
  assert(
    usedAfterReject.used === usedAfterFirst.used,
    'a refused upload does not change usage',
  )

  const removed = await fetch(
    `${base}/api/rooms/${filesRoom}/files/${firstFile.id}`,
    { method: 'DELETE' },
  )
  assert(removed.ok, `file delete accepted (${removed.status})`)

  const usedAfterDelete = await (
    await fetch(`${base}/api/rooms/${filesRoom}/usage`)
  ).json()
  assert(usedAfterDelete.used === 0, 'deleting the file frees the budget')

  console.log(
    `files: ${first.status} then ${second.status} — ${body.error ?? ''}`,
  )
  console.log(
    `usage: ${usedAfterFirst.used} -> ${usedAfterReject.used} -> ${usedAfterDelete.used}`,
  )

  await deleteRoom(filesRoom)

  await createRoom(notesRoom)
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(wsBase, notesRoom, doc, {
    disableBc: true,
  })
  await new Promise((resolve) => {
    if (provider.synced) resolve()
    else provider.once('sync', resolve)
  })

  const inserted = Math.round(budget * 1.15)
  doc.getText('tab:limit').insert(0, 'x'.repeat(inserted))

  const code = await new Promise((resolve) => {
    provider.on('closed', (event) => resolve(event.code))
    setTimeout(() => resolve('timeout'), 15_000)
  })
  assert(code === 4413, `oversize note closed with 4413 (got ${code})`)
  provider.destroy()
  doc.destroy()

  // Whatever fit is what the next client receives.
  const after = new Y.Doc()
  const reopened = new WebsocketProvider(wsBase, notesRoom, after, {
    disableBc: true,
  })
  await new Promise((resolve) => {
    if (reopened.synced) resolve()
    else reopened.once('sync', resolve)
  })
  const kept = after.getText('tab:limit').length
  assert(kept < inserted, `stored note stayed within budget (${kept} < ${inserted})`)
  reopened.destroy()
  after.destroy()

  console.log(`notes: closed 4413, stored ${kept} chars (< ${inserted})`)
  await deleteRoom(notesRoom)
  console.log('LIMITS OK')
} finally {
  await deleteRoom(filesRoom).catch(() => {})
  await deleteRoom(notesRoom).catch(() => {})
}
