#!/usr/bin/env node
/**
 * Builds the WhatsOps installers for one system. Runs on GitHub Actions (see .github/workflows/packages.yml)
 * after `npm ci && npm run build && npm prune --omit=dev`, on a runner of the target system:
 *
 *   node packaging/build.mjs <macos|windows|linux> <x64|arm64>
 *
 * Everything goes to out/upload/:
 *   WhatsOps-<v>-macos-<arch>.dmg                          macOS: WhatsOps.app, drag it to Applications
 *   WhatsOps-<v>-windows-<arch>-setup.exe                  Windows: setup (per user, no admin), uninstaller in Settings → Apps
 *   WhatsOps-<v>-linux-<arch>.deb / .rpm                   Linux: Debian/Ubuntu and Fedora/openSUSE packages (command: whatsops)
 *   whatsops-<v>-runtime-<os>-<arch>.tar.gz (+ .sha256)    Node + WhatsOps: used by the auto-update and install/linux.sh
 *
 * Before packing, the staged runtime is started once (smoke test): it must answer /healthz.
 * With WHATSOPS_INSTALL_TEST=1 (CI only: it installs on this machine) every installer is then installed,
 * started, killed (it must come back by itself) and uninstalled.
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
const TEST = process.env.WHATSOPS_INSTALL_TEST === '1'
const log = (...a) => console.log('[package]', ...a)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts, env: { ...process.env, COPYFILE_DISABLE: '1', ...(opts.env ?? {}) } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

// ---- 3. runtime archive (auto-update + install/linux.sh)
const runtimeName = `whatsops-${VER}-runtime-${platform}-${arch}.tar.gz`
run(TAR, ['-czf', path.join(UPLOAD, runtimeName), 'node', 'app'], { cwd: STAGE })
writeSha(path.join(UPLOAD, runtimeName))

// ---- 4. the installers for people
if (platform === 'macos') await buildMac()
if (platform === 'windows') await buildWindows()
if (platform === 'linux') await buildLinux()
for (const f of fs.readdirSync(UPLOAD)) log(`${f}  ${(fs.statSync(path.join(UPLOAD, f)).size / 1048576).toFixed(1)} MB`)

function writeSha(file) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(`${file}.sha256`, `${h}  ${path.basename(file)}\n`)
}

async function health(port = 8810) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}
async function waitHealth(want, secs = 120, port = 8810) {
  for (let i = 0; i < secs; i++) {
    const h = await health(port)
    if (want ? h?.version === VER : !h) return h ?? true
    await sleep(1000)
  }
  throw new Error(want ? `WhatsOps ${VER} is not answering on ${port}` : `WhatsOps still answers on ${port}`)
}
function readPid(dataDir) {
  return Number(fs.readFileSync(path.join(dataDir, 'service.lock'), 'utf8').trim() || 0)
}
/** Kill WhatsOps: the system service must start it again by itself. */
async function killAndCheckRestart(dataDir, kill) {
  const pid = readPid(dataDir)
  if (!pid) throw new Error('no service.lock')
  kill(pid)
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const h = await health()
    let now = 0
    try {
      now = readPid(dataDir)
    } catch {
      /* restarting */
    }
    if (h?.version === VER && now && now !== pid) return log(`install test: killed ${pid}, started again as ${now}`)
  }
  throw new Error('WhatsOps did not start again by itself')
}
function checkLink(out) {
  const url = out.toString().trim().split(/\s+/).pop()
  if (!/^http:\/\/127\.0\.0\.1:8810\/login\?t=/.test(url)) throw new Error(`no sign-in link: ${out}`)
  log(`install test: sign-in link ok`)
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
    await sleep(1000)
    if (child.exitCode !== null) break
    ok = await health(port)
  }
  // the database (native module) must work too: the sign-in link writes to it
  let link = ''
  if (ok) link = execFileSync(nodeBin, [path.join(appDir, 'dist', 'cli.js'), 'login-link', '--local'], { env: { ...process.env, WA_DATA_DIR: data, WA_PORT: String(port) } }).toString().trim()
  child.kill()
  await sleep(1500)
  fs.rmSync(data, { recursive: true, force: true })
  if (!ok || ok.version !== VER) throw new Error(`smoke test failed: ${JSON.stringify(ok)}`)
  if (!/^http:\/\/127\.0\.0\.1:\d+\/login\?t=/.test(link)) throw new Error(`smoke test failed: login link ${link}`)
  log(`smoke test ok: ${JSON.stringify(ok)}`)
}

// ------------------------------------------------------------------ macOS: WhatsOps.app in a .dmg
async function buildMac() {
  const dmgDir = path.join(OUT, 'dmg')
  const app = path.join(dmgDir, 'WhatsOps.app')
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
  // the disk image: the app and a shortcut to Applications, to drag it there
  fs.symlinkSync('/Applications', path.join(dmgDir, 'Applications'))
  const dmg = path.join(UPLOAD, `WhatsOps-${VER}-macos-${arch}.dmg`)
  for (let i = 1; ; i++) {
    try {
      run('hdiutil', ['create', '-volname', `WhatsOps ${VER}`, '-srcfolder', dmgDir, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg])
      break
    } catch (e) {
      if (i === 3) throw e
      log('hdiutil failed, trying again') // "Resource busy" happens on CI runners
      await sleep(5000)
    }
  }
  if (TEST) await testMac(dmg)
}

async function testMac(dmg) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-dmg-'))
  run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mnt])
  const dest = path.join(os.homedir(), 'Applications', 'WhatsOps.app')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  run('ditto', [path.join(mnt, 'WhatsOps.app'), dest])
  run('hdiutil', ['detach', mnt])
  // what a double click runs: installs the LaunchAgent, starts WhatsOps, gives the sign-in link
  checkLink(execFileSync(path.join(dest, 'Contents', 'MacOS', 'WhatsOps'), { env: { ...process.env, WHATSOPS_NO_BROWSER: '1' }, timeout: 240_000 }))
  await waitHealth(true)
  log(`install test: ${dest} → WhatsOps ${VER} running`)
  const data = path.join(os.homedir(), 'Library', 'Application Support', 'mcp-mrg-whatsops')
  await killAndCheckRestart(data, (pid) => process.kill(pid, 'SIGKILL'))
  // opened again: already installed, just the link
  checkLink(execFileSync(path.join(dest, 'Contents', 'MacOS', 'WhatsOps'), { env: { ...process.env, WHATSOPS_NO_BROWSER: '1' }, timeout: 120_000 }))
  const uid = process.getuid()
  for (const d of [`gui/${uid}`, `user/${uid}`]) {
    try {
      execFileSync('launchctl', ['bootout', `${d}/im.mrg.whatsops`], { stdio: 'ignore' })
    } catch {
      /* not in this domain */
    }
  }
  await waitHealth(false, 30)
  log('install test: macOS ok')
}

// ------------------------------------------------------------------ Windows: setup.exe (Inno Setup)
async function buildWindows() {
  const dir = path.join(OUT, 'WhatsOps')
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(STAGE, path.join(dir, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'runtime', 'VERSION'), VER)
  for (const f of ['WhatsOps.vbs', 'uninstall.vbs']) fs.copyFileSync(path.join(ROOT, 'packaging/windows', f), path.join(dir, f))
  fs.copyFileSync(path.join(ROOT, 'packaging/icons/WhatsOps.ico'), path.join(dir, 'WhatsOps.ico'))
  const iscc = findIscc()
  const name = `WhatsOps-${VER}-windows-${arch}-setup`
  run(iscc, ['/Q', `/DAppVer=${VER}`, `/DSrc=${dir}`, `/DOutDir=${UPLOAD}`, `/DOutName=${name}`, path.join(ROOT, 'packaging/windows/WhatsOps.iss')])
  if (TEST) await testWindows(path.join(UPLOAD, `${name}.exe`))
}

function findIscc() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  const find = () => pf.map((p) => path.join(p, 'Inno Setup 6', 'ISCC.exe')).find((p) => fs.existsSync(p))
  let iscc = find()
  if (!iscc) {
    log('Inno Setup not found: installing it')
    run('choco', ['install', 'innosetup', '-y', '--no-progress'])
    iscc = find()
  }
  if (!iscc) throw new Error('Inno Setup (ISCC.exe) not found')
  return iscc
}

async function testWindows(setup) {
  run(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(OUT, 'setup.log')}`])
  const appDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'WhatsOps')
  for (const f of ['WhatsOps.vbs', 'unins000.exe', 'runtime\\node\\node.exe']) if (!fs.existsSync(path.join(appDir, f))) throw new Error(`setup did not install ${f}`)
  const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WhatsOps.lnk')
  if (!fs.existsSync(lnk)) throw new Error('no Start menu entry')
  // what the Start menu entry runs (the link goes to a file: the service it starts must not hold our pipes)
  const linkFile = path.join(OUT, 'link.txt')
  run('cscript', ['//nologo', path.join(appDir, 'WhatsOps.vbs')], { env: { WHATSOPS_NO_BROWSER: '1', WHATSOPS_LINK_OUT: linkFile }, timeout: 300_000 })
  checkLink(fs.readFileSync(linkFile, 'utf8'))
  await waitHealth(true)
  execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'WhatsOps'], { stdio: 'ignore' })
  log(`install test: ${appDir} → WhatsOps ${VER} running, starts at sign-in`)
  const data = path.join(process.env.LOCALAPPDATA, 'mcp-mrg-whatsops')
  await killAndCheckRestart(data, (pid) => execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }))
  // uninstall: WhatsOps stops, leaves the sign-in programs and the disk
  run(path.join(appDir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'])
  await waitHealth(false, 90)
  for (let i = 0; i < 60 && fs.existsSync(path.join(appDir, 'WhatsOps.vbs')); i++) await sleep(1000)
  if (fs.existsSync(path.join(appDir, 'WhatsOps.vbs'))) throw new Error('uninstall left the program')
  let runKey = true
  try {
    execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'WhatsOps'], { stdio: 'ignore' })
  } catch {
    runKey = false
  }
  if (runKey) throw new Error('uninstall left WhatsOps in the sign-in programs')
  log('install test: Windows ok (installed, restarted by itself, uninstalled)')
}

// ------------------------------------------------------------------ Linux: .deb and .rpm
async function buildLinux() {
  const root = path.join(OUT, 'pkgroot')
  const opt = path.join(root, 'opt', 'whatsops')
  fs.cpSync(STAGE, path.join(opt, 'runtime'), { recursive: true, verbatimSymlinks: true })
  fs.writeFileSync(path.join(opt, 'runtime', 'VERSION'), VER)
  fs.copyFileSync(path.join(ROOT, 'install', 'linux.sh'), path.join(opt, 'install.sh'))
  const bin = path.join(root, 'usr', 'bin', 'whatsops')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(
    bin,
    '#!/bin/sh\n# WhatsOps: the first time installs it for this user (background service), then opens it.\n# whatsops --uninstall removes it for this user (--uninstall --purge also deletes the data).\nexec env WHATSOPS_SEED=/opt/whatsops/runtime bash /opt/whatsops/install.sh "$@"\n',
  )
  const desk = path.join(root, 'usr', 'share', 'applications', 'whatsops.desktop')
  fs.mkdirSync(path.dirname(desk), { recursive: true })
  fs.writeFileSync(desk, '[Desktop Entry]\nType=Application\nName=WhatsOps\nComment=WhatsApp server: numbers, MCP, API, plugins\nExec=whatsops\nIcon=whatsops\nTerminal=false\nCategories=Network;Chat;\nStartupNotify=false\n')
  const icon = path.join(root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'whatsops.png')
  fs.mkdirSync(path.dirname(icon), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'packaging/icons/WhatsOps-256.png'), icon)
  // system files: readable by everyone, executables stay executable
  const fix = (p) => {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      fs.chmodSync(p, 0o755)
      for (const e of fs.readdirSync(p)) fix(path.join(p, e))
    } else fs.chmodSync(p, st.mode & 0o111 ? 0o755 : 0o644)
  }
  fix(root)
  fs.chmodSync(bin, 0o755)
  fs.chmodSync(path.join(opt, 'install.sh'), 0o755)
  const description = 'Open WhatsOps from the applications menu (or run whatsops): the first time it installs\n WhatsOps for your user as a background service and opens it in the browser.\n New versions install by themselves.'
  const after = '#!/bin/sh\nif command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi\nif command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true; fi\necho "WhatsOps installed: open it from the applications menu, or run: whatsops"\nexit 0\n'

  // .deb
  const debArch = arch === 'x64' ? 'amd64' : 'arm64'
  const D = path.join(root, 'DEBIAN')
  fs.mkdirSync(D, { recursive: true })
  const size = Math.ceil(Number(execFileSync('du', ['-sk', path.join(root, 'opt'), path.join(root, 'usr')]).toString().split('\n').filter(Boolean).reduce((a, l) => a + Number(l.split(/\s+/)[0]), 0)))
  fs.writeFileSync(
    path.join(D, 'control'),
    `Package: whatsops\nVersion: ${VER}\nSection: net\nPriority: optional\nArchitecture: ${debArch}\nInstalled-Size: ${size}\nDepends: bash, curl\nRecommends: xdg-utils\nMaintainer: WhatsOps <https://github.com/emrgim/WhatsOps/issues>\nHomepage: https://github.com/emrgim/WhatsOps\nDescription: WhatsApp server: numbers, MCP, REST API, plugins\n ${description}\n`,
  )
  fs.writeFileSync(path.join(D, 'postinst'), after, { mode: 0o755 })
  fs.chmodSync(D, 0o755)
  const deb = path.join(UPLOAD, `WhatsOps-${VER}-linux-${arch}.deb`)
  run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, deb])
  fs.rmSync(D, { recursive: true, force: true })

  // .rpm (prebuilt files: no compiling, no dependency scan)
  const rpmArch = arch === 'x64' ? 'x86_64' : 'aarch64'
  const top = path.join(OUT, 'rpmbuild')
  fs.mkdirSync(path.join(top, 'SPECS'), { recursive: true })
  const spec = path.join(top, 'SPECS', 'whatsops.spec')
  fs.writeFileSync(
    spec,
    [
      'Name: whatsops',
      `Version: ${VER}`,
      'Release: 1',
      'Summary: WhatsApp server: numbers, MCP, REST API, plugins',
      'License: Proprietary',
      'URL: https://github.com/emrgim/WhatsOps',
      `BuildArch: ${rpmArch}`,
      'AutoReqProv: no',
      'Requires: bash, curl',
      '%global __os_install_post %{nil}',
      '%define debug_package %{nil}',
      '%define _build_id_links none',
      '%description',
      description.replace(/\n /g, '\n'),
      '%install',
      'mkdir -p %{buildroot}',
      `cp -a "${root}/opt" "${root}/usr" %{buildroot}/`,
      '%post',
      after.replace('#!/bin/sh\n', ''),
      '%files',
      '/opt/whatsops',
      '/usr/bin/whatsops',
      '/usr/share/applications/whatsops.desktop',
      '/usr/share/icons/hicolor/256x256/apps/whatsops.png',
      '',
    ].join('\n'),
  )
  run('rpmbuild', ['-bb', '--define', `_topdir ${top}`, spec])
  const built = path.join(top, 'RPMS', rpmArch, `whatsops-${VER}-1.${rpmArch}.rpm`)
  const rpm = path.join(UPLOAD, `WhatsOps-${VER}-linux-${arch}.rpm`)
  fs.copyFileSync(built, rpm)
  if (TEST) await testLinux(deb, rpm)
}

async function testLinux(deb, rpm) {
  run('sudo', ['dpkg', '-i', deb])
  // what the applications menu runs (no systemd user session on CI runners: started in the background)
  const env = { ...process.env, WHATSOPS_NO_SERVICE: '1', WHATSOPS_NO_BROWSER: '1' }
  checkLink(execFileSync('whatsops', { env, timeout: 240_000 }))
  await waitHealth(true)
  log(`install test: /usr/bin/whatsops → WhatsOps ${VER} running`)
  // opened again: already installed, just the link
  checkLink(execFileSync('whatsops', { env, timeout: 120_000 }))
  const data = path.join(os.homedir(), '.local', 'share', 'mcp-mrg-whatsops')
  run('whatsops', ['--uninstall'], { env })
  await waitHealth(false, 30)
  if (fs.existsSync(path.join(data, 'runtime'))) throw new Error('whatsops --uninstall left the runtime')
  run('sudo', ['dpkg', '-r', 'whatsops'])
  if (fs.existsSync('/usr/bin/whatsops')) throw new Error('dpkg -r left /usr/bin/whatsops')
  const files = execFileSync('rpm', ['-qpl', rpm]).toString()
  for (const f of ['/usr/bin/whatsops', '/opt/whatsops/install.sh', '/opt/whatsops/runtime/VERSION', '/usr/share/applications/whatsops.desktop']) if (!files.includes(f)) throw new Error(`${path.basename(rpm)} lacks ${f}`)
  log('install test: Linux ok (.deb installed, started, opened again, uninstalled; .rpm contents checked)')
}
