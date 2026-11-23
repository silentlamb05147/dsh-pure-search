import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPlugin } from '../lib/plugin.js'

// End-to-end test of the settings HTTP API without a DSH host: the plugin is
// mounted with stub ctx objects, its tools are used to build a real index, and
// every route is then exercised against that index.

const root = path.resolve(import.meta.dirname, '..')
const fwd = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase()
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-search-http-'))
const workspace = 'ws-http'
let failures = 0
let checks = 0

function check(name, fn) {
  checks++
  try {
    fn()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failures++
    process.stdout.write(`FAIL ${name}\n     ${error && error.message ? error.message : error}\n`)
  }
}

const definitions = new Map()
let handler = null

const ctx = {
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
    },
  },
  effect() {},
  inject(names, factory) {
    if (!names.includes('webServer')) return
    factory({
      webServer: {
        register(entry) {
          handler = entry.handler
        },
      },
      effect(fn) {
        fn()
      },
    })
  },
}

const dispose = applyPlugin(ctx, (definition) => definition, {
  projectRoot: root,
  kbRoot: base,
  watch: false,
  autoWorkspace: false,
  workspace,
})

function parse(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

async function tool(name, args) {
  const definition = definitions.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return parse(await definition.execute(args, {}))
}

async function call(method, route, body) {
  assert.ok(handler, 'settings handler is registered')
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: `/api/pure-search${route}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(value) {
      payload = String(value)
    },
  }
  await handler(req, res)
  return { status, body: payload === '' ? null : JSON.parse(payload) }
}

function writeDoc(name, text) {
  const file = path.join(base, 'docs', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

try {
  const alpha = writeDoc('alpha.md', '# 阿尔法\n\n阿尔法项目的退款窗口是 13 天，负责人阿岚。\n')
  const beta = writeDoc('beta.md', '# 贝塔\n\n贝塔项目的退款窗口是 7 天，负责人老周。\n')

  const ingest = await tool('kb_ingest', { paths: [alpha, beta], workspace, kb_root: base })
  check('ingest two files', () => assert.equal(ingest.ok, true))

  const docs = await call('GET', '/docs')
  check('docs lists both files', () => {
    assert.equal(docs.status, 200)
    assert.equal(docs.body.ok, true)
    assert.equal(docs.body.docs.length, 2)
  })

  const createFolder = await call('POST', '/folder', { action: 'create', path: '小说/两界' })
  check('create nested folder', () => assert.equal(createFolder.body.ok, true))

  const folders = await call('GET', '/folders')
  check('folders tree contains parents', () => {
    const paths = folders.body.folders.map((item) => item.path)
    assert.ok(paths.includes('小说'))
    assert.ok(paths.includes('小说/两界'))
  })

  const move = await call('POST', '/move', { paths: [alpha], category: '小说/两界' })
  check('move one file into folder', () => assert.equal(move.body.ok, true))

  const afterMove = await call('GET', '/docs')
  check('docs show the new category', () => {
    const doc = afterMove.body.docs.find((item) => fwd(item.path) === fwd(alpha))
    assert.ok(doc, 'moved document is still listed')
    assert.equal(doc.category, '小说/两界')
  })

  const folderCount = await call('GET', '/folders')
  check('folder count reflects the move', () => {
    const node = folderCount.body.folders.find((item) => item.path === '小说/两界')
    assert.equal(node.count, 1)
  })

  const nonEmptyDelete = await call('POST', '/folder', { action: 'delete', path: '小说/两界' })
  check('non-empty folder delete is refused', () => {
    assert.equal(nonEmptyDelete.status, 409)
    assert.match(nonEmptyDelete.body.error, /还有 1 个文件/)
  })

  const rename = await call('POST', '/folder', { action: 'rename', path: '小说', newPath: '书籍' })
  check('rename folder rewrites categories', () => assert.equal(rename.body.ok, true))

  const afterRename = await call('GET', '/docs')
  check('renamed category is visible on docs', () => {
    const doc = afterRename.body.docs.find((item) => fwd(item.path) === fwd(alpha))
    assert.ok(doc, 'renamed document is still listed')
    assert.equal(doc.category, '书籍/两界')
  })

  const invalid = await call('POST', '/folder', { action: 'create', path: 'a/../b' })
  check('invalid folder name rejected', () => assert.equal(invalid.status, 400))

  const trash = await call('POST', '/delete', { path: alpha })
  check('delete moves doc to trash', () => {
    assert.equal(trash.body.ok, true)
    assert.equal(trash.body.deleted?.[0]?.trashed, true)
  })

  const afterTrash = await call('GET', '/docs')
  check('trashed doc leaves the list', () => {
    assert.ok(!afterTrash.body.docs.some((item) => fwd(item.path) === fwd(alpha)))
  })

  const trashList = await call('GET', '/trash')
  check('trash lists the removed doc', () => {
    assert.equal(trashList.body.items.length, 1)
    assert.equal(fwd(trashList.body.items[0].path), fwd(alpha))
  })

  const searchAfterTrash = await tool('kb_search', { query: '阿尔法 退款', workspace, kb_root: base, top_k: 3 })
  check('search cannot see trashed doc', () => {
    const hits = searchAfterTrash.result?.hits || searchAfterTrash.hits || []
    assert.ok(!hits.some((hit) => fwd(hit.path) === fwd(alpha)))
  })

  const restore = await call('POST', '/restore', { path: alpha })
  check('restore brings the doc back', () => assert.equal(restore.body.ok, true))

  const afterRestore = await call('GET', '/docs')
  check('restored doc is listed again', () => {
    assert.ok(afterRestore.body.docs.some((item) => fwd(item.path) === fwd(alpha)))
  })

  const trashAgain = await call('POST', '/delete', { path: alpha })
  check('trash again works', () => assert.equal(trashAgain.body.ok, true))

  const purgeOne = await call('POST', '/purge', { path: alpha })
  check('purge one removes its trash entry', () => assert.equal(purgeOne.body.ok, true))

  const trashAfterPurge = await call('GET', '/trash')
  check('trash is empty after purge', () => assert.equal(trashAfterPurge.body.items.length, 0))

  const unknown = await call('POST', '/delete', { path: path.join(base, 'docs', 'missing.md') })
  check('deleting an unknown path is 404', () => assert.equal(unknown.status, 404))

  const purgeAll = await call('POST', '/purge', { all: true })
  check('purge all succeeds', () => assert.equal(purgeAll.body.ok, true))

  const noMissing = await call('POST', '/delete-missing', {})
  check('delete-missing with no missing docs is a no-op', () => {
    assert.equal(noMissing.body.ok, true)
    assert.equal(noMissing.body.removed, 0)
    assert.deepEqual(noMissing.body.results, [])
  })

  const badRoute = await call('GET', '/nope')
  check('unknown route is 404', () => assert.equal(badRoute.status, 404))

  check('disk files were never touched', () => {
    assert.ok(fs.existsSync(alpha))
    assert.ok(fs.existsSync(beta))
    assert.ok(fs.readFileSync(alpha, 'utf8').includes('13 天'))
  })
} finally {
  await Promise.resolve(dispose())
  fs.rmSync(base, { recursive: true, force: true })
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) process.exit(1)
