// Section-level rerank: the right document must surface its answer block, not
// the boilerplate block that repeats the product code.
// Run: node test/section-rerank.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPlugin } from '../lib/plugin.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const base = process.env.KB_LITE_TEST_ROOT || path.join(os.tmpdir(), `kb-lite-sections-${process.pid}`)
fs.rmSync(base, { recursive: true, force: true })
const docs = path.join(base, '_docs')
fs.mkdirSync(docs, { recursive: true })

function policy(code, days) {
  return [
    `# ${code} 客户退款与换货政策`,
    '',
    '## 适用范围',
    '',
    `本政策适用于 ${code} 系列产品，包括标准版、专业版与订阅版。${code} 企业采购需另签补充协议。`,
    '',
    '## 退款窗口',
    '',
    `客户自签收之日起 ${days} 天内可申请无理由退款。超出 ${days} 天但未满 30 天的，需提供故障证明。`,
    '',
    '## 到账时间',
    '',
    `审核通过后 ${days - 3} 个工作日内退回原支付渠道。`,
    '',
    '## 联系方式',
    '',
    `客服邮箱 kf-${days}@lanhua.example，工作日 9:00–18:00 在线。`,
  ].join('\n')
}

fs.writeFileSync(path.join(docs, 'policy-27.md'), policy('澜舟-27', 13), 'utf8')
fs.writeFileSync(path.join(docs, 'policy-00.md'), policy('云栖-00', 7), 'utf8')
fs.writeFileSync(path.join(docs, 'policy-08.md'), policy('赤兔-08', 16), 'utf8')

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
  const ingest = await call('kb_ingest', { paths: [docs] })
  check('ingest added 3', ingest.ok === true && ingest.added === 3, ingest)

  const query = '澜舟-27 的退款窗口是多少天'
  const hits = await call('kb_search', { query, top_k: 5 })
  const list = hits.hits || []
  const first = list[0] || null

  check('right document first', first && path.basename(first.path) === 'policy-27.md', first && first.path)
  check(
    'answer section first',
    first && String(first.heading || '').includes('退款窗口'),
    first && first.heading,
  )
  check('answer text in first hit', first && String(first.snippet || '').includes('13 天'), first && first.snippet)
  check(
    'score_detail exposes section rank',
    first && first.score_detail && first.score_detail.doc_rank === 1 && first.score_detail.section_rank === 1,
    first && first.score_detail,
  )

  const distinctDocs = new Set(list.slice(0, 3).map((hit) => path.basename(hit.path)))
  check('top-3 keeps document diversity', distinctDocs.size >= 2, [...distinctDocs])

  const legacy = await call('kb_search', { query, top_k: 5, section_rerank: false })
  const legacyFirst = (legacy.hits || [])[0] || null
  check(
    'section_rerank:false keeps the score order',
    legacyFirst && !String(legacyFirst.heading || '').includes('退款窗口'),
    legacyFirst && legacyFirst.heading,
  )
} finally {
  await dispose()
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
fs.rmSync(base, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
