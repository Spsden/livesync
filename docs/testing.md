# Testing

The test strategy follows from where this system fails *silently*. A wrong pixel
is obvious; a protocol regression, a resurrected delete, or a snapshot that
quietly stops being written is not. So the committed tests concentrate there.

## What exists

| Layer | Artifact | Runs in CI | Covers |
| --- | --- | --- | --- |
| Protocol / API smoke | `scripts/smoke.mjs` | no CI configured | sync, convergence, awareness, files, all delete paths, tombstone |
| Browser E2E | not committed — see below | — | real React/CodeMirror UI in two contexts |
| Type check | `npm run typecheck` | — | client TS surface |

## Smoke test

```sh
# against a local server
npm run start                    # or: pm2 start ecosystem.config.cjs
BASE=http://127.0.0.1:3002 npm run smoke

# against the deployed edge (exercises TLS + the tunnel + wss)
BASE=https://livesync.example.com npm run smoke
```

It creates a random `smoke-*` room, exercises it, then deletes it — it is safe to
run against production, and leaves only one tombstone (remove with SQL if you
care). It exits non-zero on the first failed assertion.

### What it asserts, and why each one exists

1. **Both clients sync** — the handshake works in both directions.
2. **Tab structure propagates, not just text** — `tabs` is a CRDT array; a text-
   only test would pass even if structural sync were broken.
3. **Concurrent edits converge** — both clients type at different offsets, then
   the final strings must be identical. This is the core CRDT guarantee and the
   one thing that fails when a protocol change drops an update.
4. **Awareness reaches the peer** — presence is a separate channel with separate
   framing; it can break without affecting text.
5. **File round-trip** — upload, then download and byte-compare, including the
   original filename.
6. **Single-file delete** — the download must 404 afterwards.
7. **Cross-room delete is refused** — a blob id from room A cannot be deleted via
   room B (the endpoint is room-scoped).
8. **Notepad delete racing the debounced save** — the script edits, waits 100 ms
   (less than `FLUSH_DELAY_MS`), then deletes. This is the exact window in which
   a naive implementation resurrects the row (ADR-004, cause 1).
9. **Tombstoned reconnect is refused with `4404`** — the client must not be able
   to recreate a deleted notepad by reconnecting (ADR-004, cause 2).

### Two details that will silently weaken the test if removed

**`disableBc: true` on every provider.** `y-websocket` syncs same-room providers
in-process over `BroadcastChannel`. Without disabling it, two "clients" in the
same Node process can agree *without the server being involved at all* — the test
passes while the protocol is broken. This was discovered by exactly that failure
mode during development.

**The delete timing.** Deleting after the debounce has elapsed tests the happy
path only. The 100 ms delay is deliberate.

## Browser-level checks (optional, not committed)

A Playwright harness was used during development to validate the real UI. It is
not committed because it needs a browser binary and would add a heavy optional
dependency. The checklist it automated, in order, is worth reproducing before a
release:

1. `/` shows the landing page; "Create a notepad" navigates to `/n/<12 hex>`.
2. Editor mounts, exactly one bootstrap tab, connection dot reads `connected`.
3. Typing in context A appears in context B (separate browser contexts, so no
   `BroadcastChannel` shortcut).
4. Presence avatars render for both participants.
5. `+` creates a second tab; the peer sees it.
6. Double-click rename syncs to the peer.
7. Upload a file; it appears in the peer's sidebar; downloading returns the exact
   bytes.
8. Delete the file from A; it disappears from B.
9. Delete the notepad from A: confirm button stays disabled until `delete` is
   typed, then A navigates to a fresh notepad with a "Notepad deleted" toast.
10. B shows "This notepad was deleted" (i.e. it received `4404` and did **not**
    silently reconnect).
11. No console errors or unhandled page errors in either context.

Recipe if you want to rebuild it: `npm i -D playwright-core`, point `CHROME` at a
Chromium/Chrome binary (or `npx playwright install chromium` once), drive two
`browser.newContext()` pages, and assert the list above.

## Not covered

- Postgres outage and recovery (behaviour is described in the architecture doc,
  not tested).
- GC against live data — only the age guard is exercised manually.
- Two simultaneous notepad deletes; two clients deleting the same file.
- Large uploads near `MAX_FILE_BYTES`, and upload concurrency/RAM behaviour.
- Long-idle websockets through Cloudflare (>60 s), and reconnect storms.
- Multiple process instances (deliberately unsupported).
- Mobile layout and touch interactions.

## Suggested CI

If this gets CI, in order of value:

```sh
npm run typecheck
npm run build
docker compose up -d postgres
npm run start &
BASE=http://127.0.0.1:3000 npm run smoke
```

The build step is not optional: it is the only check that `BASE_PATH` and the
client bundle agree.
