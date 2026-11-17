// Chapter handling: plain-text books get per-chapter headings, chapter queries
// hit the chapter itself, kb_get accepts `chapter`, and a single-file ingest
// only indexes that file.
// Run: node test/chapter.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPlugin } from '../lib/plugin.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const base = process.env.KB_LITE_TEST_ROOT || path.join(os.tmpdir(), `kb-lite-chapter-${process.pid}`)
fs.rmSync(base, { recursive: true, force: true })

const book = path.join(base, '_book')
const other = path.join(base, '_single')
fs.mkdirSync(book, { recursive: true })
fs.mkdirSync(other, { recursive: true })

const chapters = [
  ['第1章 入狱', '这一章写主角误入美利坚监狱，编号九五二七，铁门在身后合拢。'],
  ['第2章 吞噬黑莲', '狱中老者递来一朵黑莲，主角吞下后丹田燃起幽火，从此走上修炼路。'],
  ['第3章 永关城', '出了监狱便是永关城，城墙高百丈，守军盘查每一个出城的人。'],
]
const novel = path.join(book, '测试小说.txt')
fs.writeFileSync(
  novel,
  chapters.map(([title, body]) => `${title}\n\n${body}\n\n`).join(''),
  'utf8',
)

// A sibling book in the same directory: ingesting `novel` alone must not pick it up.
fs.writeFileSync(path.join(book, '另一本.txt'), '第1章 无关\n\n这本书不该被单文件导入带进来。\n', 'utf8')
fs.writeFileSync(path.join(other, 'single.md'), '# 单文件\n\n这一份只应该出现一次。\n', 'utf8')

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
  const ingest = await call('kb_ingest', { paths: [book] })
  check('ingest two books', ingest.ok === true && ingest.added === 2, ingest)

  const second = await call('kb_search', { query: '第2章 吞噬黑莲', top_k: 3, kb_root: base })
  const first = (second.hits || [])[0]
  check(
    'chapter query hits that chapter',
    first && String(first.heading || '').includes('第2章'),
    first && { heading: first.heading, score: first.score },
  )
  check(
    'chapter chunk carries its body',
    first && String(first.snippet || '').includes('黑莲'),
    first && String(first.snippet || '').slice(0, 40),
  )

  const chapter = await call('kb_get', {
    kb_root: base,
    path: novel,
    chapter: '第2章',
    max_chars: 400,
  })
  check('kb_get chapter works', chapter.ok === true && chapter.source === 'chapter', chapter.error || chapter.source)
  check(
    'chapter text is the chapter body',
    chapter.ok === true && String(chapter.text || '').includes('黑莲'),
    chapter.ok ? String(chapter.text || '').slice(0, 40) : chapter.error,
  )
  check(
    'chapter get respects the chapter range',
    chapter.ok === true && Number.isInteger(chapter.start_line) && chapter.end_line > chapter.start_line,
    chapter.ok ? { start_line: chapter.start_line, end_line: chapter.end_line } : null,
  )

  const missing = await call('kb_get', { kb_root: base, path: novel, chapter: '第99章' })
  check('missing chapter is not_found', missing.code === 'not_found' || missing.ok === false, missing.error || missing.code)

  // Single file: only itself, not its siblings.
  const single = await call('kb_ingest', { paths: [path.join(other, 'single.md')], kb_root: path.join(base, '_singleindex') })
  check('single-file ingest adds one doc', single.ok === true && single.added === 1, single)
  const outline = await call('kb_outline', { kb_root: path.join(base, '_singleindex') })
  check(
    'single-file ingest leaves siblings out',
    outline.ok === true && outline.total === 1 && path.basename(outline.docs[0].path) === 'single.md',
    outline.ok ? outline.docs.map((doc) => doc.path) : outline.error,
  )
} finally {
  try {
    ctx.effect()
  } catch {
    // ignore
  }
}

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
