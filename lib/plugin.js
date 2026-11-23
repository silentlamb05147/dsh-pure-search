// kb-lite DSH host plugin.
//
// All tool logic lives here. This module deliberately imports no
// @deepseek-ai/* packages: `applyPlugin(ctx, defineTool, opts)` receives the
// host's defineTool function from lib/index.js, which keeps everything here
// directly testable with a fake ctx/defineTool.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EngineError,
  createChildProcessTransport,
  createEngineClient,
  resolvePythonPath,
} from './rpc.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_INGEST_TIMEOUT_MS = 300_000

const MAX_TOP_K = 50
const DEFAULT_TOP_K_SEARCH = 8
const DEFAULT_TOP_K_ASK = 5
const DEFAULT_MAX_FILES = 50
const MAX_MAX_FILES = 500
const DEFAULT_MAX_CHARS = 6000

const SEARCH_MODES = new Set(['auto', 'bm25', 'dense', 'hybrid'])

/** Shared output renderer: never throws, always returns one text block. */
function renderJsonResult(_args, value) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = undefined
  }
  if (typeof text !== 'string') {
    try {
      text = String(value)
    } catch {
      text = '{"ok":false,"error":{"code":"render_failed","message":"result could not be rendered"}}'
    }
  }
  return [{ type: 'text', text }]
}

const TOOL_OUTPUT = {
  schema: { type: 'json' },
  render: renderJsonResult,
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function publicError(error) {
  const code =
    error && typeof error === 'object' && typeof error.code === 'string' && error.code
      ? error.code
      : 'internal_error'
  let message = 'unknown error'
  try {
    message = String(error && error.message ? error.message : error)
  } catch {
    message = 'unknown error'
  }
  return { code, message }
}

function resolveEnginePath(projectRoot, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    return path.isAbsolute(requested)
      ? path.normalize(requested)
      : path.resolve(projectRoot, requested)
  }
  // The engine lives under <package>/engine/. Accept the conventional names so
  // the Node and Python halves can evolve independently; kb_engine.py is the
  // canonical entry point.
  const candidates = [
    'kb_engine.py',
    'engine.py',
    'main.py',
    'server.py',
    'kb-lite.py',
    'kb_lite.py',
  ]
  for (const name of candidates) {
    const candidate = path.join(projectRoot, 'engine', name)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(projectRoot, 'engine', 'kb_engine.py')
}

function packageRootFromModule() {
  try {
    return path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  } catch {
    return process.cwd()
  }
}

/**
 * Register the five kb-lite tools on a DSH context.
 *
 * @param {object} ctx              DSH context (uses ctx.tools.register, ctx.effect)
 * @param {Function} defineTool     @deepseek-ai/dsh-tools defineTool
 * @param {object} [opts]
 * @param {string} [opts.kbRoot]    Default knowledge-base directory.
 * @param {string} [opts.projectRoot] Package root used to locate engine/kb_engine.py.
 * @param {string} [opts.enginePath] Explicit engine entry point.
 * @param {string} [opts.python]    Python executable (else KB_LITE_PYTHON, else python).
 * @param {string} [opts.cwd]       Engine child-process cwd. Default process.cwd().
 * @param {object} [opts.transport] Pre-built engine transport (tests/integration).
 * @param {Function} [opts.restart] Transport factory used for (re)starts.
 * @param {number} [opts.timeoutMs] Default request timeout (30 s).
 * @param {number} [opts.ingestTimeoutMs] Ingest timeout (300 s).
 * @returns {Function} dispose() - closes the engine; safe to call more than once.
 */
export function applyPlugin(ctx, defineTool, opts = {}) {
  if (typeof defineTool !== 'function') {
    throw new TypeError('applyPlugin requires defineTool from @deepseek-ai/dsh-tools')
  }
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new TypeError('applyPlugin requires ctx.tools.register')
  }

  const options = opts && typeof opts === 'object' ? opts : {}
  const projectRoot = path.resolve(options.projectRoot ?? packageRootFromModule())
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const ingestTimeoutMs = Number.isFinite(options.ingestTimeoutMs)
    ? options.ingestTimeoutMs
    : DEFAULT_INGEST_TIMEOUT_MS

  let client = null
  let disposed = false
  let cachedPython = null

  function defaultKbRoot() {
    if (typeof options.kbRoot === 'string' && options.kbRoot.trim() !== '') {
      return path.resolve(options.kbRoot)
    }
    const fromEnv = process.env.KB_LITE_ROOT
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return path.resolve(fromEnv)
    }
    return path.join(os.homedir(), '.kb-lite')
  }

  function resolveKbRoot(value) {
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value)
    return defaultKbRoot()
  }

  function autoWorkspaceEnabled() {
    if (options.autoWorkspace === false) return false
    if (options.autoWorkspace === true) return true
    const raw = String((options.env ?? process.env).KB_LITE_AUTO_WORKSPACE ?? '1')
      .trim()
      .toLowerCase()
    return raw !== '0' && raw !== 'false' && raw !== 'off'
  }

  // The host has moved this field around across versions, and the live
  // Session object in this build exposes neither `meta` nor `cwd` at the top
  // level. Try every plausible location and report which one hit.
  function execCwd(exec) {
    const session = exec?.agent?.session
    const candidates = [
      ['agent.cwd', exec?.agent?.cwd],
      ['session.cwd', session?.cwd],
      ['session.meta.cwd', session?.meta?.cwd],
      ['session.header.cwd', session?.header?.cwd],
      ['session.header.workspace', session?.header?.workspace],
      ['exec.cwd', exec?.cwd],
      ['exec.workspace', exec?.workspace],
    ]
    for (const [source, value] of candidates) {
      if (typeof value === 'string' && value.trim() !== '') return { cwd: value, source }
    }
    return { cwd: '', source: null }
  }

  function defaultWorkspace(exec) {
    const env = options.env ?? process.env
    const fromEnv = typeof env.KB_LITE_WORKSPACE === 'string' ? env.KB_LITE_WORKSPACE.trim() : ''
    if (fromEnv) return fromEnv
    if (typeof options.workspace === 'string' && options.workspace.trim() !== '') {
      return options.workspace.trim()
    }
    if (!autoWorkspaceEnabled()) return ''
    // Prefer the calling session's cwd: the host process cwd is usually the
    // DSH profile directory, which is not a meaningful workspace name.
    const cwd = execCwd(exec).cwd
    if (cwd.trim() !== '') {
      const resolved = path.resolve(cwd)
      // The DSH profile directory is not a workspace; treating it as one
      // creates a junk `<base>/desktop` index that shadows the real one.
      if (resolved.includes(`${path.sep}.dsh${path.sep}profiles${path.sep}`)) return ''
      return path.basename(resolved)
    }
    return ''
  }

  function defaultSession() {
    const env = options.env ?? process.env
    const fromEnv = typeof env.KB_LITE_SESSION === 'string' ? env.KB_LITE_SESSION.trim() : ''
    if (fromEnv) return fromEnv
    return typeof options.session === 'string' ? options.session.trim() : ''
  }

  // --- workspace / session layering ------------------------------------------
  // Layout: <base>/<workspace>/_shared   and   <base>/<workspace>/sessions/<name>
  // Queries look in the session layer first; when that layer has no documents
  // or no hits, they fall back to the workspace layer. Scores are never mixed
  // across layers: the two indexes have independent BM25 statistics.
  function sanitizeSegment(value) {
    if (typeof value !== 'string') return ''
    const cleaned = value
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+$/, '')
    return cleaned.slice(0, 80)
  }

  function layerRoots(args, exec) {
    const base = resolveKbRoot(args.kb_root)
    const workspace = sanitizeSegment(args.workspace ?? defaultWorkspace(exec))
    const session = sanitizeSegment(args.session ?? defaultSession())
    const cwdHit = execCwd(exec)
    const debugScope = String((options.env ?? process.env).KB_LITE_DEBUG_SCOPE ?? '') === '1'
    const probe = debugScope
      ? {
          has_agent: Boolean(exec && exec.agent),
          has_session: Boolean(exec && exec.agent && exec.agent.session),
          exec_keys: exec && typeof exec === 'object' ? Object.keys(exec).slice(0, 20) : null,
          session_keys:
            exec?.agent?.session && typeof exec.agent.session === 'object'
              ? Object.keys(exec.agent.session).slice(0, 20)
              : null,
          header_keys:
            exec?.agent?.session?.header && typeof exec.agent.session.header === 'object'
              ? Object.keys(exec.agent.session.header).slice(0, 20)
              : null,
          agent_keys:
            exec?.agent && typeof exec.agent === 'object'
              ? Object.keys(exec.agent).slice(0, 20)
              : null,
          cwd_source: cwdHit.source,
          cwd: cwdHit.cwd || null,
        }
      : null
    if (!workspace) {
      return {
        base,
        workspace: '',
        session: '',
        sessionRoot: '',
        sharedRoot: base,
        layered: false,
        probe,
      }
    }
    return {
      base,
      workspace,
      session,
      sessionRoot: session ? path.join(base, workspace, 'sessions', session) : '',
      sharedRoot: path.join(base, workspace, '_shared'),
      layered: true,
      probe,
    }
  }

  function publicScope(scope) {
    return {
      base: scope.base,
      workspace: scope.workspace,
      session: scope.session,
      shared_root: scope.sharedRoot,
      session_root: scope.sessionRoot || null,
      layered: scope.layered,
      exec_probe: scope.probe || null,
    }
  }

  function evidenceCount(result) {
    if (!result || typeof result !== 'object') return 0
    for (const key of ['hits', 'passages', 'results']) {
      if (Array.isArray(result[key])) return result[key].length
    }
    return 0
  }

  function statsDocCount(stats) {
    if (!stats || typeof stats !== 'object') return 0
    const raw = stats.docs ?? stats.document_count ?? stats.documents ?? 0
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }

  async function engineStats(root, exec) {
    return getClient().request(
      'stats',
      { kb_root: root },
      {
        signal: exec && exec.signal ? exec.signal : undefined,
        timeoutMs,
      },
    )
  }

  function makeSpawnTransport() {
    const enginePath = resolveEnginePath(projectRoot, options.enginePath)
    if (!fs.existsSync(enginePath)) {
      throw new EngineError(
        'engine_not_found',
        `Python engine not found at ${enginePath}. Set opts.enginePath or install the engine/ directory.`,
      )
    }
    if (!cachedPython) {
      cachedPython = resolvePythonPath({
        python: options.python,
        env: options.env ?? process.env,
        probe: options.probePython,
      }).python
    }
    // Warm the embedding model lazily by default: the first `auto` search
    // answers from BM25 and loads the model in the background, so a session
    // never blocks ~14 s on the first query.
    const baseEnv = options.env ?? process.env
    const env = { ...baseEnv }
    if (env.KB_LITE_LAZY_DENSE === undefined) env.KB_LITE_LAZY_DENSE = '1'
    return createChildProcessTransport({
      argv: [cachedPython, enginePath],
      cwd: options.cwd ?? process.cwd(),
      env,
      spawnFn: options.spawnFn,
    })
  }

  function getClient() {
    if (disposed) throw new EngineError('engine_closed', 'kb-lite plugin has been disposed')
    if (client) return client
    const restart =
      typeof options.restart === 'function'
        ? options.restart
        : typeof options.createTransport === 'function'
          ? options.createTransport
          : options.transport
            ? undefined
            : makeSpawnTransport
    client = createEngineClient({
      transport: options.transport,
      restart,
      timeoutMs,
      backoffMs: options.backoffMs,
      restartLimit: options.restartLimit,
      killOnAbort: options.killOnAbort,
    })
    return client
  }

  function badRequest(message) {
    return new EngineError('bad_request', message)
  }

  function buildIngestParams(args) {
    const kbRoot = resolveKbRoot(args.kb_root)

    let rawPaths = args.paths
    if (typeof rawPaths === 'string') rawPaths = [rawPaths]
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      throw badRequest('kb_ingest requires a non-empty paths array of absolute paths')
    }

    const paths = []
    for (const rawPath of rawPaths) {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        throw badRequest('kb_ingest paths entries must be non-empty strings')
      }
      const trimmed = rawPath.trim()
      if (path.isAbsolute(trimmed)) {
        paths.push(trimmed)
        continue
      }
      // Contract: paths must be absolute. We still try to be helpful: resolve a
      // relative path against the home directory, and if that does not exist,
      // say exactly what happened in the error text.
      const againstHome = path.resolve(os.homedir(), trimmed)
      if (fs.existsSync(againstHome)) {
        paths.push(againstHome)
        continue
      }
      throw new EngineError(
        'path_not_absolute',
        `kb_ingest paths must be absolute; '${trimmed}' was resolved against ` +
          `${os.homedir()} as '${againstHome}' and that path does not exist`,
      )
    }

    return {
      kb_root: kbRoot,
      paths,
      recursive: args.recursive !== false,
      force: args.force === true,
      prune: args.prune === true,
      max_files: clampInt(args.max_files, DEFAULT_MAX_FILES, 1, MAX_MAX_FILES),
      chunk_chars:
        args.chunk_chars === undefined || args.chunk_chars === null
          ? undefined
          : clampInt(args.chunk_chars, 1200, 200, 8000),
      chunk_overlap:
        args.chunk_overlap === undefined || args.chunk_overlap === null
          ? undefined
          : clampInt(args.chunk_overlap, 120, 0, 4000),
      with_embeddings:
        typeof args.with_embeddings === 'string' && args.with_embeddings.trim() !== ''
          ? args.with_embeddings.trim()
          : 'auto',
    }
  }

  function normalizeWeights(raw) {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest(
        'weights must be an object like { "bm25": 1.0, "dense": 0.6, "boost": { "memory/": 1.3 } }',
      )
    }
    const out = {}
    for (const key of ['bm25', 'dense', 'rrf_k']) {
      if (raw[key] === undefined || raw[key] === null) continue
      const n = Number(raw[key])
      if (!Number.isFinite(n) || n < 0) {
        throw badRequest(`weights.${key} must be a non-negative number`)
      }
      out[key] = n
    }
    if (raw.boost !== undefined && raw.boost !== null) out.boost = raw.boost
    if (raw.recency !== undefined && raw.recency !== null) {
      if (typeof raw.recency !== 'object' || Array.isArray(raw.recency)) {
        throw badRequest('weights.recency must be an object like { "half_life_days": 30, "min": 0.25 }')
      }
      out.recency = raw.recency
    }
    if (raw.rerank !== undefined && raw.rerank !== null) {
      const ok = typeof raw.rerank === 'boolean' || (typeof raw.rerank === 'object' && !Array.isArray(raw.rerank))
      if (!ok) throw badRequest('weights.rerank must be a boolean or an object like { "top_n": 24 }')
      out.rerank = raw.rerank
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  function requireQuery(args, toolName) {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      throw badRequest(`${toolName} requires a non-empty query string`)
    }
    return args.query
  }

  function buildSearchParams(args) {
    const query = requireQuery(args, 'kb_search')
    let mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : 'auto'
    if (mode === '') mode = 'auto'
    if (!SEARCH_MODES.has(mode)) {
      throw badRequest(`kb_search mode must be one of: ${[...SEARCH_MODES].join(', ')}`)
    }
    const weights = normalizeWeights(args.weights)
    return {
      kb_root: resolveKbRoot(args.kb_root),
      query,
      top_k: clampInt(args.top_k, DEFAULT_TOP_K_SEARCH, 1, MAX_TOP_K),
      mode,
      ...(args.context === true ? { context: true } : {}),
      ...(args.section_rerank === false ? { section_rerank: false } : {}),
      ...(weights ? { weights } : {}),
    }
  }

  function buildAskParams(args) {
    const weights = normalizeWeights(args.weights)
    return {
      kb_root: resolveKbRoot(args.kb_root),
      query: requireQuery(args, 'kb_ask'),
      top_k: clampInt(args.top_k, DEFAULT_TOP_K_ASK, 1, MAX_TOP_K),
      max_chars: clampInt(args.max_chars, DEFAULT_MAX_CHARS, 1, 200_000),
      ...(args.section_rerank === false ? { section_rerank: false } : {}),
      ...(weights ? { weights } : {}),
    }
  }

  function buildStatsParams(args) {
    return { kb_root: resolveKbRoot(args.kb_root) }
  }

  function buildClearParams(args) {
    if (args.confirm !== true) {
      throw new EngineError(
        'confirm_required',
        'kb_clear requires confirm: true because it deletes the whole knowledge base',
      )
    }
    return { kb_root: resolveKbRoot(args.kb_root), confirm: true }
  }

  function buildOutlineParams(args) {
    const query = typeof args.query === 'string' && args.query.trim() !== ''
      ? args.query.trim()
      : undefined
    return {
      kb_root: resolveKbRoot(args.kb_root),
      ...(query ? { query } : {}),
      limit: clampInt(args.limit, 200, 1, 2000),
      ...(args.include_excluded === true ? { include_excluded: true } : {}),
    }
  }

  function buildDeleteParams(args) {
    if (typeof args.path !== 'string' || args.path.trim() === '') {
      throw badRequest('kb_delete requires a non-empty path')
    }
    return {
      kb_root: resolveKbRoot(args.kb_root),
      path: args.path.trim(),
      restore: args.restore === true,
    }
  }

  function buildGetParams(args) {
    const hasChunk = typeof args.chunk_id === 'string' && args.chunk_id.trim() !== ''
    const hasPath = typeof args.path === 'string' && args.path.trim() !== ''
    if (!hasChunk && !hasPath) {
      throw badRequest('kb_get requires either path or chunk_id')
    }
    const hasChapter = typeof args.chapter === 'string' && args.chapter.trim() !== ''
    return {
      kb_root: resolveKbRoot(args.kb_root),
      ...(hasPath ? { path: args.path.trim() } : {}),
      ...(hasChunk ? { chunk_id: args.chunk_id.trim() } : {}),
      ...(hasChapter && hasPath ? { chapter: args.chapter.trim() } : {}),
      ...(args.start_line !== undefined ? { start_line: clampInt(args.start_line, 1, 1, 1_000_000) } : {}),
      ...(args.end_line !== undefined ? { end_line: clampInt(args.end_line, 1, 1, 1_000_000) } : {}),
      max_chars: clampInt(args.max_chars, DEFAULT_MAX_CHARS, 200, 200_000),
    }
  }

  const builders = {
    ingest: buildIngestParams,
    search: buildSearchParams,
    ask: buildAskParams,
    outline: buildOutlineParams,
    get: buildGetParams,
    delete: buildDeleteParams,
    stats: buildStatsParams,
    clear: buildClearParams,
  }

  async function runTool(op, rawArgs, exec) {
    try {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const scope = layerRoots(args, exec)
      if (scope.layered) {
        if (op === 'ingest') return await runLayeredIngest(args, scope, exec)
        if (op === 'clear') return await runLayeredClear(args, scope, exec)
        if (op === 'delete') return await runLayeredDelete(args, scope, exec)
        if (op === 'stats') return await runLayeredStats(args, scope, exec)
        if (op === 'search' || op === 'ask') return await runLayeredQuery(op, args, scope, exec)
        if (op === 'outline') return await runLayeredOutline(args, scope, exec)
        if (op === 'get') return await runLayeredGet(args, scope, exec)
      }
      const params = builders[op](args)
      const engine = getClient()
      const result = await engine.request(op, params, {
        signal: exec && exec.signal ? exec.signal : undefined,
        timeoutMs: op === 'ingest' ? ingestTimeoutMs : timeoutMs,
      })
      const body =
        result && typeof result === 'object' && !Array.isArray(result) ? result : { result }
      return { ok: true, ...body, scope: publicScope(scope) }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  }

  async function runLayeredIngest(args, scope, exec) {
    const target = scope.sessionRoot || scope.sharedRoot
    const params = { ...builders.ingest(args), kb_root: target }
    const result = await getClient().request('ingest', params, {
      signal: exec && exec.signal ? exec.signal : undefined,
      timeoutMs: ingestTimeoutMs,
    })
    const body =
      result && typeof result === 'object' && !Array.isArray(result) ? result : { result }
    return {
      ok: true,
      ...body,
      layer: scope.sessionRoot ? 'session' : 'workspace',
      scope: publicScope(scope),
    }
  }

  async function runLayeredClear(args, scope, exec) {
    const which = typeof args.scope === 'string' ? args.scope.trim().toLowerCase() : 'session'
    const roots = []
    if (which === 'session') {
      if (!scope.sessionRoot) throw badRequest('kb_clear scope="session" requires a session name')
      roots.push(scope.sessionRoot)
    } else if (which === 'workspace' || which === 'shared') {
      roots.push(scope.sharedRoot)
    } else if (which === 'all') {
      if (scope.sessionRoot) roots.push(scope.sessionRoot)
      roots.push(scope.sharedRoot)
    } else {
      throw badRequest('kb_clear scope must be one of: session, workspace, all')
    }
    const cleared = []
    for (const root of roots) {
      const result = await getClient().request(
        'clear',
        { kb_root: root, confirm: true },
        {
          signal: exec && exec.signal ? exec.signal : undefined,
          timeoutMs,
        },
      )
      cleared.push({ root, ...(result && typeof result === 'object' ? result : {}) })
    }
    return { ok: true, cleared, scope: publicScope(scope) }
  }

  async function runLayeredDelete(args, scope, exec) {
    const params = buildDeleteParams(args)
    const target = scope.sessionRoot || scope.sharedRoot
    const result = await getClient().request('delete', { ...params, kb_root: target }, {
      signal: exec && exec.signal ? exec.signal : undefined,
      timeoutMs,
    })
    const body =
      result && typeof result === 'object' && !Array.isArray(result) ? result : { result }
    return {
      ok: true,
      ...body,
      layer: scope.sessionRoot ? 'session' : 'workspace',
      scope: publicScope(scope),
    }
  }

  async function runLayeredStats(args, scope, exec) {
    const layers = {}
    if (scope.sessionRoot) layers.session = await engineStats(scope.sessionRoot, exec)
    layers.workspace = await engineStats(scope.sharedRoot, exec)
    return { ok: true, layers, scope: publicScope(scope) }
  }

  async function runLayeredQuery(op, args, scope, exec) {
    const params = builders[op](args)
    const request = (root) =>
      getClient().request(
        op,
        { ...params, kb_root: root },
        {
          signal: exec && exec.signal ? exec.signal : undefined,
          timeoutMs,
        },
      )

    if (!scope.sessionRoot) {
      const shared = await request(scope.sharedRoot)
      return {
        ok: true,
        ...shared,
        layer: 'workspace',
        fell_back: false,
        scope: publicScope(scope),
      }
    }

    let sessionEmpty = true
    try {
      sessionEmpty = statsDocCount(await engineStats(scope.sessionRoot, exec)) <= 0
    } catch {
      sessionEmpty = true
    }

    let sessionResult = null
    if (!sessionEmpty) {
      sessionResult = await request(scope.sessionRoot)
      if (evidenceCount(sessionResult) > 0) {
        return {
          ok: true,
          ...sessionResult,
          layer: 'session',
          fell_back: false,
          scope: publicScope(scope),
        }
      }
    }

    if (args.fallback === false) {
      const result = sessionResult ?? { hits: [] }
      return {
        ok: true,
        ...result,
        layer: 'session',
        fell_back: false,
        fallback_reason: sessionEmpty ? 'session_empty' : 'no_hits',
        scope: publicScope(scope),
      }
    }

    const shared = await request(scope.sharedRoot)
    return {
      ok: true,
      ...shared,
      layer: 'workspace',
      fell_back: true,
      fallback_reason: sessionEmpty ? 'session_empty' : 'no_hits',
      scope: publicScope(scope),
    }
  }

  async function runLayeredOutline(args, scope, exec) {
    const params = buildOutlineParams(args)
    const request = (root) => getClient().request('outline', { ...params, kb_root: root }, {
      signal: exec && exec.signal ? exec.signal : undefined,
      timeoutMs,
    })
    let sessionDocs = []
    let sessionCount = 0
    if (scope.sessionRoot) {
      try {
        const result = await request(scope.sessionRoot)
        sessionDocs = (Array.isArray(result.docs) ? result.docs : [])
          .map((doc) => ({ ...doc, layer: 'session' }))
        sessionCount = Number(result.total) || sessionDocs.length
      } catch (error) {
        if (!error || error.code !== 'not_found') throw error
      }
    }
    const sharedResult = await request(scope.sharedRoot)
    const seen = new Set(sessionDocs.map((doc) => String(doc.path || '').toLowerCase()))
    const sharedDocs = (Array.isArray(sharedResult.docs) ? sharedResult.docs : [])
      .filter((doc) => !seen.has(String(doc.path || '').toLowerCase()))
      .map((doc) => ({ ...doc, layer: 'workspace' }))
    const merged = [...sessionDocs, ...sharedDocs]
    const limit = params.limit ?? 200
    return {
      ok: true,
      docs: merged.slice(0, limit),
      total: (Number(sharedResult.total) || sharedDocs.length) + sessionCount,
      returned: Math.min(merged.length, limit),
      truncated: merged.length > limit,
      layers: {
        session: sessionCount,
        workspace: Number(sharedResult.total) || sharedDocs.length,
      },
      scope: publicScope(scope),
    }
  }

  async function runLayeredGet(args, scope, exec) {
    const params = buildGetParams(args)
    const request = (root) => getClient().request('get', { ...params, kb_root: root }, {
      signal: exec && exec.signal ? exec.signal : undefined,
      timeoutMs,
    })
    if (scope.sessionRoot) {
      try {
        const result = await request(scope.sessionRoot)
        const body = result && typeof result === 'object' ? result : {}
        return { ok: true, ...body, layer: 'session', fell_back: false, scope: publicScope(scope) }
      } catch (error) {
        if (!error || error.code !== 'not_found') throw error
      }
    }
    if (args.fallback === false) {
      return {
        ok: false,
        error: { code: 'not_found', message: 'document is not in the session layer' },
        layer: 'session',
        fell_back: false,
        fallback_reason: 'not_found',
        scope: publicScope(scope),
      }
    }
    const result = await request(scope.sharedRoot)
    const body = result && typeof result === 'object' ? result : {}
    return { ok: true, ...body, layer: 'workspace', fell_back: true, scope: publicScope(scope) }
  }

  // --- index freshness + memory-root sync -------------------------------------
  // The index is derived data: memory roots are authoritative. These helpers
  // answer "is the index older than the files?" without reading file contents,
  // and let one tool dump only the changed files back into the index.
  const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf'])
  const SKIP_DIRS = new Set(['node_modules', '.git', '.kb-lite-memory', '.tmp-backup', 'dist'])

  function configuredSyncRoots(kbRoot) {
    if (Array.isArray(options.syncRoots) && options.syncRoots.length > 0) {
      return options.syncRoots.map((entry) => path.resolve(String(entry)))
    }
    const raw = (options.env ?? process.env).KB_LITE_SYNC_ROOTS
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry))
    }
    // Third source: <kb_root>/sync-roots.json — editable without touching the
    // host process environment or restarting DSH.
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(kbRoot, 'sync-roots.json'), 'utf8').replace(/^\uFEFF/, ''),
      )
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.roots
      if (Array.isArray(list)) {
        return list
          .map((entry) => String(entry).trim())
          .filter(Boolean)
          .map((entry) => path.resolve(entry))
      }
    } catch {}
    return []
  }

  function readSyncState(kbRoot) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(kbRoot, 'sync-state.json'), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
    return {}
  }

  function writeSyncState(kbRoot, patch) {
    const next = { ...readSyncState(kbRoot), ...patch }
    try {
      fs.mkdirSync(kbRoot, { recursive: true })
      fs.writeFileSync(path.join(kbRoot, 'sync-state.json'), JSON.stringify(next, null, 2))
    } catch {}
    return next
  }

  function appendSyncLog(kbRoot, entry) {
    try {
      fs.mkdirSync(kbRoot, { recursive: true })
      fs.appendFileSync(path.join(kbRoot, 'sync-log.jsonl'), `${JSON.stringify(entry)}\n`)
    } catch {}
  }

  function indexBuiltAt(kbRoot) {
    try {
      return fs.statSync(path.join(kbRoot, 'manifest.json')).mtimeMs
    } catch {
      return 0
    }
  }

  function scanNewer(roots, sinceMs, maxFiles) {
    const files = []
    let newestMs = 0
    let newestPath = null
    const walk = (dir, depth) => {
      if (files.length >= maxFiles || depth > 8) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (!DOC_EXTS.has(path.extname(entry.name).toLowerCase())) continue
        let stat
        try {
          stat = fs.statSync(full)
        } catch {
          continue
        }
        if (stat.mtimeMs > newestMs) {
          newestMs = stat.mtimeMs
          newestPath = full
        }
        if (stat.mtimeMs > sinceMs) files.push(full)
        if (files.length >= maxFiles) return
      }
    }
    for (const root of roots) walk(root, 0)
    return { files, newestMs, newestPath }
  }

  async function freshness(kbRootArg) {
    const kbRoot = resolveKbRoot(kbRootArg)
    const roots = configuredSyncRoots(kbRoot)
    if (roots.length === 0) return { sync_roots: 0, newer_count: 0, indexed_at: null, last_sync_at: null }
    const builtAt = indexBuiltAt(kbRoot)
    const scan = scanNewer(roots, builtAt, 5000)
    return {
      sync_roots: roots.length,
      indexed_at: builtAt ? new Date(builtAt).toISOString() : null,
      index_age_ms: builtAt ? Date.now() - builtAt : null,
      newer_count: scan.files.length,
      newest_path: scan.newestPath,
      newest_at: scan.newestMs ? new Date(scan.newestMs).toISOString() : null,
      last_sync_at: readSyncState(kbRoot).last_sync_at ?? null,
    }
  }

  async function withFreshness(value, rawArgs) {
    if (!value || value.ok !== true) return value
    try {
      return { ...value, ...(await freshness(rawArgs && rawArgs.kb_root)) }
    } catch {
      return value
    }
  }

  async function withStaleWarning(value, rawArgs) {
    if (!value || value.ok !== true) return value
    try {
      const fresh = await freshness(rawArgs && rawArgs.kb_root)
      const warnings = Array.isArray(value.warnings) ? [...value.warnings] : []
      if (fresh.newer_count > 0) {
        warnings.push(
          `index is older than ${fresh.newer_count} changed file(s) across ${fresh.sync_roots} sync root(s); ` +
            'call kb_sync to refresh (kb_search/kb_ask results may be stale)',
        )
      }
      return { ...value, ...fresh, warnings }
    } catch {
      return value
    }
  }

  /** Dump only the changed memory files into the index (no full rebuild). */
  async function runSync(rawArgs, exec) {
    const started = Date.now()
    try {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const kbRoot = resolveKbRoot(args.kb_root)
      const roots = configuredSyncRoots(kbRoot)
      if (roots.length === 0) {
        return {
          ok: false,
          error: {
            code: 'no_sync_roots',
            message:
              'no sync roots configured; set KB_LITE_SYNC_ROOTS (path-delimiter separated) or opts.syncRoots',
          },
        }
      }
      const maxFiles = clampInt(args.max_files, 200, 1, MAX_MAX_FILES)
      const builtAt = indexBuiltAt(kbRoot)
      const scan = scanNewer(roots, builtAt, maxFiles)
      let ingest = null
      if (scan.files.length > 0) {
        const engine = getClient()
        ingest = await engine.request(
          'ingest',
          {
            kb_root: kbRoot,
            paths: scan.files,
            recursive: false,
            force: false,
            prune: args.prune === true,
            max_files: maxFiles,
            with_embeddings: 'auto',
          },
          {
            signal: exec && exec.signal ? exec.signal : undefined,
            timeoutMs: ingestTimeoutMs,
          },
        )
      }
      const finishedAt = new Date().toISOString()
      const state = writeSyncState(kbRoot, {
        last_sync_at: finishedAt,
        last_changed: scan.files.length,
      })
      appendSyncLog(kbRoot, {
        at: finishedAt,
        changed: scan.files.length,
        added: ingest?.added ?? 0,
        updated: ingest?.updated ?? 0,
        skipped: ingest?.skipped ?? 0,
        pending: ingest?.pending ?? 0,
        elapsed_ms: Date.now() - started,
      })
      return {
        ok: true,
        changed: scan.files.length,
        added: ingest?.added ?? 0,
        updated: ingest?.updated ?? 0,
        skipped: ingest?.skipped ?? 0,
        pending: ingest?.pending ?? 0,
        errors: Array.isArray(ingest?.errors) ? ingest.errors : [],
        indexed_at: indexBuiltAt(kbRoot) ? new Date(indexBuiltAt(kbRoot)).toISOString() : null,
        newest_path: scan.newestPath,
        last_sync_at: state.last_sync_at,
        elapsed_ms: Date.now() - started,
      }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  }

  const LAYER_PARAMS = {
    workspace: {
      type: 'string',
      description:
        'Workspace name. Selects the layered layout <kb_root>/<workspace>/_shared and ' +
        '<kb_root>/<workspace>/sessions/<session>. Omit for the legacy flat layout.',
    },
    session: {
      type: 'string',
      description:
        'Session name. kb_ingest writes into <kb_root>/<workspace>/sessions/<session>; ' +
        'kb_search/kb_ask probe that layer first and fall back to the workspace layer.',
    },
  }

  const FALLBACK_PARAM = {
    type: 'boolean',
    description:
      'Only for layered queries: when the session layer has no hits, retry the workspace ' +
      'layer (default true). Set false to stay inside the session layer.',
  }

  const toolDefinitions = [
    {
      name: 'kb_ingest',
      description:
        'Ingest local documents (Markdown, TXT, PDF, DOCX, HTML, JSON) into the kb-lite knowledge base. ' +
        'paths must be absolute; directories are expanded recursively by default. ' +
        'With workspace (and optionally session) documents land in the matching layer directory. ' +
        'Returns counts for added/updated/skipped files plus per-file errors and pending work.',
      output: TOOL_OUTPUT,
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description:
            'Absolute file or directory paths to ingest. Relative paths are rejected (they are only resolved against the home directory to report a useful error).',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
        recursive: {
          type: 'boolean',
          description: 'Recursively expand directory paths (default true).',
        },
        force: {
          type: 'boolean',
          description: 'Re-parse and re-index unchanged files (default false).',
        },
        prune: {
          type: 'boolean',
          description:
            'Remove indexed documents whose files no longer exist under the given paths (default false).',
        },
        max_files: {
          type: 'integer',
          description:
            'Maximum files processed in one call, clamped to 1..500 (default 50). Extra files are reported as pending.',
        },
        chunk_chars: {
          type: 'integer',
          description:
            'Characters per chunk for this ingest, clamped to 200..8000 (default 1200). Changing it re-chunks every indexed document on the next ingest.',
        },
        chunk_overlap: {
          type: 'integer',
          description:
            'Characters shared by neighbouring chunks, clamped to 0..chunk_chars/2 (default 120). Changing it re-chunks every indexed document.',
        },
        with_embeddings: {
          type: 'string',
          description: 'Embedding policy: "auto" (default), "on", or "off".',
        },
      },
      async execute(args, exec) {
        const value = await runTool('ingest', args, exec)
        if (value && value.ok === true) {
          try {
            const scoped = value.scope && typeof value.scope === 'object' ? value.scope : null
            const kbRoot = scoped
              ? scoped.session_root || scoped.shared_root
              : resolveKbRoot(args && args.kb_root)
            const at = new Date().toISOString()
            writeSyncState(kbRoot, { last_ingest_at: at })
            appendSyncLog(kbRoot, {
              at,
              kind: 'ingest',
              added: value.added ?? 0,
              updated: value.updated ?? 0,
              skipped: value.skipped ?? 0,
            })
          } catch {}
        }
        return value
      },
    },
    {
      name: 'kb_search',
      description:
        'Search the kb-lite knowledge base and return ranked chunks with path, heading, line range, score and snippet. ' +
        'Uses BM25 by default and hybrid retrieval when embeddings are available.',
      output: TOOL_OUTPUT,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Search query (Chinese or English).',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
        fallback: FALLBACK_PARAM,
        context: {
          type: 'boolean',
          description:
            'Also return the neighbouring chunk before/after each hit (context.before / context.after), ' +
            'so a caller can judge relevance without a follow-up kb_get (default false).',
        },
        top_k: {
          type: 'integer',
          description: 'Number of hits to return, clamped to 1..50 (default 8).',
        },
        mode: {
          type: 'string',
          description: 'Retrieval mode: auto (default), bm25, dense, or hybrid.',
        },
        section_rerank: {
          type: 'boolean',
          description:
            'After ranking documents, rerank the sections inside each document with the ' +
            '"content" part of the query (document-name tokens such as product codes are ' +
            'stripped), so the answer block wins over boilerplate (default true).',
        },
        weights: {
          type: 'json',
          description:
            'Optional ranking weights: { "bm25": 1.0, "dense": 0.6, "rrf_k": 60, ' +
            '"boost": { "<path substring>": multiplier }, ' +
            '"recency": { "half_life_days": 30, "min": 0.25, "max": 1.0 } }. ' +
            'boost 按最长匹配生效；recency 让旧文档按半衰期衰减。每个命中都带 score_detail 分解。',
        },
        include_superseded: {
          type: 'boolean',
          description:
            'When false (default), documents whose front matter says status: superseded are down-weighted (x0.3). ' +
            'Set true to rank them normally.',
        },
      },
      async execute(args, exec) {
        return withStaleWarning(await runTool('search', args, exec), args)
      },
    },
    {
      name: 'kb_ask',
      description:
        'Retrieve the best evidence passages for a question, returned verbatim with source path, heading, line range and page. ' +
        'Use this before answering questions about documents in the knowledge base.',
      output: TOOL_OUTPUT,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Question or query to retrieve evidence for.',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
        fallback: FALLBACK_PARAM,
        top_k: {
          type: 'integer',
          description: 'Number of evidence passages, clamped to 1..50 (default 5).',
        },
        max_chars: {
          type: 'integer',
          description: 'Total character budget for evidence text (default 6000).',
        },
        weights: {
          type: 'json',
          description:
            'Optional ranking weights, same shape as kb_search: { "bm25", "dense", "rrf_k", ' +
            '"boost": { "<path substring>": multiplier }, "recency": { "half_life_days", "min", "max" } }.',
        },
        include_superseded: {
          type: 'boolean',
          description:
            'When false (default), documents whose front matter says status: superseded are down-weighted (x0.3). ' +
            'Set true to rank them normally.',
        },
      },
      async execute(args, exec) {
        return withStaleWarning(await runTool('ask', args, exec), args)
      },
    },
    {
      name: 'kb_outline',
      description:
        'List what is indexed in the knowledge base: one row per document with path, title, kind, size, ' +
        'chunk count and its heading outline (no content is extracted). Filter by a path/title substring ' +
        'with `query`. Use this to browse a knowledge base before searching, or to find the exact path to ' +
        'pass to kb_get.',
      output: TOOL_OUTPUT,
      parameters: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive substring matched against document paths and titles (e.g. "spec" or "设计").',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
        limit: {
          type: 'integer',
          description: 'Maximum documents to return, clamped to 1..2000 (default 200).',
        },
        include_excluded: {
          type: 'boolean',
          description:
            'Also list documents removed from the index (status "excluded"); ' +
            'use this to find a path for kb_delete restore (default false).',
        },
      },
      async execute(args, exec) {
        return runTool('outline', args, exec)
      },
    },
    {
      name: 'kb_delete',
      description:
        'Remove one document from the index (the file on disk is left untouched). ' +
        'The document is tombstoned, so the background watcher will not re-add it; ' +
        'pass restore: true to clear the tombstone and re-index it. ' +
        'Only the current layer is affected (session when a session is active, otherwise workspace).',
      output: TOOL_OUTPUT,
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path of an indexed document (as shown by kb_outline).',
        },
        restore: {
          type: 'boolean',
          description:
            'Clear the tombstone and ingest the file again instead of removing it (default false).',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
      },
      async execute(args, exec) {
        return runTool('delete', args, exec)
      },
    },
    {
      name: 'kb_get',
      description:
        'Read indexed document text without leaving the knowledge base: pass `path` for the whole document ' +
        '(optionally a 1-based `start_line`/`end_line` range) or `chunk_id` (from kb_search/kb_ask hits) for ' +
        'that chunk. Text comes from the local parsers (Markdown, TXT, PDF, DOCX, HTML, JSON); nothing is ' +
        'generated or sent anywhere.',
      output: TOOL_OUTPUT,
      parameters: {
        path: {
          type: 'string',
          description: 'Absolute path of an indexed document (as shown by kb_outline).',
        },
        chapter: {
          type: 'string',
          description:
            'With `path`: return one chapter/section verbatim (e.g. "第140章", "宣帝纪", "谢安传"). ' +
            'Chapter lines are detected from plain text (第N章/卷/回 and 「…纪/传/志/载记」 headings).',
        },
        chunk_id: {
          type: 'string',
          description:
            'Chunk id from a kb_search/kb_ask hit, shaped "<doc_id>:<ordinal>". Takes precedence over path.',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
        fallback: FALLBACK_PARAM,
        start_line: {
          type: 'integer',
          description: '1-based first line of the document range (default: first line).',
        },
        end_line: {
          type: 'integer',
          description: '1-based last line of the document range, inclusive (default: last line).',
        },
        max_chars: {
          type: 'integer',
          description: 'Maximum characters of text to return, clamped to 200..200000 (default 20000).',
        },
      },
      async execute(args, exec) {
        return runTool('get', args, exec)
      },
    },
    {
      name: 'kb_stats',
      description:
        'Report knowledge-base statistics: document/chunk counts, dense retrieval availability, size, update time, ' +
        'up to 50 indexed paths, plus `orphaned` (indexed but the source file is gone) and `superseded` ' +
        '(Markdown front matter says status: superseded) counts.',
      output: TOOL_OUTPUT,
      parameters: {
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
      },
      async execute(args, exec) {
        return withFreshness(await runTool('stats', args, exec), args)
      },
    },
    {
      name: 'kb_sync',
      description:
        'Refresh the knowledge base from the configured memory roots: scans them for files changed since the ' +
        'index was built and ingests only those (no full rebuild). Reports changed/added/updated counts and ' +
        'appends one line to sync-log.jsonl, which the weekly audit reads. Roots come from KB_LITE_SYNC_ROOTS ' +
        '(path-delimiter separated) or the plugin config; the index is derived data, the roots stay authoritative.',
      output: TOOL_OUTPUT,
      parameters: {
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        max_files: {
          type: 'integer',
          description: 'Maximum changed files to ingest in this call, clamped to 1..500 (default 200).',
        },
        prune: {
          type: 'boolean',
          description: 'Also drop indexed documents whose files no longer exist under the sync roots (default false).',
        },
      },
      async execute(args, exec) {
        return runSync(args, exec)
      },
    },
    {
      name: 'kb_clear',
      description:
        'Delete every document and index file in the kb-lite knowledge base. Requires confirm: true.',
      output: TOOL_OUTPUT,
      parameters: {
        confirm: {
          type: 'boolean',
          description: 'Must be true; otherwise the tool refuses to clear the knowledge base.',
        },
        kb_root: {
          type: 'string',
          description:
            'Absolute knowledge-base directory. Defaults to KB_LITE_ROOT or ~/.kb-lite.',
        },
        ...LAYER_PARAMS,
        scope: {
          type: 'string',
          description:
            'Layered layout only: which layer to clear — "session" (default), "workspace", or "all".',
        },
      },
      async execute(args, exec) {
        return runTool('clear', args, exec)
      },
    },
  ]

  for (const definition of toolDefinitions) {
    ctx.tools.register(defineTool(definition))
  }

  // --- settings page API ------------------------------------------------------
  // The settings page only needs two things: "which files are indexed" and
  // "remove this one". Both are answered from manifests, never from search, so
  // the page keeps working even when the index is empty.
  const ROUTE_PREFIX = '/api/pure-search'

  function jsonResponse(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readJsonBody(req, limit = 32 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('request body too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text === '') return {}
    return JSON.parse(text)
  }

  /** Every index root under the base: `<ws>/_shared` and `<ws>/sessions/<name>`. */
  function indexRoots(base) {
    const roots = []
    let entries
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      return roots
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const wsDir = path.join(base, entry.name)
      const shared = path.join(wsDir, '_shared')
      if (fs.existsSync(path.join(shared, 'manifest.json'))) {
        roots.push({ workspace: entry.name, session: '', root: shared, layer: 'workspace' })
      }
      let sessions
      try {
        sessions = fs.readdirSync(path.join(wsDir, 'sessions'), { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const root = path.join(wsDir, 'sessions', session.name)
        if (fs.existsSync(path.join(root, 'manifest.json'))) {
          roots.push({ workspace: entry.name, session: session.name, root, layer: 'session' })
        }
      }
    }
    return roots
  }

  async function handleSettingsApi(req, res) {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'request path cannot be parsed' })
      return
    }
    const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (route === '/docs' && (method === 'GET' || method === 'HEAD')) {
        const base = defaultKbRoot()
        const docs = []
        for (const root of indexRoots(base)) {
          let result
          try {
            result = await getClient().request('outline', { kb_root: root.root, limit: 2000 }, { timeoutMs })
          } catch {
            continue
          }
          for (const doc of result.docs || []) {
            docs.push({
              name: path.basename(String(doc.path || '')),
              title: doc.title || '',
              path: doc.path,
              layer: root.layer,
              workspace: root.workspace,
              session: root.session,
              kind: doc.kind || '',
              chunks: doc.chunks ?? 0,
            })
          }
        }
        docs.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
        jsonResponse(res, 200, { ok: true, docs, base })
        return
      }
      if (route === '/delete' && method === 'POST') {
        const body = await readJsonBody(req)
        const targetPath = typeof body.path === 'string' ? body.path.trim() : ''
        if (!targetPath) {
          jsonResponse(res, 400, { ok: false, error: 'path is required' })
          return
        }
        const base = defaultKbRoot()
        const workspace = sanitizeSegment(typeof body.workspace === 'string' ? body.workspace : '')
        const session = sanitizeSegment(typeof body.session === 'string' ? body.session : '')
        if (!workspace) {
          jsonResponse(res, 400, { ok: false, error: 'workspace is required' })
          return
        }
        const root = session
          ? path.join(base, workspace, 'sessions', session)
          : path.join(base, workspace, '_shared')
        if (!path.resolve(root).startsWith(`${path.resolve(base)}${path.sep}`)) {
          jsonResponse(res, 400, { ok: false, error: 'invalid workspace or session' })
          return
        }
        const result = await getClient().request(
          'delete',
          { kb_root: root, path: targetPath, restore: body.restore === true },
          { timeoutMs },
        )
        const payload = result && typeof result === 'object' ? result : {}
        jsonResponse(res, 200, { ok: true, ...payload })
        return
      }
      jsonResponse(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      })
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        if (!scoped || !scoped.webServer || typeof scoped.webServer.register !== 'function') return
        if (typeof scoped.effect !== 'function') return
        scoped.effect(
          () =>
            scoped.webServer.register({
              kind: 'prefix',
              path: ROUTE_PREFIX,
              handler: handleSettingsApi,
            }),
          'dsh-pure-search: settings api',
        )
      })
    } catch {
      // Older hosts do not expose ctx.inject; the tools still work, the page
      // is simply absent.
    }
  }

  let watchTimer = null
  let warmTimer = null
  const watchIntervalMs = Number.isFinite(options.watchIntervalMs)
    ? Math.max(5000, options.watchIntervalMs)
    : 30_000
  if (options.watch !== false) {
    watchTimer = setInterval(() => {
      if (disposed) return
      getClient()
        .request('watch', { kb_root: defaultKbRoot() }, { timeoutMs: Math.max(timeoutMs, 60_000) })
        .catch(() => {})
    }, watchIntervalMs)
    if (typeof watchTimer.unref === 'function') watchTimer.unref()
  }

  // Spawn the interpreter before the first real tool call: ~200 ms of Python
  // startup otherwise lands on the user's first query.
  warmTimer = setTimeout(() => {
    if (disposed) return
    const engine = getClient()
    engine
      .request('ping', {}, { timeoutMs })
      .then(() => engine.request('warmup', { wait: false }, { timeoutMs }))
      .catch(() => {})
  }, 300)
  if (typeof warmTimer.unref === 'function') warmTimer.unref()

  function dispose() {
    if (disposed) return
    disposed = true
    if (watchTimer) clearInterval(watchTimer)
    if (warmTimer) clearTimeout(warmTimer)
    if (!client) return
    const closing = client
    client = null
    return closing.close()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      const pending = dispose()
      if (pending && typeof pending.then === 'function') pending.catch(() => {})
    })
  }

  return dispose
}
