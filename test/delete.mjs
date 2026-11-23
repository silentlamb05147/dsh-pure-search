// Recycle bin: kb_delete moves a document to the bin (chunks out of the
// searchable store, manifest entry kept so the watcher cannot resurrect it),
// the bin can list / restore / purge it, and purging is the only way to
// actually drop the index entry.
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
const enginePath = path.join(root, 'engine', 'kb_engine.py')
const python = process.env.KB_LITE_PYTHON || 'python'
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

function engine(requests) {
  const input = requests.map((item, index) => JSON.stringify({ id: index + 1, ...item })).join('\n')
  const ran = spawnSync(python, [enginePath], {
    input: `${input}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, KB_LITE_LAZY_DENSE: '1' },
  })
  const byId = new Map()
  for (const line of String(ran.stdout || '').split('\n')) {
    if (line.trim() === '') continue
    const parsed = JSON.parse(line)
    byId.set(parsed.id, parsed)
  }
  return { status: ran.status, byId, stderr: ran.stderr }
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

  const moved = await call('kb_delete', { path: policy })
  check(
    'delete moves the document to the bin',
    moved.ok === true && moved.trashed === true && moved.chunks_moved > 0,
    moved,
  )

  const after = await call('kb_outline', {})
  check('outline hides a trashed document', after.total === 0, after.total)

  const withExcluded = await call('kb_outline', { include_excluded: true })
  const entry = (withExcluded.docs || [])[0]
  check(
    'outline include_excluded shows status trash',
    withExcluded.total === 1 && entry && entry.status === 'trashed',
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

  const listed = engine([{ op: 'trash', params: { kb_root: base } }]).byId.get(1)
  check(
    'trash lists the document with its chunks',
    listed && listed.ok === true && listed.result.total === 1 && listed.result.items[0].chunks > 0,
    listed && listed.result,
  )

  // The watcher must skip trashed paths even though the file is still there.
  const watchRun = engine([
    { op: 'watch', params: { kb_root: base } },
    { op: 'outline', params: { kb_root: base } },
  ])
  const watched = watchRun.byId.get(2)
  check(
    'watch does not resurrect a trashed file',
    watchRun.status === 0 && watched && watched.ok === true && watched.result.total === 0,
    watched && watched.result && watched.result.total,
  )

  const restored = engine([{ op: 'restore', params: { kb_root: base, path: policy } }]).byId.get(1)
  check('restore brings it back', restored && restored.ok === true && restored.result.restored === true, restored)
  const back = await call('kb_search', { query: '退款窗口' })
  check('searchable again after restore', (back.hits || []).length > 0, back.hits?.length)

  const trashedAgain = await call('kb_delete', { path: policy })
  check('can trash it a second time', trashedAgain.ok === true && trashedAgain.trashed === true, trashedAgain)

  const purged = engine([{ op: 'purge', params: { kb_root: base, path: policy } }]).byId.get(1)
  check('purge drops the entry for good', purged && purged.ok === true && purged.result.purged === 1, purged)

  const afterPurge = engine([
    { op: 'outline', params: { kb_root: base, include_excluded: true } },
    { op: 'trash', params: { kb_root: base } },
  ])
  const outlineAfter = afterPurge.byId.get(1)
  const trashAfter = afterPurge.byId.get(2)
  check(
    'purge leaves neither entry nor bin row',
    outlineAfter.result.total === 0 && trashAfter.result.total === 0,
    { outline: outlineAfter.result.total, trash: trashAfter.result.total },
  )

  const purgedMissing = engine([{ op: 'purge', params: { kb_root: base, path: path.join(docs, 'nope.md') } }]).byId.get(1)
  check(
    'purge of an unindexed path returns not_found',
    purgedMissing.ok === false && purgedMissing.error && purgedMissing.error.code === 'not_found',
    purgedMissing.error,
  )

  const reingest = await call('kb_ingest', { paths: [policy] })
  check('explicit ingest indexes it again', reingest.ok === true && reingest.added === 1, reingest)
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
