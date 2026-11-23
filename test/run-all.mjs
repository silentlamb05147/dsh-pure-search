// Run every test script in order; print a compact summary and exit non-zero on failure.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const scripts = [
  'test/smoke.mjs',
  'test-layers.mjs',
  'test/section-rerank.mjs',
  'test/chapter.mjs',
  'test/delete.mjs',
]
let failed = 0

for (const script of scripts) {
  console.log(`\n=== ${script} ===`)
  const result = spawnSync(process.execPath, [path.join(root, script)], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    failed += 1
    console.error(`${script} failed with exit code ${result.status}`)
  }
}

console.log(`\n${scripts.length - failed}/${scripts.length} test scripts passed`)
process.exit(failed === 0 ? 0 : 1)
