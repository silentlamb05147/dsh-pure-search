// Portable smoke test for dsh-pure-search: no DSH, no network.
// Run: node test/smoke.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { applyPlugin } from '../lib/plugin.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const base = process.env.KB_LITE_TEST_ROOT || path.join(os.tmpdir(), `kb-lite-smoke-${process.pid}`)
fs.rmSync(base, { recursive: true, force: true })
const docs = path.join(base, '_docs')
fs.mkdirSync(docs, { recursive: true })

const longMd = path.join(docs, 'report.md')
fs.writeFileSync(
  longMd,
  [
    '# 一季度经营复盘',
    '',
    '毛利率下降 3.2 个百分点，主要来自云资源成本上升。',
    '',
    '## 成本结构',
    '',
    '云资源成本环比上升 18%，其中对象存储占新增成本的一半。',
    '',
    '## 下一步',
    '',
    '下季度重点是把对象存储的冷数据迁到低频层。',
  ].join('\n'),
  'utf8',
)
const pageHtml = path.join(docs, 'sla.html')
fs.writeFileSync(
  pageHtml,
  '<html><head><title>SLA</title></head><body><h1>响应时限</h1>' +
    '<p>P1 工单 15 分钟内响应。</p><script>var __tracking = 1;</script></body></html>',
  'utf8',
)
const configJson = path.join(docs, 'gateway.json')
fs.writeFileSync(
  configJson,
  JSON.stringify({ order_gateway: { timeout_ms: 800, retries: 2 } }, null, 2),
  'utf8',
)

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name}`, detail ?? '')
}

const tools = new Map()
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: () => {},
}
const dispose = applyPlugin(ctx, (definition) => definition, {
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
  check('tools registered', tools.size === 8, [...tools.keys()])

  const ingest = await call('kb_ingest', { paths: [docs] })
  check('ingest added 3', ingest.ok === true && ingest.added === 3, ingest)

  const hits = await call('kb_search', {
    query: '毛利率下降原因',
    top_k: 3,
    context: true,
  })
  const first = hits.hits && hits.hits[0]
  check('search finds report.md', first && path.basename(first.path) === 'report.md', first)
  check('search has context neighbours', first && first.context, first && first.context)

  const htmlHit = await call('kb_search', { query: 'P1 工单响应时限', top_k: 2 })
  check(
    'html extracted',
    htmlHit.hits && htmlHit.hits.some((hit) => path.basename(hit.path) === 'sla.html'),
    htmlHit.hits && htmlHit.hits.map((hit) => hit.path),
  )
  const scriptHit = await call('kb_search', { query: '__tracking', top_k: 2 })
  check('script text not indexed', !scriptHit.hits || scriptHit.hits.length === 0, scriptHit.hits)

  const jsonHit = await call('kb_search', { query: 'order_gateway timeout_ms', top_k: 2 })
  check(
    'json flattened',
    jsonHit.hits && jsonHit.hits.some((hit) => path.basename(hit.path) === 'gateway.json'),
    jsonHit.hits && jsonHit.hits.map((hit) => hit.path),
  )

  const outline = await call('kb_outline', {})
  check('outline has 3 docs', outline.ok === true && outline.total === 3, outline.total)

  const got = await call('kb_get', { path: longMd, start_line: 1, end_line: 4 })
  check('get returns text', got.ok === true && String(got.text || '').includes('毛利率'), got)

  const stats = await call('kb_stats', {})
  check('stats reports bytes and warnings', stats.ok === true && stats.bytes > 0 && Array.isArray(stats.warnings), stats)

  // watch: touch the markdown file, then sweep; the engine must re-ingest it.
  const engine = startEngine()
  try {
    fs.appendFileSync(longMd, '\n补充：复核已完成。\n', 'utf8')
    const watched = await engine.request('watch', { kb_root: base })
    check('watch refreshed changed doc', Array.isArray(watched.refreshed) && watched.refreshed.length === 1, watched)
    const missingFile = path.join(docs, 'gateway.json')
    fs.rmSync(missingFile, { force: true })
    const second = await engine.request('watch', { kb_root: base })
    check('watch reports missing doc', Array.isArray(second.missing) && second.missing.length === 1, second)
  } finally {
    engine.close()
  }
} finally {
  await dispose()
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
fs.rmSync(base, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)

function pythonPath() {
  const candidates = [
    process.env.KB_LITE_PYTHON,
    process.env.PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  throw new Error('no python interpreter found; set KB_LITE_PYTHON')
}

function startEngine() {
  const child = spawn(pythonPath(), [path.join(root, 'engine', 'kb_engine.py')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let buffer = ''
  let seq = 0
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message && message.id != null && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.ok) resolve(message.result)
        else reject(new Error(message.error && message.error.message))
      }
    }
  })
  return {
    request(op, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(`${JSON.stringify({ id, op, params })}\n`)
      })
    },
    close() {
      child.kill()
    },
  }
}
