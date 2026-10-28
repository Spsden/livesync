// Standalone blob GC. Also runs hourly inside the server; this is for ops.
//
//   npm run gc
//
// Requires .env (read via node --env-file) and the same DATA_DIR as the server.

import { pool } from '../server/db.js'
import { initFiles } from '../server/files.js'
import { collectOrphanBlobs } from '../server/gc.js'

const minAgeMs = Number(process.env.GC_MIN_AGE_MS ?? 60 * 60 * 1000)

await initFiles()
const { removed, kept, known } = await collectOrphanBlobs({ minAgeMs })
console.log(
  `[gc] ${removed} orphan blob(s) removed, ${kept} skipped (young), ${known} referenced`,
)

await pool.end()
