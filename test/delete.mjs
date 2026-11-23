// Index deletion: kb_delete tombstones a document (chunks gone, entry kept),
// the watcher does not re-add it, and a later explicit ingest restores it.
// Run: node test/delete.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { applyPlugin } from '../lib/plugin.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const base = process.env.KB_LITE_TEST_ROOT || path.join(os.tmpdir(), `kb-lite-delete-${process.pid}`)
fs.rmSync(base, { recursive: true, force: true })

const docs = path.join(base, '_docs')
fs.mkdirSync(docs, { recursive: true })
const policy = path.join(docs, 'policy.md')
fs.writeFileSync(
  policy,
  ['# 退款政策', '', '退款窗口是 7 天。', '', '# 适用范围', '', '仅限自营商品。', ''].join('\n'),
  'utf8',
)

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name}`, JSON.stringify(detail) ?? '')
}

const tools = new Map()
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: () => {},
}
applyPlugin(ctx, (definition) => definition, {
  kbRoot: base,
  autoWorkspace: false,
  watch: false,
})

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool.execute(args, {})
}

try {
  check('kb_delete is registered', tools.has('kb_delete'), [...tools.keys()])

  const ingest = await call('kb_ingest', { paths: [policy] })
  check('ingest one document', ingest.ok === true && ingest.added === 1, ingest)

  const before = await call('kb_search', { query: '退款窗口' })
  check('searchable before delete', (before.hits || []).length > 0, before.hits?.length)

  const deleted = await call('kb_delete', { path: policy })
  check(
    'delete tombstones the document',
    deleted.ok === true && deleted.excluded === true && deleted.chunks_removed > 0,
    deleted,
  )

  const after = await call('kb_outline', {})
  check('outline hides deleted document', after.total === 0, after.total)

  const withExcluded = await call('kb_outline', { include_excluded: true })
  const entry = (withExcluded.docs || [])[0]
  check(
    'outline include_excluded shows status',
    withExcluded.total === 1 && entry && entry.status === 'excluded',
    entry && { status: entry.status, path: entry.path },
  )

  const hits = await call('kb_search', { query: '退款窗口' })
  check('search returns nothing after delete', (hits.hits || []).length === 0, hits.hits?.length)

  const again = await call('kb_delete', { path: policy })
  check('second delete reports already', again.ok === true && again.already === true, again)

  const missing = await call('kb_delete', { path: path.join(docs, 'nope.md') })
  check(
    'deleting an unindexed path returns not_found',
    missing.ok === false && missing.error && missing.error.code === 'not_found',
    missing.error,
  )

  // The watcher must skip tombstoned paths even though the file is still there.
  const enginePath = path.join(root, 'engine', 'kb_engine.py')
  const python = process.env.KB_LITE_PYTHON || 'python'
  const lines = [
    { id: 1, op: 'watch', params: { kb_root: base } },
    { id: 2, op: 'outline', params: { kb_root: path.join(base, '_shared') } },
  ]
    .map((item) => JSON.stringify(item))
    .join('\n')
  const ran = spawnSync(python, [enginePath], {
    input: `${lines}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, KB_LITE_LAZY_DENSE: '1' },
  })
  const responses = String(ran.stdout || '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const outline = responses.find((item) => item.id === 2)
  check(
    'watch does not resurrect a deleted file',
    ran.status === 0 && outline && outline.ok === true && outline.result.total === 0,
    outline && { ok: outline.ok, total: outline.result && outline.result.total, status: ran.status },
  )

  const restored = await call('kb_ingest', { paths: [policy] })
  check('explicit ingest restores the document', restored.ok === true && restored.added === 1, restored)
  const back = await call('kb_outline', {})
  check('outline shows it again', back.total === 1, back.total)
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
