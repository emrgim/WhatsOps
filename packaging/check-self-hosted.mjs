// WhatsOps is self-hosted: nothing in the code, the pages, the installers or the docs may point at
// one particular installation. Each WhatsOps works with the address it is opened at, or the one its
// owner sets (Settings → General → Public URL / WA_PUBLIC_URL); examples use whatsops.example.com.
//
//   node packaging/check-self-hosted.mjs     → exit 1 and the lines found, if any
//
// Run by the tests and by the release workflow before the installers are built.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// addresses of real installations (written in pieces so this file does not match itself)
const FORBIDDEN = [new RegExp(['[a-z0-9-]*\\.?', 'mrg', '\\.', 'im\\b'].join(''), 'i')]
const DIRS = ['src', 'public', 'install', 'packaging', 'deploy', 'assets', 'test', '.github', 'dist']
const FILES = ['README.md', '.env.example', 'package.json']
const BINARY = /\.(png|ico|icns|jpe?g|gif|webp|woff2?|ttf|otf|dmg|exe|zip|gz|tgz|db|sqlite|ogg|mp3|mp4)$/i

export function findHostedAddresses(root) {
  const hits = []
  const scan = (file) => {
    if (BINARY.test(file)) return
    const buf = fs.readFileSync(file)
    if (buf.includes(0)) return
    buf
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 160)}`)
      })
  }
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'out') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) scan(p)
    }
  }
  for (const d of DIRS) walk(path.join(root, d))
  for (const f of FILES) if (fs.existsSync(path.join(root, f))) scan(path.join(root, f))
  return hits
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const hits = findHostedAddresses(root)
  if (hits.length) {
    console.error(`WhatsOps is self-hosted: remove the address of a real installation (use whatsops.example.com in examples):\n${hits.join('\n')}`)
    process.exit(1)
  }
  console.log('no installation address in the code, pages, installers or docs')
}
