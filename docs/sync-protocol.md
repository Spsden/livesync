# Sync protocol

The server speaks the `y-websocket` wire protocol directly, implemented in
`server/sync.js` (~120 lines). This document describes the format it expects, the
handshake it performs, and the rules that are easy to break.

## Why this is hand-rolled

The official server moved to `@y/websocket-server`, which depends on **Yjs 14
(prequel)**. The client editor binding (`y-codemirror.next`) peers on **Yjs 13**,
and two copies of Yjs in one process break its shared type registry (instances
are compared by identity, not shape).

So the choice was: pin Yjs 13 everywhere and speak a small, stable protocol, or
run two incompatible Yjs versions. See
[ADR-002](decisions.md#adr-002-pin-yjs-13-and-implement-the-protocol).

The protocol itself did not change between the versions that matter here: it is a
varint message type followed by a `y-protocols` payload.

## Framing

Every frame is binary:

```
┌────────────────┬─────────────────────────────┐
│ messageType    │ payload                     │
│ varUint        │ message-specific            │
└────────────────┴─────────────────────────────┘
```

| `messageType` | Name | Payload |
| --- | --- | --- |
| `0` | sync | `varUint syncSubtype` + `varUint8Array data` |
| `1` | awareness | `varUint8Array awarenessUpdate` |
| `2` | auth | unused by this server |
| `3` | queryAwareness | empty |

Sync subtypes (`y-protocols/sync.js`):

| `syncSubtype` | Name | `data` |
| --- | --- | --- |
| `0` | step 1 | state vector (what the sender has) |
| `1` | step 2 | update containing what the receiver is missing |
| `2` | update | incremental update (normal edits) |

All varints and arrays use `lib0/encoding` — the same codec the client uses, so
there is no separate serialisation to maintain.

## Handshake

```
Client                                   Server
  │                                        │
  │  ── WS upgrade /ws/<room> ────────────►│  validate room, tombstone? load doc
  │                                        │
  │  ◄── sync/step1 (server state vector) ─│  sent immediately on connect
  │  ◄── awareness (all known clients) ────│  only if any states exist
  │                                        │
  │  ── sync/step1 (client state vector) ─►│
  │  ◄── sync/step2 (missing for client) ──│  reply written by readSyncMessage
  │  ── sync/step2 (missing for server) ──►│  applied, broadcast to peers
  │                                        │
  │  ── awareness (local user) ───────────►│  applied, broadcast to peers
```

Both sides send a step 1 and answer with a step 2, so a reconnect exchanges only
the differences in both directions, independent of who reconnects.

**Ordering detail:** frames that arrive before the room finishes loading are
queued, then replayed in order. A fast client must not be able to lose its first
edit just because Postgres was slow.

## Server behaviour

### On connection

1. Reject invalid room names (`[A-Za-z0-9_-]{1,64}`) and tombstones (close `4404`).
2. `getRoom(name)` — shared load, one per room (see `rooms.js`).
3. Send `sync/step1` with the server's state vector.
4. Send one `awareness` frame containing every known client state.
5. Drain any queued frames.

### On `sync`

```js
encoding.writeVarUint(encoder, MESSAGE_SYNC)
syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
```

`readSyncMessage` applies step 2/update payloads and *writes a reply into the
encoder only for step 1*. The `length > 1` check avoids sending empty frames.

The connection object is passed as the transaction origin. That single choice is
what makes echo suppression possible (below).

### On `awareness`

The update is applied with the connection as origin. The client ids carried by
the frame are recorded on the connection so they can be removed on disconnect —
this is what prevents ghost cursors after a browser closes without a clean
goodbye.

### Broadcast

Two listeners are attached once per room, not per connection:

```js
doc.on('update', (update, origin) => {
  for (const conn of room.conns) {
    if (conn === origin) continue        // author already has it
    sendSyncUpdate(conn, update)
  }
})

awareness.on('update', ({ added, updated, removed }, origin) => {
  const changed = [...added, ...updated, ...removed]
  for (const conn of room.conns) {
    if (conn === origin) continue
    sendAwareness(conn, awareness, changed)
  }
})
```

Rules worth preserving:

- **Never echo to the origin.** Yjs already applied the change locally; the
  round trip is pure latency.
- **Broadcast, don't interpret.** The server never inspects document semantics.
- **Awareness is not persisted.** It is ephemeral by definition.

### On disconnect

1. Remove awareness states controlled by that connection (`origin = null`, so
   the removal is broadcast to everyone still connected).
2. Remove the connection from the room.
3. If it was the last connection, flush the room immediately instead of waiting
   for the debounce.

## Keepalive

The server pings every 30 s and terminates sockets that miss a pong. Cloudflare
and mobile networks both leave half-open connections behind; without this, a
dead client keeps a room resident forever and looks "present" to everyone else.

## Close codes

| Code | Meaning | Client behaviour |
| --- | --- | --- |
| `1001` | server shutting down | reconnect (transient) |
| `1011` | room failed to load | reconnect via `y-websocket` backoff |
| `4404` | notepad deleted | **stop**, show "deleted" |

`y-websocket` treats `4400–4499` as permanent by convention: it sets
`shouldConnect = false` and emits a terminal `closed` event. The client listens
for that event rather than reading the socket directly.

## Client side

The browser uses `y-websocket@3.1.0` (`WebsocketProvider`), pointed at
`<ws|wss>://<host><BASE_PATH>/ws`. The provider appends `/<room>`.

Behaviours that matter to this system:

- Exponential backoff reconnect, reset on a successful sync.
- Cross-tab sync over `BroadcastChannel` (same origin, same room). Desirable —
  and the reason tombstones exist, since a peer tab can hand a cached document
  to a fresh connection.
- `disableBc: true` is used in tests so "two clients" really means two servers
  round trips.

## Compatibility checklist

Before touching versions:

- [ ] `yjs` stays on 13.x (currently pinned `13.6.33`) while `y-codemirror.next`
      peers on 13.x.
- [ ] `y-protocols` and `lib0` are shared, not duplicated, in the dependency tree
      (`npm ls yjs` must show exactly one).
- [ ] If moving to Yjs 14, replace `server/sync.js` with the official server and
      re-verify the editor binding — the protocol layer and the CRDT are coupled
      through `y-protocols`.

The smoke test (`npm run smoke`) is the guard rail: two independent clients,
concurrent edits, awareness, and file round-trips. It fails loudly on a protocol
regression.
