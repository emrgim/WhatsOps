/**
 * Auto-update from the GitHub repository.
 *
 * Every few minutes (WA_UPDATE_INTERVAL_MIN, default 5) the server asks GitHub for the latest
 * release of the repo. When a newer version is published and "Update automatically" is on, a git
 * installation (the README's `git clone`) fetches the release tag, rebuilds (npm ci + build) and
 * restarts through its service manager (systemd / launchd). If the new version cannot start
 * (3 boots without staying up 2 minutes) it goes back to the previous version by itself.
 * Installations with local changes to tracked files are never touched.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './config.js'
import { getSetting, setSetting, type DbHandle } from './db/index.js'
import { logger } from './log.js'
import type { Settings } from './settings.js'
import { AppError } from './util.js'

export const UPDATE_REPO = process.env.WA_UPDATE_REPO || process.env.WA_FEEDBACK_REPO || 'emrgim/mcp-mrg-whatsops'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INTERVAL_MIN = Math.max(1, Number(process.env.WA_UPDATE_INTERVAL_MIN || 5))
const HEALTHY_AFTER_MS = 120_000
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
  lastError: string | null = null
  lastResult: Result | null = null
  busy: 'checking' | 'installing' | 'rollback' | null = null
  restartNeeded = false
  private etag = ''
  private skipped = '' // version skipped because of local changes (warn once)

  constructor(
    private h: DbHandle,
    private settings: Settings,
    private restart: (reason: string) => void,
  ) {}

  mode(): 'git' | 'manual' {
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
    if (st.healthy) return
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
    }, HEALTHY_AFTER_MS).unref()
  }

  private async rollback(st: UpdateState): Promise<void> {
    this.busy = 'rollback'
    logger.error({ mod: 'update', from: st.to, to: st.from }, `version ${st.to} does not stay up: going back to ${st.from}`)
    try {
      await sh('git', ['reset', '--hard', '--quiet', st.fromSha])
      await sh(NPM, ['ci', '--no-audit', '--no-fund', '--loglevel=error'], 15 * 60_000)
      await sh(NPM, ['run', 'build'], 10 * 60_000)
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
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `WhatsOps/${VERSION}`, ...(this.etag ? { 'if-none-match': this.etag } : {}) },
      signal: AbortSignal.timeout(15_000),
    })
    this.lastCheck = Date.now()
    if (r.status === 304) return this.latest
    if (r.status === 404) {
      this.latest = null
      this.lastError = null
      return null
    }
    if (!r.ok) throw new Error(`GitHub ${r.status}`)
    this.etag = r.headers.get('etag') ?? ''
    const j = (await r.json()) as { tag_name: string; html_url: string; body?: string; published_at: string }
    this.latest = { version: j.tag_name.replace(/^v/, ''), tag: j.tag_name, url: j.html_url, notes: (j.body ?? '').slice(0, 4000), published: j.published_at }
    this.lastError = null
    return this.latest
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    try {
      await this.check()
      if (this.available() && this.settings.get().autoUpdate && this.mode() === 'git' && this.skipped !== this.latest!.version) await this.apply('auto')
    } catch (e) {
      this.lastError = e instanceof AppError ? e.message : String((e as Error)?.message ?? e)
      if (!(e instanceof AppError)) logger.warn({ mod: 'update', err: this.lastError }, 'update check failed')
    }
  }

  /** Install the latest release (git installations). Throws AppError when it cannot. */
  async apply(reason: 'auto' | 'manual'): Promise<void> {
    if (this.busy) throw new AppError('UPDATE_BUSY', 'An update is already running', 409)
    if (this.mode() !== 'git') throw new AppError('UPDATE_MANUAL', 'This installation was not made with git clone: update it by hand', 409)
    const rel = this.latest ?? (await this.check())
    if (!rel || cmpVersion(rel.version, VERSION) <= 0) throw new AppError('UPDATE_NONE', 'Already up to date', 409)
    if (reason === 'manual') this.skipped = ''
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
}
