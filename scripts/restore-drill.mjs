// Restore the pre-fork backup into a throwaway directory and verify it is usable.
// Usage: node scripts/restore-drill.mjs [--backup <dir>] [--keep]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const backupFlag = args.indexOf('--backup')
const backup =
  backupFlag >= 0 && args[backupFlag + 1]
    ? path.resolve(args[backupFlag + 1])
    : process.env.KB_LITE_BACKUP
      ? path.resolve(process.env.KB_LITE_BACKUP)
      : null

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-search-restore-'))
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

if (!backup) {
  console.log('skip restore drill: pass --backup <dir> or set KB_LITE_BACKUP')
  console.log('FAIL restore drill (no backup given)')
  process.exit(1)
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}

try {
  check('backup exists', fs.existsSync(backup), backup)
  if (!fs.existsSync(backup)) throw new Error('backup missing')

  const pluginSource = path.join(backup, 'dsh-kb-lite')
  const indexSource = path.join(backup, 'kb-index-snapshot')
  const pluginTarget = path.join(work, 'plugin')
  const indexTarget = path.join(work, 'index')
  copyTree(pluginSource, pluginTarget)
  copyTree(indexSource, indexTarget)

  for (const file of [
    'package.json',
    'lib/plugin.js',
    'lib/index.js',
    'engine/kb_engine.py',
    'cordis.patch.yml',
  ]) {
    check(`plugin file ${file}`, fs.existsSync(path.join(pluginTarget, file)))
  }

  let workspaces = 0
  let docs = 0
  let chunks = 0
  for (const entry of fs.readdirSync(indexTarget, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    workspaces += 1
    for (const root of walkManifests(path.join(indexTarget, entry.name))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
      docs += Object.keys(manifest.docs || {}).length
      const chunkFile = path.join(root, 'chunks.jsonl')
      if (fs.existsSync(chunkFile)) {
        chunks += fs.readFileSync(chunkFile, 'utf8').split('\n').filter(Boolean).length
      }
    }
  }
  check('index snapshot has workspaces', workspaces > 0, `${workspaces}`)
  check('index snapshot has documents', docs > 0, `${docs} docs / ${chunks} chunks`)

  console.log(`\nrestore target: ${work}`)
  console.log(`${failures === 0 ? 'PASS' : 'FAIL'} restore drill (${failures} failure(s))`)
} finally {
  if (!keep) fs.rmSync(work, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)

function walkManifests(dir, depth = 0) {
  const found = []
  if (!fs.existsSync(dir) || depth > 4) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === 'manifest.json') found.push(dir)
    else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      found.push(...walkManifests(full, depth + 1))
    }
  }
  return [...new Set(found)]
}
