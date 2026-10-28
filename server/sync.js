// Implements the y-websocket wire protocol on top of y-protocols.
//
// We hand-roll this instead of importing a server helper because the published
// server package depends on Yjs 14, while the CodeMirror binding (client side)
// requires Yjs 13. Running two Yjs copies in one process breaks shared state,
// so we pin Yjs 13 and speak the protocol ourselves. It is a small, stable
// format: a varint message type followed by an encoded payload.

import * as syncProtocol from 'y-protocols/sync.js'
import * as awarenessProtocol from 'y-protocols/awareness.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

const OPEN = 1

function send(conn, bytes) {
  if (conn.readyState !== OPEN) return
  try {
    conn.send(bytes, (err) => {
      if (err) conn.close()
    })
  } catch {
    conn.close()
  }
}

export function sendSyncStep1(conn, doc) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(conn, encoding.toUint8Array(encoder))
}

export function sendSyncUpdate(conn, update) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  send(conn, encoding.toUint8Array(encoder))
}

export function sendAwareness(conn, awareness, clientIds) {
  const clients = clientIds.filter((id) => awareness.meta.has(id))
  if (clients.length === 0) return
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  )
  send(conn, encoding.toUint8Array(encoder))
}

export function sendAwarenessAll(conn, awareness) {
  sendAwareness(conn, awareness, [...awareness.getStates().keys()])
}

/** Client ids carried by an awareness update, skipping "removed" entries. */
function readAwarenessClientIds(update) {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  const ids = []
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // clock
    const state = decoding.readVarString(decoder)
    if (state !== 'null') ids.push(clientId)
  }
  return ids
}

export function readMessage(conn, room, data, controlledIds) {
  const decoder = decoding.createDecoder(new Uint8Array(data))
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)

  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      // The transaction origin is the connection itself, which is how the
      // broadcaster knows not to echo the update back to its author.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
      if (encoding.length(encoder) > 1) {
        send(conn, encoding.toUint8Array(encoder))
      }
      break
    }
    case MESSAGE_AWARENESS: {
      const update = decoding.readVarUint8Array(decoder)
      for (const id of readAwarenessClientIds(update)) controlledIds.add(id)
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn)
      break
    }
    case MESSAGE_QUERY_AWARENESS: {
      sendAwarenessAll(conn, room.awareness)
      break
    }
    default:
      break
  }
}

export function dropConnection(room, conn, controlledIds) {
  awarenessProtocol.removeAwarenessStates(
    room.awareness,
    [...controlledIds],
    null,
  )
  room.conns.delete(conn)
}
