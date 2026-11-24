// Watch scope: a single-file ingest must NOT subscribe its parent directory.
// Only an explicit directory ingest adds that directory to `watch_dirs`, and
// only subscribed directories are scanned for new files.
// Run: node test/watch-scope.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { applyPlugin } from '../lib/plugin.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const base = process.env.KB_LITE_TEST_ROOT || path.join(os.tmpdir(), `kb-lite-watch-scope-${process.pid}`)
const enginePath = path.join(root, 'engine', 'kb_engine.py')
const python = process.env.KB_LITE_PYTHON || 'python'
fs.rmSync(base, { recursive: true, force: true })

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name}`, JSON.stringify(detail) ?? '')
}

function writeDoc(file, heading, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, [`# ${heading}`, '', body, ''].join('\n'), 'utf8')
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

function outlineTotal() {
  const run = engine([{ op: 'outline', params: { kb_root: base, limit: 500 } }])
  return run.byId.get(1)?.result?.total ?? -1
}

function watchDirs() {
  const run = engine([{ op: 'stats', params: { kb_root: base } }])
  return run.byId.get(1)?.result?.watch_dirs ?? []
}

try {
  // --- 1. single file: sibling must stay out -----------------------------
  const dirA = path.join(base, '_a')
  const single = path.join(dirA, 'single.md')
  const sibling = path.join(dirA, 'sibling.md')
  writeDoc(single, '单文件', '单文件正文：只收我自己。')
  writeDoc(sibling, '兄弟文件', '兄弟文件正文：不该被顺带收进来。')

  const one = await call('kb_ingest', { paths: [single] })
  check('single-file ingest adds one document', one.ok === true && one.added === 1, one)

  engine([{ op: 'watch', params: { kb_root: base } }])
  check('watch does not pull in the sibling of a single-file ingest', outlineTotal() === 1, outlineTotal())
  check('single-file ingest subscribes no directory', watchDirs().length === 0, watchDirs())

  // --- 2. explicit directory ingest: subscription works ------------------
  const dir = await call('kb_ingest', { paths: [dirA] })
  check('directory ingest adds the sibling too', dir.ok === true && dir.added === 1, dir)
  const dirsAfter = watchDirs()
  check(
    'directory ingest records the subscribed directory',
    dirsAfter.length === 1 && dirsAfter[0].toLowerCase() === dirA.toLowerCase(),
    dirsAfter,
  )

  const fresh = path.join(dirA, 'fresh.md')
  writeDoc(fresh, '新文件', '新文件正文：目录订阅后应当自动进来。')
  engine([{ op: 'watch', params: { kb_root: base } }])
  check('watch adds a new file inside a subscribed directory', outlineTotal() === 3, outlineTotal())

  // --- 3. another indexed file elsewhere: still no subscription ----------
  const dirB = path.join(base, '_b')
  const only = path.join(dirB, 'only.md')
  writeDoc(only, '另一个文件', '另一个目录里的单文件。')
  const second = await call('kb_ingest', { paths: [only] })
  check('second single-file ingest works', second.ok === true && second.added === 1, second)
  const stray = path.join(dirB, 'stray.md')
  writeDoc(stray, '游离文件', '没有订阅目录时，新文件不应被收进来。')
  engine([{ op: 'watch', params: { kb_root: base } }])
  check('unsubscribed directory is never scanned', outlineTotal() === 4, outlineTotal())
  check('subscriptions stay at one directory', watchDirs().length === 1, watchDirs())
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
