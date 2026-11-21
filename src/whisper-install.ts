/**
 * faster-whisper in one click, on every WhatsOps build (Linux x64 / arm64, macOS Apple Silicon / Intel, Windows x64).
 *
 * Settings → Voice → "Install faster-whisper": WhatsOps downloads uv (https://github.com/astral-sh/uv, one
 * file, checksum verified), uv brings its own Python and installs faster-whisper into <data>/whisper.
 * Nothing is installed system-wide and no Python is needed beforehand. The model is downloaded afterwards,
 * by the worker, into the usual Hugging Face cache.
 *
 *   <data>/whisper/uv/uv[.exe]   uv
 *   <data>/whisper/python/       Python 3.12 (uv-managed)
 *   <data>/whisper/venv/         faster-whisper and its libraries
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './log.js'
import { AppError } from './util.js'

export const UV_VERSION = '0.13.9'
export const FASTER_WHISPER_VERSION = '1.2.1'
/**
 * Versions installed together with faster-whisper. PyAV 19 removed `metadata_errors`, which faster-whisper 1.2.1
 * passes to av.open(): every transcription failed with "unexpected keyword argument" (found by check-whisper.mjs).
 */
const PINS = [`faster-whisper==${FASTER_WHISPER_VERSION}`, 'av>=11,<19']
const PYTHON_VERSION = '3.12'

export type InstallStep = 'uv' | 'python' | 'packages' | 'check'
export type InstallState = {
  state: 'idle' | 'running' | 'done' | 'error'
  step: InstallStep | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}

/** uv's release file for this system; null where faster-whisper has no ready-made package (e.g. Windows on ARM). */
export function uvAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const a = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null
  if (!a) return null
  if (platform === 'linux') return `uv-${a}-unknown-linux-gnu.tar.gz`
  if (platform === 'darwin') return `uv-${a}-apple-darwin.tar.gz`
  if (platform === 'win32' && a === 'x86_64') return `uv-${a}-pc-windows-msvc.zip`
  return null
}

type Run = (file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; out: string; err: string }>
const defaultRun: Run = (file, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    const p = spawn(file, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-20_000)))
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-20_000)))
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: err + e.message })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })

const lastLines = (s: string, n = 3) => s.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' ').slice(0, 400)

export class WhisperInstaller {
  st: InstallState = { state: 'idle', step: null, error: null, startedAt: null, finishedAt: null }
  private running: Promise<string> | null = null

  constructor(
    readonly dir = path.join(config.dataDir, 'whisper'),
    private platform: NodeJS.Platform = process.platform,
    private arch: string = process.arch,
    private run: Run = defaultRun,
  ) {}

  /** faster-whisper has ready-made packages for this server's system */
  get supported(): boolean {
    return uvAsset(this.platform, this.arch) !== null
  }

  private venvPython(): string {
    return this.platform === 'win32' ? path.join(this.dir, 'venv', 'Scripts', 'python.exe') : path.join(this.dir, 'venv', 'bin', 'python')
  }

  private uvPath(): string {
    return path.join(this.dir, 'uv', this.platform === 'win32' ? 'uv.exe' : 'uv')
  }

  /** WhatsOps' own Python with faster-whisper, when installed. */
  python(): string | null {
    const p = this.venvPython()
    return fs.existsSync(p) ? p : null
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: path.join(this.dir, 'python'),
      UV_CACHE_DIR: path.join(this.dir, 'cache'),
      UV_LINK_MODE: 'copy',
      UV_NO_CONFIG: '1',
      UV_PYTHON_DOWNLOADS: 'automatic',
      VIRTUAL_ENV: undefined,
      PYTHONHOME: undefined,
      PYTHONPATH: undefined,
    }
  }

  /** Install (or repair) faster-whisper; one at a time. Resolves with the Python to use. */
  install(): Promise<string> {
    if (this.running) return this.running
    if (!this.supported) return Promise.reject(new AppError('STT_INSTALL_PLATFORM', 'faster-whisper has no ready-made package for this system ({0})', 409, [`${this.platform} ${this.arch}`]))
    this.st = { state: 'running', step: null, error: null, startedAt: Date.now(), finishedAt: null }
    const job = this.installNow()
      .then((py) => {
        this.st = { ...this.st, state: 'done', step: null, finishedAt: Date.now() }
        logger.info({ mod: 'voice', python: py, s: Math.round((Date.now() - (this.st.startedAt ?? Date.now())) / 1000) }, 'faster-whisper installed')
        return py
      })
      .catch((e: Error) => {
        this.st = { ...this.st, state: 'error', error: e.message.slice(0, 500), finishedAt: Date.now() }
        logger.warn({ mod: 'voice', step: this.st.step, err: e.message.slice(0, 300) }, 'faster-whisper not installed')
        throw e
      })
      .finally(() => {
        this.running = null
        fs.rmSync(path.join(this.dir, 'cache'), { recursive: true, force: true })
      })
    this.running = job
    return job
  }

  private async installNow(): Promise<string> {
    fs.mkdirSync(this.dir, { recursive: true })
    const env = this.env()
    // 1. uv
    this.st.step = 'uv'
    const uv = this.uvPath()
    const have = fs.existsSync(uv) ? await this.run(uv, ['--version'], { env, timeoutMs: 30_000 }) : null
    if (!have || have.code !== 0 || !have.out.includes(UV_VERSION)) await this.downloadUv()
    // 2. Python, in WhatsOps' own folder
    this.st.step = 'python'
    fs.rmSync(path.join(this.dir, 'venv'), { recursive: true, force: true })
    const v = await this.run(uv, ['venv', path.join(this.dir, 'venv'), '--python', PYTHON_VERSION, '--managed-python', '--no-project'], { env, timeoutMs: 15 * 60_000 })
    if (v.code !== 0) throw new AppError('STT_INSTALL', 'faster-whisper could not be installed ({0}): {1}', 502, ['Python', lastLines(v.err || v.out)])
    // 3. faster-whisper and its libraries
    this.st.step = 'packages'
    const py = this.venvPython()
    const p = await this.run(uv, ['pip', 'install', '--python', py, '--only-binary', ':all:', ...PINS], { env, timeoutMs: 30 * 60_000 })
    if (p.code !== 0) throw new AppError('STT_INSTALL', 'faster-whisper could not be installed ({0}): {1}', 502, ['packages', lastLines(p.err || p.out)])
    // 4. it imports
    this.st.step = 'check'
    const c = await this.run(py, ['-c', 'import faster_whisper, ctranslate2; print(faster_whisper.__version__)'], { env: { ...process.env, PYTHONUTF8: '1' }, timeoutMs: 120_000 })
    if (c.code !== 0 || !c.out.trim()) throw new AppError('STT_INSTALL', 'faster-whisper could not be installed ({0}): {1}', 502, ['check', lastLines(c.err || c.out)])
    return py
  }

  private async downloadUv(): Promise<void> {
    const asset = uvAsset(this.platform, this.arch)!
    const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/`
    const fail = (why: string) => new AppError('STT_INSTALL', 'faster-whisper could not be installed ({0}): {1}', 502, ['uv', why])
    let sum: string | undefined
    let buf: Buffer
    try {
      const s = await fetch(base + asset + '.sha256', { signal: AbortSignal.timeout(60_000) })
      if (!s.ok) throw fail(`checksum HTTP ${s.status}`)
      sum = (await s.text()).trim().split(/\s+/)[0]?.toLowerCase()
      const r = await fetch(base + asset, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!r.ok) throw fail(`HTTP ${r.status}`)
      buf = Buffer.from(await r.arrayBuffer())
    } catch (e) {
      if (e instanceof AppError) throw e
      throw fail(String((e as Error).message ?? e))
    }
    if (!sum || crypto.createHash('sha256').update(buf).digest('hex') !== sum) throw fail('the download does not match its checksum')
    const tmp = path.join(this.dir, 'uv-download')
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    try {
      const archive = path.join(tmp, asset)
      fs.writeFileSync(archive, buf)
      // tar is part of macOS, Linux and Windows 10+ (System32\tar.exe also opens .zip; Git's tar would not)
      const tar = this.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
      const x = await this.run(tar, ['-xf', archive, '-C', tmp], { timeoutMs: 120_000 })
      if (x.code !== 0) throw fail(`unpack: ${lastLines(x.err || x.out)}`)
      const name = this.platform === 'win32' ? 'uv.exe' : 'uv'
      const found = findFile(tmp, name)
      if (!found) throw fail('uv not found in the download')
      fs.mkdirSync(path.dirname(this.uvPath()), { recursive: true })
      fs.copyFileSync(found, this.uvPath())
      if (this.platform !== 'win32') fs.chmodSync(this.uvPath(), 0o755)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) {
      const f = findFile(p, name)
      if (f) return f
    }
  }
  return null
}
