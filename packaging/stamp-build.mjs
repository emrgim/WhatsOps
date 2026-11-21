// Writes dist/build.json with the git commit this build comes from (run by `npm run build`).
// The version people see is `<version> beta (build <commit>)`; a `+` after the commit means the
// build has changes that are not committed.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
let build = ''
try {
  build = git('rev-parse', '--short=7', 'HEAD')
  if (git('status', '--porcelain', '--untracked-files=no')) build += '+'
} catch {
  build = (process.env.GITHUB_SHA || '').slice(0, 7)
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
fs.writeFileSync(path.join(root, 'dist', 'build.json'), JSON.stringify({ build: build || 'dev', at: new Date().toISOString() }) + '\n')
console.log(`build ${build || 'dev'}`)
