// End-to-end smoke test against a running server.
//
//   npm run start            # in one shell
//   npm run smoke            # in another
//
// Verifies the things most likely to rot: the hand-rolled y-websocket protocol,
// concurrent-edit convergence, awareness, file round-trips, and that deleting
// actually deletes (including when a debounced save is still in flight).

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const base = process.env.BASE ?? 'http://127.0.0.1:3000'
const wsBase = base.replace(/^http/, 'ws') + '/ws'
const room = `smoke-${Math.random().toString(36).slice(2, 10)}`
console.log(`room: ${room}`)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exitCode = 1
    throw new Error(message)
  }
}

const synced = (provider) =>
  new Promise((resolve) => {
    if (provider.synced) return resolve()
    provider.once('sync', resolve)
  })

async function upload(name, body) {
  const form = new FormData()
  form.append('file', new Blob([body], { type: 'text/plain' }), name)
  const response = await fetch(`${base}/api/rooms/${room}/files`, {
    method: 'POST',
    body: form,
  })
  assert(response.ok, `upload accepted (${response.status})`)
  return response.json()
}

const docA = new Y.Doc()
const docB = new Y.Doc()
// disableBc matters: y-websocket syncs same-room providers in-process through
// BroadcastChannel, so without it these "two clients" could agree without the
// server ever being involved.
const providerA = new WebsocketProvider(wsBase, room, docA, { disableBc: true })
const providerB = new WebsocketProvider(wsBase, room, docB, { disableBc: true })

try {
  await Promise.all([synced(providerA), synced(providerB)])
  console.log('connected: both clients synced')

  // --- structure syncs, not just text ---
  docA.transact(() => {
    docA.getArray('tabs').push([{ id: 'tab1', title: 'one' }])
  })
  docA.getText('tab:tab1').insert(0, 'hello from A')
  await wait(400)

  const tabsB = docB.getArray('tabs')
  assert(tabsB.length === 1, 'B sees exactly one tab')
  assert(tabsB.get(0)?.title === 'one', 'B sees the tab title')
  assert(
    docB.getText('tab:tab1').toString() === 'hello from A',
    'B sees the tab body',
  )
  console.log('tab + text propagated A -> B')

  // --- concurrent edits converge ---
  docA.getText('tab:tab1').insert(5, '!')
  docB.getText('tab:tab1').insert(0, '>> ')
  await wait(600)
  const textA = docA.getText('tab:tab1').toString()
  const textB = docB.getText('tab:tab1').toString()
  assert(textA === textB, `concurrent edits converged (${textA} vs ${textB})`)
  console.log(`concurrent edits converged: ${JSON.stringify(textA)}`)

  // --- awareness ---
  providerA.awareness.setLocalStateField('user', {
    name: 'smoke tester',
    color: '#5b8cff',
  })
  await wait(400)
  const seen = [...providerB.awareness.getStates().values()].some(
    (state) => state.user?.name === 'smoke tester',
  )
  assert(seen, 'peer name is visible via awareness')
  console.log('awareness propagated')

  // --- files ---
  const meta = await upload('smoke.txt', 'smoke test body')
  assert(meta.name === 'smoke.txt', 'upload keeps the original filename')

  const download = await fetch(`${base}/api/files/${meta.id}`)
  assert(download.ok, `download works (${download.status})`)
  assert((await download.text()) === 'smoke test body', 'download body matches')
  console.log(`file round-trip: ${meta.name} (${meta.size} bytes)`)

  // --- deleting one file ---
  const fileDelete = await fetch(
    `${base}/api/rooms/${room}/files/${meta.id}`,
    { method: 'DELETE' },
  )
  assert(fileDelete.ok, `file delete accepted (${fileDelete.status})`)
  const gone = await fetch(`${base}/api/files/${meta.id}`)
  assert(!gone.ok, `deleted file no longer downloads (${gone.status})`)
  console.log('single file delete')

  // A file id from another room must not be deletable through this room.
  const other = await upload('keep.txt', 'other body')
  const crossRoom = await fetch(`${base}/api/rooms/not-this-room/files/${other.id}`, {
    method: 'DELETE',
  })
  assert(crossRoom.status === 404, 'cross-room file delete is refused')
  assert(
    (await fetch(`${base}/api/files/${other.id}`)).ok,
    'cross-room delete did not remove the blob',
  )
  console.log('cross-room delete refused')

  // --- deleting the notepad, racing the debounced save ---
  // The save fires ~750 ms after the last edit; deleting inside that window is
  // exactly the case where a naive implementation resurrects the row.
  docA.getText('tab:tab1').insert(0, 'last second edit ')
  await wait(100)

  const roomDelete = await fetch(`${base}/api/rooms/${room}`, { method: 'DELETE' })
  assert(roomDelete.ok, `notepad delete accepted (${roomDelete.status})`)
  const report = await roomDelete.json()
  assert(report.files === 1, `delete reported 1 file (got ${report.files})`)

  await wait(1600)

  const remaining = await fetch(`${base}/api/files/${other.id}`)
  assert(!remaining.ok, 'remaining blob is gone after notepad delete')

  // Reconnecting must be refused, not silently recreated as an empty room.
  // Otherwise a stale tab can repopulate the notepad it just deleted.
  const probeDoc = new Y.Doc()
  const probe = new WebsocketProvider(wsBase, room, probeDoc, { disableBc: true })
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000)
    probe.on('closed', (event) => {
      clearTimeout(timer)
      resolve(event.code)
    })
    probe.on('sync', (isSynced) => {
      if (!isSynced) return
      clearTimeout(timer)
      resolve('synced')
    })
  })
  assert(outcome === 4404, `deleted notepad refuses reconnects (got ${outcome})`)
  assert(probeDoc.getArray('tabs').length === 0, 'refused client got no state')
  probe.destroy()
  probeDoc.destroy()
  console.log('notepad delete: rows, blobs gone; URL tombstoned')

  console.log(`\nSMOKE OK`)
} finally {
  providerA.destroy()
  providerB.destroy()
  docA.destroy()
  docB.destroy()
}
