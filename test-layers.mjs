// End-to-end check for the layered workspace/session feature, without DSH.
// Run: node test-layers.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { applyPlugin } from './lib/plugin.js'

const base =
  process.env.KB_LITE_TEST_ROOT ||
  path.join(os.tmpdir(), `kb-lite-layertest-${process.pid}`)
fs.rmSync(base, { recursive: true, force: true })

const sampleDir = path.join(base, '_sample-docs')
fs.mkdirSync(sampleDir, { recursive: true })
const sharedDoc = path.join(sampleDir, 'shared.md')
const sessionDoc = path.join(sampleDir, 'session.md')
fs.writeFileSync(sharedDoc, '# 发布流程\n\n先灰度 5% 流量，再全量。回滚窗口 30 分钟。\n', 'utf8')
fs.writeFileSync(sessionDoc, '# 今晚计划\n\n今晚 9 点发布 2.1 版本，负责人阿岚。\n', 'utf8')

const tools = new Map()
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: () => {},
}
const defineTool = (definition) => definition
const dispose = applyPlugin(ctx, defineTool, { kbRoot: base })

const call = async (name, args, exec = {}) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} not registered: ${[...tools.keys()].join(', ')}`)
  return tool.execute(args, exec)
}

const brief = (result) => {
  if (!result || result.ok !== true) return { ok: false, error: result && result.error }
  return {
    ok: true,
    layer: result.layer,
    fell_back: result.fell_back,
    fallback_reason: result.fallback_reason,
    hits: Array.isArray(result.hits)
      ? result.hits.map((hit) => ({ path: path.basename(hit.path), score: hit.score }))
      : undefined,
    layers: result.layers
      ? Object.fromEntries(
          Object.entries(result.layers).map(([name, stats]) => [
            name,
            { docs: stats.docs, chunks: stats.chunks },
          ]),
        )
      : undefined,
    scope: result.scope,
  }
}

const out = {}
out.ingestShared = brief(await call('kb_ingest', { paths: [sharedDoc], workspace: 'Demo WS' }))
out.ingestSession = brief(
  await call('kb_ingest', { paths: [sessionDoc], workspace: 'Demo WS', session: 's1' }),
)
out.stats = brief(await call('kb_stats', { workspace: 'Demo WS', session: 's1' }))

out.sessionHit = brief(
  await call('kb_search', {
    query: '今晚什么时候发布 2.1 版本',
    workspace: 'Demo WS',
    session: 's1',
    top_k: 3,
  }),
)
out.fallbackOnNoHits = brief(
  await call('kb_search', {
    query: '灰度 5% 流量 回滚窗口',
    workspace: 'Demo WS',
    session: 's1',
    top_k: 3,
  }),
)
out.fallbackOnEmptySession = brief(
  await call('kb_search', {
    query: '灰度 5% 流量 回滚窗口',
    workspace: 'Demo WS',
    session: 'empty-session',
    top_k: 3,
  }),
)
out.noFallback = brief(
  await call('kb_search', {
    query: '灰度 5% 流量 回滚窗口',
    workspace: 'Demo WS',
    session: 'empty-session',
    fallback: false,
    top_k: 3,
  }),
)
out.ask = brief(
  await call('kb_ask', {
    query: '今晚发布什么版本',
    workspace: 'Demo WS',
    session: 'empty-session',
  }),
)

// --- layered behaviour -------------------------------------------------------
const assert = (label, condition, detail) => {
  if (!condition) {
    console.error(`FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail))
    fs.rmSync(base, { recursive: true, force: true })
    process.exit(1)
  }
}

assert('session hit stays in session', out.sessionHit.layer === 'session' && out.sessionHit.hits.length > 0, out.sessionHit)
assert('fallback on no hits', out.fallbackOnNoHits.layer === 'workspace' && out.fallbackOnNoHits.fell_back === true, out.fallbackOnNoHits)
assert(
  'fallback on empty session',
  out.fallbackOnEmptySession.fallback_reason === 'session_empty' && out.fallbackOnEmptySession.fell_back === true,
  out.fallbackOnEmptySession,
)
assert('fallback:false returns empty', out.noFallback.fell_back === false && out.noFallback.hits.length === 0, out.noFallback)
assert('kb_ask falls back', out.ask.layer === 'workspace' && out.ask.fell_back === true, out.ask)
assert('stats reports both layers', Boolean(out.stats.layers && out.stats.layers.workspace), out.stats)

// --- kb_outline / kb_get -----------------------------------------------------

const outlineSession = await call('kb_outline', { workspace: 'Demo WS', session: 's1' })
assert('outline is ok', outlineSession.ok === true, outlineSession)
assert('outline merges session + workspace', outlineSession.total === 2, outlineSession)
assert('outline labels layers', outlineSession.docs.some((doc) => doc.layer === 'session'), outlineSession.docs)
assert(
  'outline carries headings',
  outlineSession.docs.every((doc) => Array.isArray(doc.headings)),
  outlineSession.docs,
)
const outlineFiltered = await call('kb_outline', { workspace: 'Demo WS', query: '发布流程' })
assert('outline query filters by title', outlineFiltered.total === 1, outlineFiltered)

const sessionSearch = await call('kb_search', {
  query: '今晚 9 点发布 2.1 版本 负责人阿岚',
  workspace: 'Demo WS',
  session: 's1',
  top_k: 1,
})
const chunkId = sessionSearch.hits && sessionSearch.hits[0] && sessionSearch.hits[0].chunk_id
assert('search returns a chunk id for kb_get', typeof chunkId === 'string' && chunkId !== '', sessionSearch)
const chunk = await call('kb_get', { workspace: 'Demo WS', session: 's1', chunk_id: chunkId })
assert('get returns chunk text', chunk.ok === true && chunk.text.includes('阿岚'), chunk)
assert('get chunk keeps source metadata', chunk.path.endsWith('session.md') && chunk.start_line >= 1, chunk)

const docRange = await call('kb_get', {
  workspace: 'Demo WS',
  session: 's1',
  path: sessionDoc,
  start_line: 1,
  end_line: 3,
})
assert('get returns a line range', docRange.ok === true && docRange.text.includes('今晚计划'), docRange)
const missing = await call('kb_get', {
  workspace: 'Demo WS',
  session: 'empty-session',
  path: path.join(sampleDir, 'missing.md'),
  fallback: false,
})
assert('get falls back / reports not_found', missing.ok === false && missing.error.code === 'not_found', missing)
out.outline = brief(outlineSession)
out.outlineFiltered = brief(outlineFiltered)
out.getChunk = { ok: chunk.ok, source: chunk.source, textLength: chunk.text.length, start_line: chunk.start_line }
out.getRange = { ok: docRange.ok, start_line: docRange.start_line, end_line: docRange.end_line }
out.getMissing = missing

// Auto workspace: with no explicit workspace, the session cwd decides the layer.
const autoDir = path.join(base, 'Auto Workspace')
fs.mkdirSync(autoDir, { recursive: true })
const auto = await call(
  'kb_search',
  { query: '任意问题', top_k: 1 },
  { agent: { session: { meta: { cwd: autoDir } } } },
)
assert('auto workspace follows session cwd', auto.scope.workspace === 'Auto Workspace', auto.scope)
out.autoWorkspace = auto.scope.workspace

console.log(JSON.stringify(out, null, 2))
fs.rmSync(base, { recursive: true, force: true })
await dispose()
process.exit(0)
