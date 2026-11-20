/**
 * Auto-update from the GitHub repository.
 *
 * Every few minutes (WA_UPDATE_INTERVAL_MIN, default 5) the server asks GitHub for the latest
 * release of the repo. When a newer version is published and "Update automatically" is on:
 *  - a git installation (the README's `git clone`) fetches the release tag, rebuilds (npm ci + build);
 *  - a package installation (Mac app, Windows, Linux / Omarchy script) downloads the release's runtime
 *    for its system (`whatsops-<version>-runtime-<os>-<arch>.tar.gz`), checks its SHA-256, unpacks it
 *    next to the current one and switches `runtime/current`;
 * then restarts through its service manager (launchd / systemd / the Windows launcher). If the new
 * version cannot start (3 boots without staying up 2 minutes) it goes back to the previous version
 * by itself. Git installations with local changes to tracked files are never touched.
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './config.js'
import { getSetting, setSetting, type DbHandle } from './db/index.js'
import { logger } from './log.js'
import type { Settings } from './settings.js'
import { AppError } from './util.js'

export const UPDATE_REPO = process.env.WA_UPDATE_REPO || process.env.WA_FEEDBACK_REPO || 'emrgim/WhatsOps'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INTERVAL_MIN = Math.max(1, Number(process.env.WA_UPDATE_INTERVAL_MIN || 5))
const HEALTHY_AFTER_MS = 120_000
/** Set by the package launchers: <data>/runtime with `current`, `previous` and one folder per version. */
const RUNTIME_DIR = process.env.WA_RUNTIME_DIR || ''
const PKG_OS = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
const PKG_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
export const runtimeAsset = (version: string) => `whatsops-${version}-runtime-${PKG_OS}-${PKG_ARCH}.tar.gz`
const VERSION_DIR = /^\d+\.\d+\.\d+([-+][\w.]+)?$/
const MAX_BAD_BOOTS = 3

type Release = { version: string; tag: string; url: string; notes: string; published: string }
type UpdateState = { from: string; fromSha: string; to: string; at: number; boots: number; healthy: boolean }
type Result = { at: number; ok: boolean; message: string }

/** Compare x.y.z versions: >0 if a is newer. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

const binDir = path.dirname(process.execPath)
const NPM = fs.existsSync(path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')) ? path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm') : 'npm'

function sh(cmd: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: ROOT, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => (err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`)) : resolve(stdout)),
    )
  })
}

export class Updater {
  latest: Release | null = null
  lastCheck = 0
  private repo = UPDATE_REPO // current name on GitHub (follows renames)
  private notesTag = ''
  lastError: string | null = null
  lastResult: Result | null = null
  busy: 'checking' | 'installing' | 'rollback' | null = null
  restartNeeded = false
  private skipped = '' // version skipped because of local changes (warn once)

  constructor(
    private h: DbHandle,
    private settings: Settings,
    private restart: (reason: string) => void,
  ) {}

  mode(): 'git' | 'bundle' | 'manual' {
    if (RUNTIME_DIR && fs.existsSync(path.join(RUNTIME_DIR, 'current'))) return 'bundle'
    return fs.existsSync(path.join(ROOT, '.git')) ? 'git' : 'manual'
  }

  /** Is there a service manager that starts us again after exit? */
  supervised(): boolean {
    return !!(process.env.INVOCATION_ID || process.env.WA_SUPERVISED === '1' || (process.platform === 'darwin' && process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== '0'))
  }

  available(): boolean {
    return !!this.latest && cmpVersion(this.latest.version, VERSION) > 0
  }

  status() {
    return {
      repo: UPDATE_REPO,
      current: VERSION,
      latest: this.latest,
      available: this.available(),
      auto: this.settings.get().autoUpdate,
      mode: this.mode(),
      supervised: this.supervised(),
      busy: this.busy,
      lastCheck: this.lastCheck || null,
      lastError: this.lastError,
      lastResult: this.lastResult,
      restartNeeded: this.restartNeeded,
      intervalMin: INTERVAL_MIN,
    }
  }

  start(): void {
    void this.boot().catch((e) => logger.warn({ mod: 'update', err: String(e) }, 'update bookkeeping failed'))
    setTimeout(() => void this.tick(), 30_000).unref()
    setInterval(() => void this.tick(), INTERVAL_MIN * 60_000).unref()
  }

  private async boot(): Promise<void> {
    this.lastResult = (JSON.parse((await getSetting(this.h, 'update_last')) || 'null') as Result | null) ?? null
    this.skipped = (await getSetting(this.h, 'update_skip')) ?? ''
    const raw = await getSetting(this.h, 'update_state')
    if (!raw) return
    const st = JSON.parse(raw) as UpdateState
    if (st.healthy) {
      this.cleanRuntimes()
      return
    }
    st.boots++
    if (st.boots > MAX_BAD_BOOTS && VERSION === st.to) {
      await this.rollback(st)
      return
    }
    await setSetting(this.h, 'update_state', JSON.stringify(st))
    if (st.boots === 1 && VERSION === st.to) logger.info({ mod: 'update', from: st.from, to: st.to }, `updated from ${st.from} to ${st.to}`)
    setTimeout(() => {
      st.healthy = true
      void setSetting(this.h, 'update_state', JSON.stringify(st))
      this.cleanRuntimes()
    }, HEALTHY_AFTER_MS).unref()
  }

  private async rollback(st: UpdateState): Promise<void> {
    this.busy = 'rollback'
    logger.error({ mod: 'update', from: st.to, to: st.from }, `version ${st.to} does not stay up: going back to ${st.from}`)
    try {
      if (this.mode() === 'bundle') {
        if (!fs.existsSync(path.join(RUNTIME_DIR, st.from))) throw new Error(`version ${st.from} is no longer on disk`)
        this.writeRuntimeFile('current', st.from)
      } else {
        await sh('git', ['reset', '--hard', '--quiet', st.fromSha])
        await sh(NPM, ['ci', '--no-audit', '--no-fund', '--loglevel=error'], 15 * 60_000)
        await sh(NPM, ['run', 'build'], 10 * 60_000)
      }
      await setSetting(this.h, 'update_state', '')
      await this.skip(st.to)
      await this.setResult(false, `Version ${st.to} did not start: back to ${st.from}`)
      if (this.supervised()) this.restart(`rollback to ${st.from}`)
      else this.restartNeeded = true
    } catch (e) {
      logger.error({ mod: 'update', err: String(e) }, 'rollback failed')
    } finally {
      this.busy = null
    }
  }

  /** Never retry this version by itself (a newer release is tried again). */
  private async skip(version: string): Promise<void> {
    this.skipped = version
    await setSetting(this.h, 'update_skip', version).catch(() => undefined)
  }

  private async setResult(ok: boolean, message: string): Promise<void> {
    this.lastResult = { at: Date.now(), ok, message }
    await setSetting(this.h, 'update_last', JSON.stringify(this.lastResult)).catch(() => undefined)
  }

  async check(): Promise<Release | null> {
    if (this.busy === 'installing' || this.busy === 'rollback') return this.latest
    // Not the REST API: without a login it allows 60 calls per hour per IP address, shared by every
    // program on the same network. github.com/<repo>/releases/latest redirects to the latest
    // published release (no drafts, no pre-releases) and is not counted against that limit.
    // A renamed repository answers 301 to its new name first: follow that, stop at the tag.
    let url = `https://github.com/${UPDATE_REPO}/releases/latest`
    let r!: Response
    let m: RegExpMatchArray | null = null
    for (let hop = 0; hop < 4; hop++) {
      r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': `WhatsOps/${VERSION}` }, signal: AbortSignal.timeout(15_000) })
      await r.body?.cancel().catch(() => undefined)
      const loc = r.headers.get('location') ?? ''
      m = loc.match(/\/([^/]+\/[^/]+)\/releases\/tag\/([^/?#]+)/)
      if (m || r.status < 300 || r.status >= 400 || !/\/releases\/latest$/.test(new URL(loc, url).pathname)) break
      url = new URL(loc, url).toString()
    }
    this.lastCheck = Date.now()
    if (m) this.repo = m[1]
    if (r.status === 404 || (r.status >= 300 && r.status < 400 && !m)) {
      this.latest = null // repository without releases
      this.lastError = null
      return null
    }
    if (!m) throw new Error(`GitHub ${r.status}`)
    const tag = decodeURIComponent(m[2])
    if (this.latest?.tag !== tag || this.notesTag !== tag) {
      this.latest = { version: tag.replace(/^v/, ''), tag, url: `https://github.com/${this.repo}/releases/tag/${encodeURIComponent(tag)}`, notes: '', published: '' }
      // GitHub's feed can lag a minute behind a new release: retried on the next checks until found
      if (await this.readNotes(this.latest).catch(() => false)) this.notesTag = tag
    }
    this.lastError = null
    return this.latest
  }

  /** Release notes and date from the releases Atom feed (also outside the REST API limit). */
  private async readNotes(rel: Release): Promise<boolean> {
    const r = await fetch(`https://github.com/${this.repo}/releases.atom`, { headers: { 'user-agent': `WhatsOps/${VERSION}` }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return false
    const xml = await r.text()
    for (const entry of xml.split('<entry>').slice(1)) {
      if (!entry.includes(`/releases/tag/${encodeURIComponent(rel.tag)}"`) && !entry.includes(`/releases/tag/${rel.tag}"`)) continue
      const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      const html = unxml(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '')
      rel.notes = unxml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ').replace(/<[^>]+>/g, ''))
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 4000)
      rel.published = entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? ''
      return true
    }
    return false
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    try {
      await this.check()
      if (this.available() && this.settings.get().autoUpdate && this.mode() !== 'manual' && this.skipped !== this.latest!.version) await this.apply('auto')
    } catch (e) {
      this.lastError = e instanceof AppError ? e.message : String((e as Error)?.message ?? e)
      if (!(e instanceof AppError)) logger.warn({ mod: 'update', err: this.lastError }, 'update check failed')
    }
  }

  /** Install the latest release (git or package installations). Throws AppError when it cannot. */
  async apply(reason: 'auto' | 'manual'): Promise<void> {
    if (this.busy) throw new AppError('UPDATE_BUSY', 'An update is already running', 409)
    const mode = this.mode()
    if (mode === 'manual') throw new AppError('UPDATE_MANUAL', 'This installation was not made with git clone: update it by hand', 409)
    const rel = this.latest ?? (await this.check())
    if (!rel || cmpVersion(rel.version, VERSION) <= 0) throw new AppError('UPDATE_NONE', 'Already up to date', 409)
    if (reason === 'manual') this.skipped = ''
    if (mode === 'bundle') return this.applyBundle(rel, reason)
    this.busy = 'installing'
    let prev = ''
    let moved = false
    try {
      prev = (await sh('git', ['rev-parse', 'HEAD'])).trim()
      const dirty = (await sh('git', ['status', '--porcelain', '--untracked-files=no'])).trim()
      if (dirty) {
        if (this.skipped !== rel.version) logger.warn({ mod: 'update', version: rel.version }, `update ${rel.version} skipped: this installation has local changes`)
        this.skipped = rel.version
        throw new AppError('UPDATE_DIRTY', 'This installation has local changes to its files: update skipped', 409)
      }
      logger.info({ mod: 'update', from: VERSION, to: rel.version, reason }, `installing ${rel.version}`)
      await sh('git', ['fetch', '--tags', '--force', '--quiet', 'origin'], 5 * 60_000)
      const onBranch = await sh('git', ['symbolic-ref', '-q', 'HEAD']).then(
        () => true,
        () => false,
      )
      try {
        if (onBranch) await sh('git', ['merge', '--ff-only', '--quiet', `refs/tags/${rel.tag}`])
        else await sh('git', ['checkout', '--quiet', '--detach', `refs/tags/${rel.tag}`])
      } catch {
        if (this.skipped !== rel.version) logger.warn({ mod: 'update', version: rel.version }, `update ${rel.version} skipped: this installation has its own commits`)
        this.skipped = rel.version
        throw new AppError('UPDATE_DIRTY', 'This installation has local changes to its files: update skipped', 409)
      }
      moved = true
      await sh(NPM, ['ci', '--no-audit', '--no-fund', '--loglevel=error'], 15 * 60_000)
      await sh(NPM, ['run', 'build'], 10 * 60_000)
    } catch (e) {
      if (moved && prev) {
        // put the previous version back exactly as it was
        await sh('git', ['reset', '--hard', '--quiet', prev]).catch(() => undefined)
        await sh(NPM, ['ci', '--no-audit', '--no-fund', '--loglevel=error'], 15 * 60_000).catch(() => undefined)
        await sh(NPM, ['run', 'build'], 10 * 60_000).catch(() => undefined)
      }
      this.busy = null
      if (e instanceof AppError) throw e
      const msg = String((e as Error)?.message ?? e)
      logger.error({ mod: 'update', to: rel.version, err: msg }, `update to ${rel.version} failed, previous version kept`)
      await this.skip(rel.version)
      await this.setResult(false, `Update to ${rel.version} failed: ${msg}`)
      throw new AppError('UPDATE_FAILED', 'The update failed; the previous version is still installed', 500)
    }
    await setSetting(this.h, 'update_state', JSON.stringify({ from: VERSION, fromSha: prev, to: rel.version, at: Date.now(), boots: 0, healthy: false } satisfies UpdateState))
    await this.setResult(true, `Updated from ${VERSION} to ${rel.version}`)
    logger.info({ mod: 'update', to: rel.version }, `version ${rel.version} installed, restarting`)
    this.busy = null
    if (this.supervised()) this.restart(`update to ${rel.version}`)
    else this.restartNeeded = true
  }

  // ------------------------------------------------------------------ package installations
  private writeRuntimeFile(name: 'current' | 'previous', value: string): void {
    const tmp = path.join(RUNTIME_DIR, `${name}.tmp`)
    fs.writeFileSync(tmp, value, { mode: 0o600 })
    fs.renameSync(tmp, path.join(RUNTIME_DIR, name))
  }

  /** Keep only the current and the previous version on disk. */
  private cleanRuntimes(): void {
    if (this.mode() !== 'bundle') return
    try {
      const keep = new Set(['current', 'previous'].map((f) => (fs.existsSync(path.join(RUNTIME_DIR, f)) ? fs.readFileSync(path.join(RUNTIME_DIR, f), 'utf8').trim() : '')))
      for (const d of fs.readdirSync(RUNTIME_DIR)) {
        const base = d.replace(/\.(part|download)$/, '')
        if (!VERSION_DIR.test(base) || (keep.has(d) && d === base)) continue
        fs.rmSync(path.join(RUNTIME_DIR, d), { recursive: true, force: true })
      }
    } catch (e) {
      logger.debug({ mod: 'update', err: String(e) }, 'old versions not removed')
    }
  }

  private async applyBundle(rel: Release, reason: 'auto' | 'manual'): Promise<void> {
    const name = runtimeAsset(rel.version)
    const base = `https://github.com/${this.repo}/releases/download/${encodeURIComponent(rel.tag)}/`
    // the packages are built by GitHub Actions a few minutes after the release: not there yet = try later
    const sum = await fetch(base + name + '.sha256', { headers: { 'user-agent': `WhatsOps/${VERSION}` }, signal: AbortSignal.timeout(30_000) })
    if (sum.status === 404) throw new AppError('UPDATE_NOT_READY', 'Version {0} for this system is not published yet: trying again later', 409, [rel.version])
    if (!sum.ok) throw new Error(`GitHub ${sum.status}`)
    const expected = (await sum.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('bad checksum file')
    this.busy = 'installing'
    const file = path.join(RUNTIME_DIR, `${rel.version}.download`)
    const part = path.join(RUNTIME_DIR, `${rel.version}.part`)
    const dest = path.join(RUNTIME_DIR, rel.version)
    try {
      logger.info({ mod: 'update', from: VERSION, to: rel.version, reason }, `installing ${rel.version}`)
      const r = await fetch(base + name, { headers: { 'user-agent': `WhatsOps/${VERSION}` }, signal: AbortSignal.timeout(15 * 60_000) })
      if (!r.ok || !r.body) throw new Error(`download ${r.status}`)
      const hash = crypto.createHash('sha256')
      const out = fs.createWriteStream(file, { mode: 0o600 })
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()))
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())))
      if (hash.digest('hex') !== expected) throw new Error('the download does not match its SHA-256')
      fs.rmSync(part, { recursive: true, force: true })
      fs.mkdirSync(part, { recursive: true, mode: 0o700 })
      // Windows: bsdtar from System32 (always there since Windows 10)
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
      await sh(tar, ['-xzf', file, '-C', part], 10 * 60_000)
      const node = path.join(part, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
      const pkg = JSON.parse(fs.readFileSync(path.join(part, 'app', 'package.json'), 'utf8')) as { version?: string }
      if (!fs.existsSync(node) || !fs.existsSync(path.join(part, 'app', 'dist', 'main.js')) || pkg.version !== rel.version) throw new Error('the package is incomplete')
      fs.rmSync(dest, { recursive: true, force: true })
      fs.renameSync(part, dest)
      this.writeRuntimeFile('previous', VERSION)
      this.writeRuntimeFile('current', rel.version)
    } catch (e) {
      fs.rmSync(part, { recursive: true, force: true })
      this.busy = null
      const msg = String((e as Error)?.message ?? e)
      logger.error({ mod: 'update', to: rel.version, err: msg }, `update to ${rel.version} failed, previous version kept`)
      await this.skip(rel.version)
      await this.setResult(false, `Update to ${rel.version} failed: ${msg}`)
      throw new AppError('UPDATE_FAILED', 'The update failed; the previous version is still installed', 500)
    } finally {
      fs.rmSync(file, { force: true })
    }
    await setSetting(this.h, 'update_state', JSON.stringify({ from: VERSION, fromSha: VERSION, to: rel.version, at: Date.now(), boots: 0, healthy: false } satisfies UpdateState))
    await this.setResult(true, `Updated from ${VERSION} to ${rel.version}`)
    logger.info({ mod: 'update', to: rel.version }, `version ${rel.version} installed, restarting`)
    this.busy = null
    if (this.supervised()) this.restart(`update to ${rel.version}`)
    else this.restartNeeded = true
  }
}
