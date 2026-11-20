#!/usr/bin/env node
/**
 * Builds the WhatsOps packages for one system. Runs on GitHub Actions (see .github/workflows/packages.yml)
 * after `npm ci && npm run build && npm prune --omit=dev`, on a runner of the target system:
 *
 *   node packaging/build.mjs <macos|windows|linux> <x64|arm64>
 *
 * Everything goes to out/upload/:
 *   whatsops-<v>-runtime-<os>-<arch>.tar.gz (+ .sha256)  Node + WhatsOps; used by the auto-update and the Linux scripts
 *   WhatsOps-<v>-macos-<arch>.zip                          WhatsOps.app (macOS)
 *   WhatsOps-<v>-windows-<arch>.zip                        WhatsOps folder with WhatsOps.vbs (Windows)
 *
 * Before packing, the staged runtime is started once (smoke test): it must answer /healthz.
 */
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [platform, arch] = process.argv.slice(2)
if (!['macos', 'windows', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  console.error('usage: node packaging/build.mjs <macos|windows|linux> <x64|arm64>')
  process.exit(2)
}
if (process.arch !== arch) throw new Error(`this runner is ${process.arch}, not ${arch}`)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VER = pkg.version
const OUT = path.join(ROOT, 'out')
const STAGE = path.join(OUT, 'stage')
const UPLOAD = path.join(OUT, 'upload')
const win = platform === 'windows'
const log = (...a) => console.log('[package]', ...a)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts, env: { ...process.env, COPYFILE_DISABLE: '1', ...(opts.env ?? {}) } })
// Windows: always bsdtar from System32 (Git's GNU tar reads "C:" as a remote host and cannot write zip)
const TAR = win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

if (process.env.TAG && process.env.TAG.replace(/^v/, '') !== VER) throw new Error(`tag ${process.env.TAG} but package.json says ${VER}`)
if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) throw new Error('dist/ missing: run npm run build first')
if (fs.existsSync(path.join(ROOT, 'node_modules', 'typescript'))) throw new Error('dev dependencies present: run npm prune --omit=dev first')

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(UPLOAD, { recursive: true })

// ---- 1. runtime: node + app
log(`WhatsOps ${VER} for ${platform}-${arch}, Node ${process.version}`)
const nodeDir = path.join(STAGE, 'node')
const nodeBin = win ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node')
fs.mkdirSync(path.dirname(nodeBin), { recursive: true })
fs.copyFileSync(process.execPath, nodeBin)
fs.chmodSync(nodeBin, 0o755)
for (const l of [path.join(path.dirname(process.execPath), '..', 'LICENSE'), path.join(path.dirname(process.execPath), 'LICENSE')]) {
  if (fs.existsSync(l)) {
    fs.copyFileSync(l, path.join(nodeDir, 'LICENSE'))
    break
  }
}

const SKIP_DIRS = new Set(['.bin', '.github', 'test', 'tests', '__tests__', '.cache'])
const SKIP_FILE = /\.(md|markdown|map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/i
const filter = (src) => {
  const base = path.basename(src)
  const inModules = src.includes(`${path.sep}node_modules${path.sep}`)
  if (inModules && SKIP_DIRS.has(base) && fs.statSync(src).isDirectory()) return false
  if (inModules && SKIP_FILE.test(base) && !/^license/i.test(base)) return false
  return true
}
const appDir = path.join(STAGE, 'app')
for (const item of ['dist', 'public', 'assets', 'packaging/icons', 'packaging/windows', 'install', 'node_modules', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
  const src = path.join(ROOT, item)
  if (!fs.existsSync(src)) continue
  fs.cpSync(src, path.join(appDir, item), { recursive: true, filter, verbatimSymlinks: true })
}

// ---- 2. smoke test: the staged runtime must start and answer
await smoke()

// ---- 3. runtime archive (auto-update + Linux)
const runtimeName = `whatsops-${VER}-runtime-${platform}-${arch}.tar.gz`
run(TAR, ['-czf', path.join(UPLOAD, runtimeName), 'node', 'app'], { cwd: STAGE })
writeSha(path.join(UPLOAD, runtimeName))

// ---- 4. the package for people
if (platform === 'macos') buildMac()
if (platform === 'windows') buildWindows()
for (const f of fs.readdirSync(UPLOAD)) log(`${f}  ${(fs.statSync(path.join(UPLOAD, f)).size / 1048576).toFixed(1)} MB`)

function writeSha(file) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(`${file}.sha256`, `${h}  ${path.basename(file)}\n`)
}

async function smoke() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-smoke-'))
  const port = 18810 + Math.floor(Math.random() * 500)
  const child = spawn(nodeBin, [path.join(appDir, 'dist', 'main.js')], {
    env: { ...process.env, WA_DATA_DIR: data, WA_PORT: String(port), WA_HOST: '127.0.0.1', WA_UPDATE_INTERVAL_MIN: '600', WA_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  let ok = null
  for (let i = 0; i < 90 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) break
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (r.ok) ok = await r.json()
    } catch {
      /* not up yet */
    }
  }
  // the database (native module) must work too: the sign-in link writes to it
  let link = ''
  if (ok) link = execFileSync(nodeBin, [path.join(appDir, 'dist', 'cli.js'), 'login-link', '--local'], { env: { ...process.env, WA_DATA_DIR: data, WA_PORT: String(port) } }).toString().trim()
  child.kill()
  await new Promise((r) => setTimeout(r, 1500))
  fs.rmSync(data, { recursive: true, force: true })
  if (!ok || ok.version !== VER) throw new Error(`smoke test failed: ${JSON.stringify(ok)}`)
  if (!/^http:\/\/127\.0\.0\.1:\d+\/login\?t=/.test(link)) throw new Error(`smoke test failed: login link ${link}`)
  log(`smoke test ok: ${JSON.stringify(ok)}`)
}

function buildMac() {
  const app = path.join(OUT, 'WhatsOps.app')
  const C = path.join(app, 'Contents')
  fs.mkdirSync(path.join(C, 'MacOS'), { recursive: true })
  fs.mkdirSync(path.join(C, 'Resources'), { recursive: true })
  fs.writeFileSync(path.join(C, 'Info.plist'), fs.readFileSync(path.join(ROOT, 'packaging/macos/Info.plist'), 'utf8').replaceAll('{{VERSION}}', VER))
  fs.copyFileSync(path.join(ROOT, 'packaging/macos/launcher.sh'), path.join(C, 'MacOS', 'WhatsOps'))
  fs.chmodSync(path.join(C, 'MacOS', 'WhatsOps'), 0o755)
  fs.copyFileSync(path.join(ROOT, 'packaging/icons/WhatsOps.icns'), path.join(C, 'Resources', 'WhatsOps.icns'))
  // the runtime travels inside the app; the launcher copies it to ~/Library/Application Support
  run('ditto', [STAGE, path.join(C, 'Resources', 'runtime')])
  fs.writeFileSync(path.join(C, 'Resources', 'runtime', 'VERSION'), VER)
  // ad-hoc signature (no Apple developer account): Apple Silicon needs every binary signed
  try {
    run('codesign', ['--force', '--sign', '-', app])
  } catch {
    log('signing the bundle failed: signing each binary first')
    const files = execFileSync('find', [path.join(C, 'Resources', 'runtime'), '-type', 'f', '(', '-name', '*.node', '-o', '-name', '*.dylib', ')']).toString().split('\n').filter(Boolean)
    for (const f of files) run('codesign', ['--force', '--sign', '-', f])
    run('codesign', ['--force', '--sign', '-', app])
  }
  run('codesign', ['--verify', '--verbose=2', app])
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(UPLOAD, `WhatsOps-${VER}-macos-${arch}.zip`)])
}

function buildWindows() {
  const dir = path.join(OUT, 'WhatsOps')
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(STAGE, path.join(dir, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'runtime', 'VERSION'), VER)
  fs.copyFileSync(path.join(ROOT, 'packaging/windows/WhatsOps.vbs'), path.join(dir, 'WhatsOps.vbs'))
  fs.copyFileSync(path.join(ROOT, 'packaging/icons/WhatsOps.ico'), path.join(dir, 'WhatsOps.ico'))
  fs.writeFileSync(path.join(dir, 'README.txt'), fs.readFileSync(path.join(ROOT, 'packaging/windows/README.txt'), 'utf8').replaceAll('{{VERSION}}', VER))
  // bsdtar (C:\Windows\System32\tar.exe) writes zip files with -a
  run(TAR, ['-a', '-cf', path.join(UPLOAD, `WhatsOps-${VER}-windows-${arch}.zip`), 'WhatsOps'], { cwd: OUT })
}
