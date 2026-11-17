// Check whether upstream has commits we have not merged yet.
// Usage: node scripts/check-upstream.mjs [--fetch]
// Exit 0 = up to date, 1 = behind (merge/review needed), 2 = command failure.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fetch = process.argv.includes('--fetch')
const run = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

function fail(message) {
  console.error(message)
  process.exit(2)
}

const remote = run(['remote', 'get-url', 'upstream'])
if (remote.status !== 0) {
  fail('no "upstream" remote configured; add one with: git remote add upstream <url>')
}

if (fetch) {
  const fetched = run(['fetch', 'upstream', '--tags', '--prune'])
  if (fetched.status !== 0) fail(fetched.stderr || 'git fetch upstream failed')
}

const counts = run(['rev-list', '--left-right', '--count', 'main...upstream/master'])
if (counts.status !== 0) fail(counts.stderr || 'cannot compare with upstream/master')
const [ahead, behind] = String(counts.stdout).trim().split(/\s+/).map(Number)

const tag = run(['describe', '--tags', '--abbrev=0', 'upstream/master'])
const latestTag = tag.status === 0 ? tag.stdout.trim() : '(no tag)'

console.log(`fork ahead:  ${ahead}`)
console.log(`fork behind: ${behind}`)
console.log(`upstream latest tag: ${latestTag}`)

if (behind > 0) {
  const log = run(['log', '--oneline', 'main..upstream/master'])
  console.log('\nUnmerged upstream commits:')
  console.log(log.status === 0 ? log.stdout.trim() : '(git log failed)')
  console.log('\nReview with: git merge upstream/master  (see UPSTREAM-DIFF.md)')
  process.exit(1)
}

console.log('\nUp to date.')
process.exit(0)
