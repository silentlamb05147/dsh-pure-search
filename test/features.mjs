// Chapter headings, matched_terms snippets, and the dense status endpoint.
// Run: node test/features.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { applyPlugin } from '../lib/plugin.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const base = process.env.KB_LITE_TEST_ROOT
  || path.join(os.tmpdir(), `kb-lite-features-${process.pid}`)
const enginePath = path.join(root, 'engine', 'kb_engine.py')
const python = process.env.KB_LITE_PYTHON || 'python'
fs.rmSync(base, { recursive: true, force: true })

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.error(`FAIL ${name}`, JSON.stringify(detail) ?? '')
}

function writeDoc(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
}

const tools = new Map()
applyPlugin({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: () => {},
}, (definition) => definition, { kbRoot: base, autoWorkspace: false, watch: false })

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool.execute(args, {})
}

function runEngine(requests) {
  const input = requests.map((item, index) => JSON.stringify({ id: index + 1, ...item })).join('\n')
  const ran = spawnSync(python, [enginePath], {
    input: `${input}\n`, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, KB_LITE_LAZY_DENSE: '1', KB_LITE_DENSE: '0' },
  })
  return String(ran.stdout || '').split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

try {
  const file = path.join(base, 'handbook.md')
  writeDoc(file, [
    '# 员工手册',
    '',
    '公司制度总览。',
    '',
    '## 退款窗口',
    '',
    '客户自签收之日起 13 天内可申请退款，超过 13 天不予受理。',
    '',
    '## 报销流程',
    '',
    '报销单在每月 5 日前提交财务。',
    '',
  ].join('\n'))

  const ingested = await call('kb_ingest', { paths: [file] })
  check('markdown ingest works', ingested.ok === true, ingested)

  const outline = await call('kb_outline', {})
  const doc = (outline.docs || [])[0] || {}
  const headings = (doc.headings || []).join('|')
  check('markdown headings become chunk headings',
    headings.includes('退款窗口') && headings.includes('报销流程'), headings)

  const mixed = path.join(base, 'mixed.md')
  writeDoc(mixed, [
    '# 混合文档',
    '',
    '## 第一部分',
    '',
    'Chapter 12: The Return',
    '',
    '英文章节行应当单独成块。',
    '',
    '卷一 第三章 风起',
    '',
    '两层中文章节也应当被识别。',
    '',
  ].join('\n'))
  await call('kb_ingest', { paths: [mixed] })
  const mixedOutline = await call('kb_outline', { query: 'mixed' })
  const mixedDoc = (mixedOutline.docs || [])[0] || {}
  const mixedHeadings = (mixedDoc.headings || []).join('|')
  check('plain-text chapter lines inside a markdown section are detected',
    mixedHeadings.includes('Chapter 12: The Return') && mixedHeadings.includes('卷一 第三章 风起'),
    mixedHeadings)

  const search = await call('kb_search', { query: '退款窗口是几天', top_k: 1 })
  const hit = (search.hits || [])[0] || {}
  check('search returns the matching section first',
    String(hit.heading || '').includes('退款窗口'), hit.heading)
  check('hit carries matched_terms',
    Array.isArray(hit.matched_terms) && hit.matched_terms.some((term) => '退款窗口'.includes(term)),
    hit.matched_terms)
  check('snippet is centred on the match and mentions the window',
    typeof hit.snippet === 'string' && hit.snippet.includes('13 天'), hit.snippet)

  const dense = await call('kb_stats', {})
  check('stats reports dense off by default', dense.dense === false, dense.dense)

  const replies = runEngine([{ op: 'dense_status', params: {} }])
  const reply = replies.find((item) => item.id === 1)
  const status = reply && reply.result
  check('dense_status exposes install state',
    Boolean(status) && typeof status.installed === 'boolean'
      && typeof status.cache_dir === 'string', status)
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
