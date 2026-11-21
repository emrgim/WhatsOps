/**
 * Superwhisper (https://superwhisper.com) as a transcription engine, where WhatsOps runs on macOS or Windows.
 * There is no Superwhisper for Linux: there the engine is faster-whisper on the server.
 *
 * Same on both systems: WhatsOps hands the voice message to the app ("Open with → Superwhisper"),
 * Superwhisper writes a new folder in <its folder>/recordings with a meta.json holding the text
 * (`result` = what was said, `llmResult` = after the mode's AI), WhatsOps waits for it and takes the text.
 *   macOS    open -g -b com.superduper.superwhisper <file>        folder ~/superwhisper (older: ~/Documents/superwhisper)
 *   Windows  superwhisper.exe <file>                               folder %LOCALAPPDATA%\com.superwhisper.app
 * Transcribing files is a Superwhisper Pro feature, and the app must be running (WhatsOps starts it).
 * WhatsOps runs in the user's session on both (LaunchAgent / sign-in), so it can start the app and read its folder.
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isOggOpus, oggOpusToWav } from './audio.js'
import { AppError, sleep } from './util.js'

export const SW_BUNDLE = 'com.superduper.superwhisper'
export const SW_DOWNLOAD: Partial<Record<NodeJS.Platform, string>> = { darwin: 'https://superwhisper.com/download', win32: 'https://superwhisper.com/windows' }

export type SwStatus = {
  /** this WhatsOps runs on macOS or Windows (the systems where Superwhisper exists) */
  supported: boolean
  platform: NodeJS.Platform
  /** where to download it for the server's system */
  download: string | null
  app: { installed: boolean; path: string | null; running: boolean }
  /** Superwhisper's own folder, with its recordings */
  folder: { path: string | null; found: boolean; recordings: number | null; custom: boolean }
}

type Run = (file: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string; err: string }>
const defaultRun: Run = (file, args, timeoutMs = 20_000) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (e, out, err) =>
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out: String(out ?? ''), err: String(err ?? (e ? e.message : '')) }),
    )
  })
/** Start without waiting (the app keeps running). */
type Launch = (file: string, args: string[]) => Promise<void>
const defaultLaunch: Launch = (file, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
    p.once('error', reject)
    p.once('spawn', () => {
      p.unref()
      resolve()
    })
  })

export type SwRecording = { dir: string; text: string | null; processed: string | null; duration: number | null; mode: string | null }

/** One recording's meta.json → its texts (text null while Superwhisper is still working on it). */
export function readMeta(j: unknown): Omit<SwRecording, 'dir'> | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null)
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : typeof o[k] === 'string' && o[k] !== '' && !Number.isNaN(Number(o[k])) ? Number(o[k]) : null)
  const text = str('result') ?? str('rawResult')
  const processed = str('llmResult')
  // a mode with AI writes llmResult after result: wait for it only when the mode has a language model
  const waitingAi = !!str('languageModelName') && !processed
  return { text: waitingAi ? null : text ?? processed, processed, duration: num('duration'), mode: str('modeName') }
}

/** Is the recording's length close to the voice message's? Superwhisper stores milliseconds (older: seconds). */
export function durationMatches(d: number | null, seconds: number | null): boolean {
  if (d == null || seconds == null || seconds <= 0) return true
  const slack = Math.max(3, seconds * 0.15)
  return Math.abs(d / 1000 - seconds) <= slack || Math.abs(d - seconds) <= slack
}

export class Superwhisper {
  private cached: { at: number; key: string; st: SwStatus } | null = null
  /** Superwhisper takes one file at a time */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private platform: NodeJS.Platform = process.platform,
    private run: Run = defaultRun,
    private launch: Launch = defaultLaunch,
    private env: NodeJS.ProcessEnv = process.env,
    private home = os.homedir(),
  ) {}

  get supported(): boolean {
    return this.platform === 'darwin' || this.platform === 'win32'
  }

  /** The folder Superwhisper writes into: the one set in Settings, else the usual places. */
  folder(custom: string): { path: string | null; custom: boolean } {
    if (custom.trim()) return { path: custom.trim().replace(/^~(?=$|[\\/])/, this.home), custom: true }
    const tries =
      this.platform === 'win32'
        ? [path.join(this.env.LOCALAPPDATA || path.join(this.home, 'AppData', 'Local'), 'com.superwhisper.app')]
        : [path.join(this.home, 'superwhisper'), path.join(this.home, 'Documents', 'superwhisper')]
    // the one with recordings, most recently used first
    const have = tries.filter((d) => fs.existsSync(path.join(d, 'recordings')))
    have.sort((a, b) => fs.statSync(path.join(b, 'recordings')).mtimeMs - fs.statSync(path.join(a, 'recordings')).mtimeMs)
    return { path: have[0] ?? tries.find((d) => fs.existsSync(d)) ?? null, custom: false }
  }

  /** Where the app is installed. */
  async appPath(): Promise<string | null> {
    if (this.platform === 'darwin') {
      const found = await this.run('mdfind', [`kMDItemCFBundleIdentifier == "${SW_BUNDLE}"`], 10_000)
      const p = found.out.split('\n').map((l) => l.trim()).find((l) => l.endsWith('.app'))
      return p ?? [path.join('/Applications', 'superwhisper.app'), path.join('/Applications', 'Superwhisper.app'), path.join(this.home, 'Applications', 'superwhisper.app')].find((x) => fs.existsSync(x)) ?? null
    }
    if (this.platform === 'win32') {
      const local = this.env.LOCALAPPDATA || path.join(this.home, 'AppData', 'Local')
      const tries = [
        path.join(local, 'Programs', 'superwhisper', 'superwhisper.exe'),
        path.join(local, 'superwhisper', 'superwhisper.exe'),
        path.join(this.env.ProgramFiles || 'C:\\Program Files', 'superwhisper', 'superwhisper.exe'),
      ]
      const hit = tries.find((x) => fs.existsSync(x))
      if (hit) return hit
      // the installer registers itself: InstallLocation / DisplayIcon
      for (const hive of ['HKCU', 'HKLM']) {
        const r = await this.run('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'superwhisper', '/d'], 15_000)
        for (const m of r.out.matchAll(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+?)\s*$/gim)) {
          const v = m[2].replace(/^"|"$/g, '').replace(/,\d+$/, '')
          const exe = v.toLowerCase().endsWith('.exe') ? v : path.join(v, 'superwhisper.exe')
          if (fs.existsSync(exe)) return exe
        }
      }
    }
    return null
  }

  private async isRunning(): Promise<boolean> {
    if (this.platform === 'darwin') return (await this.run('pgrep', ['-f', 'superwhisper.app/Contents/MacOS/'], 10_000)).out.trim() !== ''
    if (this.platform === 'win32') return /superwhisper\.exe/i.test((await this.run('tasklist', ['/FI', 'IMAGENAME eq superwhisper.exe', '/NH'], 15_000)).out)
    return false
  }

  async status(customFolder: string, fresh = false): Promise<SwStatus> {
    if (!fresh && this.cached && this.cached.key === customFolder && Date.now() - this.cached.at < 5_000) return this.cached.st
    const st: SwStatus = {
      supported: this.supported,
      platform: this.platform,
      download: SW_DOWNLOAD[this.platform] ?? null,
      app: { installed: false, path: null, running: false },
      folder: { path: null, found: false, recordings: null, custom: !!customFolder.trim() },
    }
    if (this.supported) {
      const p = await this.appPath()
      st.app = { installed: !!p, path: p, running: p ? await this.isRunning() : false }
      const f = this.folder(customFolder)
      st.folder.path = f.path
      const rec = f.path ? path.join(f.path, 'recordings') : null
      st.folder.found = !!rec && fs.existsSync(rec)
      st.folder.recordings = st.folder.found ? fs.readdirSync(rec!).filter((d) => !d.startsWith('.')).length : null
    }
    this.cached = { at: Date.now(), key: customFolder, st }
    return st
  }

  private requireSupported(): void {
    if (!this.supported) throw new AppError('SW_PLATFORM', 'Superwhisper exists for macOS and Windows: on this server ({0}) use faster-whisper', 409, [this.platform])
  }

  /** Start the app, or open its settings. */
  async open(what: 'app' | 'settings'): Promise<void> {
    this.requireSupported()
    const app = await this.appPath()
    if (!app) throw new AppError('SW_NO_APP', 'Superwhisper is not installed on this server: download it, install it, then check again', 409)
    if (this.platform === 'darwin') {
      const r = what === 'settings' ? await this.run('open', ['superwhisper://settings']) : await this.run('open', ['-g', '-b', SW_BUNDLE])
      if (r.code !== 0) throw new AppError('SW_OPEN', 'Superwhisper could not be opened: {0}', 409, [(r.err || r.out).trim().slice(0, 200)])
    } else {
      // Windows: the app lives in the system tray; starting it again brings it up
      await this.launch(app, []).catch((e: Error) => {
        throw new AppError('SW_OPEN', 'Superwhisper could not be opened: {0}', 409, [e.message])
      })
    }
    this.cached = null
  }

  private recordingsDir(customFolder: string): string {
    const f = this.folder(customFolder).path
    const rec = f ? path.join(f, 'recordings') : null
    if (!rec || !fs.existsSync(rec)) throw new AppError('SW_NO_FOLDER', "Superwhisper's folder was not found: open Superwhisper once, or write where its folder is (in Superwhisper: Settings → Configuration → Advanced)", 409)
    return rec
  }

  private list(rec: string): Set<string> {
    return new Set(fs.readdirSync(rec).filter((d) => !d.startsWith('.')))
  }

  private readRecording(dir: string): SwRecording | null {
    try {
      const m = readMeta(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')))
      return m ? { dir, ...m } : null
    } catch {
      return null // not written yet
    }
  }

  /** Hand the audio to Superwhisper and wait for its new recording. One at a time. */
  transcribe(file: string, seconds: number | null, opts: { folder: string; prefer: 'raw' | 'processed'; timeoutMs: number; pollMs?: number; startWaitMs?: number }): Promise<{ text: string; language: null; duration: number | null }> {
    const job = this.queue.then(() => this.transcribeNow(file, seconds, opts))
    this.queue = job.catch(() => undefined)
    return job
  }

  private async transcribeNow(file: string, seconds: number | null, opts: { folder: string; prefer: 'raw' | 'processed'; timeoutMs: number; pollMs?: number; startWaitMs?: number }) {
    this.requireSupported()
    const app = await this.appPath()
    if (!app) throw new AppError('SW_NO_APP', 'Superwhisper is not installed on this server: download it, install it, then check again', 409)
    const rec = this.recordingsDir(opts.folder)
    if (!(await this.isRunning())) {
      await this.open('app')
      await sleep(opts.startWaitMs ?? 5_000)
    }
    // WhatsApp voice messages are Ogg Opus: Superwhisper reads WAV everywhere
    let input = file
    const buf = fs.readFileSync(file)
    if (isOggOpus(buf)) {
      const { wav, seconds: s } = await oggOpusToWav(buf)
      input = file.replace(/\.[^.\\/]+$/, '') + '.wav'
      fs.writeFileSync(input, wav, { mode: 0o600 })
      seconds ??= s
    }
    const before = this.list(rec)
    if (this.platform === 'darwin') {
      const r = await this.run('open', ['-g', '-b', SW_BUNDLE, input])
      if (r.code !== 0) throw new AppError('SW_FAILED', 'Superwhisper did not take the file: {0}', 502, [(r.err || r.out).trim().slice(0, 300)])
    } else {
      await this.launch(app, [input]).catch((e: Error) => {
        throw new AppError('SW_FAILED', 'Superwhisper did not take the file: {0}', 502, [e.message])
      })
    }
    const end = Date.now() + opts.timeoutMs
    let seen = false
    while (Date.now() < end) {
      await sleep(opts.pollMs ?? 1_000)
      for (const d of this.list(rec)) {
        if (before.has(d)) continue
        seen = true
        const r = this.readRecording(path.join(rec, d))
        if (!r || r.text == null || !durationMatches(r.duration, seconds)) continue
        const text = opts.prefer === 'processed' ? r.processed ?? r.text : r.text
        const dur = r.duration == null ? null : seconds != null && r.duration > seconds * 20 ? r.duration / 1000 : r.duration
        return { text, language: null, duration: dur }
      }
    }
    throw new AppError(
      'SW_TIMEOUT',
      seen ? 'Superwhisper started on the voice message but did not finish in time' : 'Superwhisper did not transcribe the file: transcribing files needs Superwhisper Pro, and the app must be open',
      504,
    )
  }
}
