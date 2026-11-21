/**
 * Voice messages → text, so agents (MCP, API, webhooks) can "listen" to them.
 *
 * Engines (Settings → Voice):
 *   - local:   faster-whisper on the server (Linux, macOS, Windows), one resident worker so the model loads once;
 *              installed in one click inside WhatsOps' own folder (whisper-install.ts), or the server's own Python
 *   - command: any program that prints the text: `{file}` = the audio file, `{lang}` = language or "auto"
 *   - api:     xAI (`/stt`), OpenAI / Groq / any OpenAI-compatible service (`/audio/transcriptions`)
 * Transcripts are stored (table `transcripts`) and never computed twice; new voice notes can be
 * transcribed as they arrive (event `message.transcribed`, also delivered to webhooks).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys'
import { getSetting, now, setSetting, upsert, type DbHandle } from './db/index.js'
import type { EventBus, WaEvent } from './events.js'
import { logger } from './log.js'
import { AppError } from './util.js'
import { WhisperInstaller } from './whisper-install.js'
import type { WaAccount } from './wa/account.js'
import type { AccountManager } from './wa/manager.js'
import type { WaService } from './wa/service.js'
import { audioInfo, parseMessage, type MessageRow } from './wa/store.js'

export type VoiceEngine = 'off' | 'local' | 'command' | 'api'
export type VoiceProvider = 'xai' | 'openai' | 'groq' | 'custom'
export type VoiceConfig = {
  engine: VoiceEngine
  /** faster-whisper model for the local engine */
  model: string
  /** custom command line: {file} {lang} */
  command: string
  provider: VoiceProvider
  apiUrl: string
  apiKey: string
  apiModel: string
  /** 'auto' or an ISO 639-1 code (it, en, …) */
  language: string
  /** transcribe new incoming voice notes by themselves (false: only when an agent asks) */
  auto: boolean
}
export type VoicePatch = Partial<VoiceConfig>

export const VOICE_ENGINES: VoiceEngine[] = ['off', 'local', 'command', 'api']
export const LOCAL_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3']
export const PROVIDERS: Record<VoiceProvider, { url: string; model: string; path: string }> = {
  xai: { url: 'https://api.x.ai/v1', model: 'grok-voice-transcribe-2.0', path: '/stt' },
  openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', path: '/audio/transcriptions' },
  groq: { url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', path: '/audio/transcriptions' },
  custom: { url: '', model: 'whisper-1', path: '/audio/transcriptions' },
}
const DEFAULT: VoiceConfig = { engine: 'off', model: 'small', command: '', provider: 'xai', apiUrl: '', apiKey: '', apiModel: '', language: 'auto', auto: true }
const CONFIG_KEY = 'voice'
/** voice notes longer than this are not transcribed by themselves (on request they are) */
const AUTO_MAX_SECONDS = 15 * 60
const WORKER_IDLE_MS = 10 * 60_000

export type Transcript = { id: string; chat: string; text: string; language: string | null; seconds: number | null; engine: string; cached: boolean }

/** Plain text out of what transcribers print: drops `[0.0-3.2]` / `[00:00.000 --> 00:03.000]` stamps and joins the lines. */
export function cleanTranscript(out: string): string {
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[[\d:.,\s]+(?:-|-->)[\d:.,\s]+\]\s*/, '').trim())
    .filter((l) => l && !/^(detecting language|detected language)/i.test(l))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** `stt-whisper {file} -l "{lang}"` → argv, quotes respected, no shell. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  let any = false
  for (const ch of cmd.trim()) {
    if (q) {
      if (ch === q) q = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

const extOf = (mime: string) => ({ 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/amr': 'amr' })[mime] ?? (mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'ogg')

// ------------------------------------------------------------------ local engine: faster-whisper worker
const WORKER_PY = `import sys, json, os
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from faster_whisper import WhisperModel
models = {}
def get(name):
    if name not in models:
        models.clear()
        # the model on disk first: no network check that can hang on a slow link
        try:
            models[name] = WhisperModel(name, device="cpu", compute_type="int8", local_files_only=True)
        except Exception:
            models[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return models[name]
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        job = json.loads(line)
    except Exception:
        continue
    if job.get("load"):
        try:
            get(job["load"])
            print(json.dumps({"id": job.get("id"), "loaded": job["load"]}), flush=True)
        except Exception as e:
            print(json.dumps({"id": job.get("id"), "error": str(e)[:500]}), flush=True)
        continue
    try:
        m = get(job.get("model") or "small")
        kw = {"language": job["lang"]} if job.get("lang") else {}
        try:
            segs, info = m.transcribe(job["file"], vad_filter=True, **kw)
            segs = list(segs)
        except Exception:
            segs, info = m.transcribe(job["file"], **kw)
            segs = list(segs)
        text = " ".join(s.text.strip() for s in segs).strip()
        print(json.dumps({"id": job["id"], "text": text, "language": info.language, "duration": info.duration}), flush=True)
    except Exception as e:
        print(json.dumps({"id": job.get("id"), "error": str(e)[:500]}), flush=True)
`

type Job = { resolve: (v: { text: string; language: string | null; duration: number | null }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class LocalWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private buf = ''
  private jobs = new Map<string, Job>()
  private idle: ReturnType<typeof setTimeout> | null = null
  private lastErr = ''
  private loaded: string | null = null
  private loading: Promise<void> | null = null
  /** the model on the server: being downloaded / loaded, ready, or failed (shown in Settings → Voice) */
  model: { name: string; state: 'loading' | 'ready' | 'error'; error: string | null; since: number } | null = null

  constructor(private python: () => string | null) {}

  private script(): string {
    const p = path.join(os.tmpdir(), `whatsops-whisper-${crypto.createHash('sha1').update(WORKER_PY).digest('hex').slice(0, 10)}.py`)
    if (!fs.existsSync(p)) fs.writeFileSync(p, WORKER_PY, { mode: 0o600 })
    return p
  }

  private start(): Promise<void> {
    const py = this.python()
    if (!py) return Promise.reject(new AppError('STT_LOCAL_MISSING', 'faster-whisper is not installed on this server: Settings → Voice → Install faster-whisper', 409))
    const proc = spawn(py, ['-u', this.script()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' } })
    this.proc = proc
    this.buf = ''
    this.lastErr = ''
    return new Promise<void>((resolve, reject) => {
      let started = false
      proc.stdout.on('data', (d: Buffer) => {
        this.buf += d.toString('utf8')
        let i: number
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i)
          this.buf = this.buf.slice(i + 1)
          let msg: { ready?: boolean; id?: string; text?: string; language?: string; duration?: number; error?: string }
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.ready) {
            started = true
            resolve()
            continue
          }
          const job = msg.id ? this.jobs.get(msg.id) : undefined
          if (!job) continue
          this.jobs.delete(msg.id!)
          clearTimeout(job.timer)
          if (msg.error) job.reject(new AppError('STT_FAILED', 'Transcription failed: {0}', 502, [msg.error]))
          else job.resolve({ text: msg.text ?? '', language: msg.language ?? null, duration: msg.duration ?? null })
        }
      })
      proc.stderr.on('data', (d: Buffer) => {
        this.lastErr = (this.lastErr + d.toString('utf8')).slice(-2000)
      })
      const fail = (why: string) => {
        if (this.proc === proc) {
          this.proc = null
          this.ready = null
          this.loaded = null
          this.loading = null
        }
        const err = new AppError('STT_FAILED', 'Transcription failed: {0}', 502, [why])
        for (const [id, j] of this.jobs) {
          clearTimeout(j.timer)
          j.reject(err)
          this.jobs.delete(id)
        }
        if (!started) reject(err)
      }
      proc.on('error', (e) => fail(e.message))
      proc.on('exit', (code) => fail(`the local transcriber stopped (code ${code}) ${this.lastErr.trim().split('\n').slice(-2).join(' ')}`.trim()))
    })
  }

  private send<T>(payload: Record<string, unknown>, timeoutMs: number, onTimeout: () => void): Promise<T> {
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id)
        onTimeout()
        reject(new AppError('STT_TIMEOUT', 'Transcription took too long', 504))
      }, timeoutMs)
      this.jobs.set(id, { resolve: resolve as never, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
    })
  }

  /**
   * Download (first time) and load the model, outside the transcription time limit:
   * large models are ~1.5 GB and a slow link needs minutes, not seconds.
   */
  async load(model: string): Promise<void> {
    if (!this.proc || !this.ready) this.ready = this.start()
    await this.ready
    if (this.loaded === model) return
    if (this.loading && this.model?.name === model) return this.loading
    this.model = { name: model, state: 'loading', error: null, since: Date.now() }
    const p = this.send<void>({ load: model }, 60 * 60_000, () => this.stop())
      .then(() => {
        this.loaded = model
        this.model = { name: model, state: 'ready', error: null, since: Date.now() }
      })
      .catch((e: Error) => {
        this.model = { name: model, state: 'error', error: e.message.slice(0, 300), since: Date.now() }
        throw e
      })
      .finally(() => {
        if (this.loading === p) this.loading = null
      })
    this.loading = p
    return p
  }

  async run(file: string, model: string, lang: string | null, timeoutMs: number) {
    await this.load(model)
    if (this.idle) clearTimeout(this.idle)
    const id = crypto.randomUUID()
    const res = await new Promise<{ text: string; language: string | null; duration: number | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id)
        reject(new AppError('STT_TIMEOUT', 'Transcription took too long', 504))
        this.stop() // a stuck model: start again next time
      }, timeoutMs)
      this.jobs.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, file, model, lang }) + '\n')
    })
    const idle = setTimeout(() => this.stop(), WORKER_IDLE_MS)
    idle.unref()
    this.idle = idle
    return res
  }

  stop(): void {
    const p = this.proc
    this.proc = null
    this.ready = null
    this.loaded = null
    this.loading = null
    if (this.model?.state !== 'error') this.model = null
    if (p && !p.killed) p.kill()
  }
}

// ------------------------------------------------------------------ service
export class VoiceService {
  private cfg: VoiceConfig = { ...DEFAULT }
  private worker: LocalWorker
  private inflight = new Map<string, Promise<Transcript>>()
  /** one transcription at a time: a CPU model does not get faster in parallel */
  private chain: Promise<unknown> = Promise.resolve()
  private py: { at: number; exe: string | null; version: string | null; source: 'env' | 'whatsops' | 'system' | null } | null = null
  readonly installer = new WhisperInstaller()

  constructor(
    private h: DbHandle,
    private bus: EventBus,
    private accounts: AccountManager,
    private svc: WaService,
  ) {
    this.worker = new LocalWorker(() => this.localPython().exe)
  }

  async start(): Promise<void> {
    try {
      const saved = JSON.parse((await getSetting(this.h, CONFIG_KEY)) || '{}') as Record<string, unknown>
      // only the settings that exist today (older versions had more)
      this.cfg = { ...DEFAULT, ...Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULT)) } as VoiceConfig
      if (!VOICE_ENGINES.includes(this.cfg.engine)) this.cfg.engine = 'local'
    } catch {
      this.cfg = { ...DEFAULT }
    }
    this.bus.on('event', (ev: WaEvent) => this.onEvent(ev))
  }

  get config(): VoiceConfig {
    return this.cfg
  }

  publicConfig() {
    const { apiKey, ...rest } = this.cfg
    const p = PROVIDERS[this.cfg.provider] ?? PROVIDERS.custom
    const local = this.localPython()
    return {
      ...rest,
      platform: process.platform,
      apiKeySet: !!apiKey,
      apiUrlEffective: this.cfg.apiUrl || p.url,
      apiModelEffective: this.cfg.apiModel || p.model,
      local: {
        available: !!local.exe,
        python: local.exe,
        version: local.version,
        /** whatsops = installed by the button in WhatsOps' folder; system = the server's own Python; env = WA_WHISPER_PYTHON */
        source: local.source,
        model: this.worker.model,
        installable: this.installer.supported,
        install: this.installer.st,
      },
      models: LOCAL_MODELS,
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { url: v.url, model: v.model }])),
    }
  }

  async update(p: VoicePatch): Promise<void> {
    const next = { ...this.cfg }
    if (p.engine !== undefined) {
      if (!VOICE_ENGINES.includes(p.engine)) throw new AppError('STT_ENGINE', 'Unknown transcription engine', 400)
      next.engine = p.engine
    }
    if (p.model !== undefined) {
      const m = String(p.model).trim()
      if (!/^[\w.\-/]{1,80}$/.test(m)) throw new AppError('STT_MODEL', 'Not a valid model name', 400)
      next.model = m
    }
    if (p.command !== undefined) next.command = String(p.command).trim().slice(0, 1000)
    if (p.provider !== undefined) {
      if (!(p.provider in PROVIDERS)) throw new AppError('STT_PROVIDER', 'Unknown transcription service', 400)
      if (p.provider !== next.provider && p.apiUrl === undefined) next.apiUrl = ''
      if (p.provider !== next.provider && p.apiModel === undefined) next.apiModel = ''
      next.provider = p.provider
    }
    if (p.apiUrl !== undefined) {
      const u = String(p.apiUrl).trim().replace(/\/+$/, '')
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw new AppError('STT_URL', 'The service address must start with https://', 400)
      next.apiUrl = u
    }
    if (p.apiKey !== undefined && String(p.apiKey).trim()) next.apiKey = String(p.apiKey).trim()
    if (p.apiModel !== undefined) next.apiModel = String(p.apiModel).trim().slice(0, 120)
    if (p.language !== undefined) {
      const l = String(p.language).trim().toLowerCase() || 'auto'
      if (l !== 'auto' && !/^[a-z]{2,3}$/.test(l)) throw new AppError('STT_LANG', 'Language: auto or a two-letter code (it, en, …)', 400)
      next.language = l
    }
    if (p.auto !== undefined) next.auto = !!p.auto
    if (next.engine === 'command' && !next.command) throw new AppError('STT_COMMAND', 'Write the command that transcribes the file ({file})', 400)
    if (next.engine === 'command' && !next.command.includes('{file}')) throw new AppError('STT_COMMAND', 'The command must contain {file} where the audio file goes', 400)
    if (next.engine === 'api' && next.provider === 'custom' && !next.apiUrl) throw new AppError('STT_URL', 'Write the address of the transcription service', 400)
    if (next.model !== this.cfg.model || next.engine !== 'local') this.worker.stop()
    this.cfg = next
    await setSetting(this.h, CONFIG_KEY, JSON.stringify(next))
    // download / load the chosen model now, not when the first voice message arrives
    if (next.engine === 'local' && this.localPython().exe) void this.worker.load(next.model).catch((e) => logger.warn({ mod: 'voice', model: next.model, err: String((e as Error)?.message ?? e).slice(0, 300) }, 'whisper model not loaded'))
  }

  /** Python that can import faster_whisper (checked once every 10 minutes): WA_WHISPER_PYTHON, WhatsOps' own, the server's. */
  localPython(): { exe: string | null; version: string | null; source: 'env' | 'whatsops' | 'system' | null } {
    if (this.py && Date.now() - this.py.at < 10 * 60_000) return this.py
    let found: { exe: string | null; version: string | null; source: 'env' | 'whatsops' | 'system' | null } = { exe: null, version: null, source: null }
    const tries: [string | null | undefined, 'env' | 'whatsops' | 'system'][] = [
      [process.env.WA_WHISPER_PYTHON, 'env'],
      [this.installer.python(), 'whatsops'],
      ['python3', 'system'],
      ['python', 'system'],
    ]
    for (const [exe, source] of tries) {
      if (!exe) continue
      const r = spawnSync(exe, ['-c', 'import faster_whisper;print(faster_whisper.__version__)'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      if (r.status === 0) {
        found = { exe, version: r.stdout.trim() || null, source }
        break
      }
    }
    this.py = { at: Date.now(), ...found }
    return found
  }

  /**
   * The "Install faster-whisper" button: WhatsOps installs it in its own folder (any system), then switches
   * the engine to it and downloads the chosen model. Runs in the background; progress in publicConfig().local.install.
   */
  installLocal(model?: string): void {
    if (!this.installer.supported) throw new AppError('STT_INSTALL_PLATFORM', 'faster-whisper has no ready-made package for this system ({0})', 409, [`${process.platform} ${process.arch}`])
    if (this.installer.st.state === 'running') return
    // a repair replaces the Python the worker may be running from (Windows locks files in use)
    this.worker.stop()
    void this.installer
      .install()
      .then(async () => {
        this.worker.stop()
        this.py = null
        await this.update({ engine: 'local', ...(model ? { model } : {}) })
      })
      .catch(() => undefined) // state and log are kept by the installer
  }

  // ---------------------------------------------------------------- transcribe
  private lang(): string | null {
    return this.cfg.language && this.cfg.language !== 'auto' ? this.cfg.language : null
  }

  private engineName(): string {
    if (this.cfg.engine === 'local') return `faster-whisper ${this.cfg.model}`
    if (this.cfg.engine === 'api') return `${this.cfg.provider} ${this.cfg.apiModel || PROVIDERS[this.cfg.provider].model}`
    return this.cfg.engine === 'command' ? `command ${splitCommand(this.cfg.command)[0] ?? ''}`.trim() : 'off'
  }

  /** Audio bytes → text with the configured engine. */
  async transcribeAudio(buf: Buffer, mimetype: string, seconds: number | null): Promise<{ text: string; language: string | null; duration: number | null }> {
    const e = this.cfg.engine
    if (e === 'off') throw new AppError('STT_OFF', 'Voice transcription is off: choose an engine in Settings → Voice', 409)
    // ~ realtime on a slow CPU, plus model loading; at least 3 minutes
    const timeoutMs = Math.max(180_000, (seconds ?? 120) * 3_000)
    if (e === 'api') return this.viaApi(buf, mimetype, timeoutMs)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsops-voice-'))
    const file = path.join(dir, `audio.${extOf(mimetype)}`)
    fs.writeFileSync(file, buf, { mode: 0o600 })
    try {
      if (e === 'local') {
        const r = await this.worker.run(file, this.cfg.model, this.lang(), timeoutMs)
        return { ...r, text: cleanTranscript(r.text) }
      }
      return await this.viaCommand(file, timeoutMs)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  private viaCommand(file: string, timeoutMs: number): Promise<{ text: string; language: string | null; duration: number | null }> {
    const argv = splitCommand(this.cfg.command).map((a) => a.replaceAll('{file}', file).replaceAll('{lang}', this.lang() ?? 'auto'))
    if (!argv.length) throw new AppError('STT_COMMAND', 'Write the command that transcribes the file ({file})', 400)
    return new Promise((resolve, reject) => {
      const p = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        p.kill('SIGKILL')
        reject(new AppError('STT_TIMEOUT', 'Transcription took too long', 504))
      }, timeoutMs)
      p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      p.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-2000)))
      p.on('error', (x) => {
        clearTimeout(timer)
        reject(new AppError('STT_FAILED', 'Transcription failed: {0}', 502, [x.message]))
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new AppError('STT_FAILED', 'Transcription failed: {0}', 502, [`exit ${code} ${err.trim().split('\n').slice(-2).join(' ')}`.trim()]))
        resolve({ text: cleanTranscript(out), language: null, duration: null })
      })
    })
  }

  private async viaApi(buf: Buffer, mimetype: string, timeoutMs: number): Promise<{ text: string; language: string | null; duration: number | null }> {
    const pv = PROVIDERS[this.cfg.provider] ?? PROVIDERS.custom
    const base = (this.cfg.apiUrl || pv.url).replace(/\/+$/, '')
    if (!base) throw new AppError('STT_URL', 'Write the address of the transcription service', 400)
    if (!this.cfg.apiKey) throw new AppError('STT_KEY', 'Paste the API key of the transcription service', 409)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buf)], { type: mimetype }), `audio.${extOf(mimetype)}`)
    form.append('model', this.cfg.apiModel || pv.model)
    if (this.lang()) form.append('language', this.lang()!)
    if (pv.path !== '/stt') form.append('response_format', 'json')
    let res: Response
    try {
      res = await fetch(base + pv.path, { method: 'POST', headers: { authorization: `Bearer ${this.cfg.apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new AppError('STT_FAILED', 'Transcription failed: {0}', 502, [String((e as Error).message ?? e)])
    }
    const body = (await res.json().catch(() => ({}))) as { text?: string; language?: string; duration?: number; error?: { message?: string } | string }
    if (!res.ok) {
      const msg = typeof body.error === 'string' ? body.error : body.error?.message
      throw new AppError('STT_FAILED', 'Transcription failed: {0}', 502, [`HTTP ${res.status}${msg ? ` ${msg}` : ''}`])
    }
    return { text: cleanTranscript(String(body.text ?? '')), language: body.language ?? null, duration: body.duration ?? null }
  }

  private async cached(accountId: string, chat: string, id: string) {
    return (await this.h.db.selectFrom('transcripts').selectAll().where('account_id', '=', accountId).where('chat_jid', '=', chat).where('msg_id', '=', id).executeTakeFirst()) as
      | { text: string; language: string | null; seconds: number | null; engine: string }
      | undefined
  }

  /** Transcript of a voice / audio message: stored once, then served from the database. */
  async transcribe(acc: WaAccount, chatInput: string | undefined, messageId: string, o: { force?: boolean; publish?: boolean } = {}): Promise<Transcript> {
    const chat = chatInput ? await this.svc.resolveChat(acc, chatInput) : undefined
    const row = chat ? await acc.store.loadRow(chat, messageId) : await acc.store.loadById(messageId)
    if (!row) throw new AppError('MESSAGE_NOT_FOUND', 'Message {0} not found', 404, [messageId])
    const content = normalizeMessageContent(parseMessage(row.raw).message)
    if (!content || getContentType(content) !== 'audioMessage') throw new AppError('NOT_AUDIO', 'This message is not a voice or audio message', 400)
    const key = `${acc.id}|${row.chat_jid}|${row.id}`
    if (!o.force) {
      const c = await this.cached(acc.id, row.chat_jid, row.id)
      if (c) return { id: row.id, chat: row.chat_jid, text: c.text, language: c.language, seconds: c.seconds, engine: c.engine, cached: true }
    }
    const running = this.inflight.get(key)
    if (running) return running
    if (this.cfg.engine === 'off') throw new AppError('STT_OFF', 'Voice transcription is off: choose an engine in Settings → Voice', 409)
    const job = (async () => {
      const info = audioInfo(row.raw)
      const run = this.chain.then(async () => {
        const media = await this.svc.downloadMedia(acc, row.chat_jid, row.id)
        return this.transcribeAudio(media.buf, media.mimetype, info?.seconds ?? null)
      })
      this.chain = run.catch(() => undefined)
      const r = await run
      const seconds = info?.seconds ?? (r.duration != null ? Math.round(r.duration) : null)
      const engine = this.engineName()
      await upsert(this.h, 'transcripts', { account_id: acc.id, chat_jid: row.chat_jid, msg_id: row.id, text: r.text, language: r.language, seconds, engine, created_at: now() }, ['account_id', 'chat_jid', 'msg_id'])
      logger.info({ mod: 'voice', account: acc.id, seconds, chars: r.text.length, engine }, `voice message transcribed (${seconds ?? '?'} s)`)
      const out: Transcript = { id: row.id, chat: row.chat_jid, text: r.text, language: r.language, seconds, engine, cached: false }
      if (o.publish !== false) this.bus.publish('message.transcribed', acc.id, { ...(await acc.summarize(row)), transcript: r.text, transcriptLanguage: r.language })
      return out
    })()
    this.inflight.set(key, job)
    try {
      return await job
    } finally {
      this.inflight.delete(key)
    }
  }

  /** Adds `transcript` to the audio messages of a list (one query). */
  async attach(accountId: string, msgs: { id: string; chat: string; type: string; transcript?: string | null }[]): Promise<void> {
    const audio = msgs.filter((m) => m.type === 'audioMessage')
    if (!audio.length) return
    const rows = (await this.h.db
      .selectFrom('transcripts')
      .select(['chat_jid', 'msg_id', 'text'])
      .where('account_id', '=', accountId)
      .where(
        'msg_id',
        'in',
        audio.map((m) => m.id),
      )
      .execute()) as { chat_jid: string; msg_id: string; text: string }[]
    const by = new Map(rows.map((r) => [`${r.chat_jid}|${r.msg_id}`, r.text]))
    const byId = new Map(rows.map((r) => [r.msg_id, r.text]))
    for (const m of audio) m.transcript = by.get(`${m.chat}|${m.id}`) ?? byId.get(m.id) ?? null
  }

  /** Message rows whose transcript contains the text (for search). */
  async search(accountId: string, op: 'like' | 'ilike', pattern: string, limit: number): Promise<{ chat_jid: string; msg_id: string }[]> {
    return (await this.h.db.selectFrom('transcripts').select(['chat_jid', 'msg_id']).where('account_id', '=', accountId).where('text', op, pattern).limit(limit).execute()) as {
      chat_jid: string
      msg_id: string
    }[]
  }

  /** The latest voice message stored (for the Test button). */
  async latestVoice(): Promise<{ acc: WaAccount; row: MessageRow } | null> {
    for (const acc of this.accounts.list()) {
      const row = (await this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('type', '=', 'audioMessage').orderBy('ts', 'desc').limit(1).executeTakeFirst()) as MessageRow | undefined
      if (row) return { acc, row }
    }
    return null
  }

  /** Check the engine; with a voice message stored, transcribe the latest one for real. */
  async test(): Promise<{ ok: boolean; engine: string; sample: { chat: string; seconds: number | null; text: string; ms: number } | null; note?: string }> {
    if (this.cfg.engine === 'off') throw new AppError('STT_OFF', 'Voice transcription is off: choose an engine in Settings → Voice', 409)
    if (this.cfg.engine === 'local' && !this.localPython().exe) throw new AppError('STT_LOCAL_MISSING', 'faster-whisper is not installed on this server: Settings → Voice → Install faster-whisper', 409)
    const last = await this.latestVoice()
    if (!last) return { ok: true, engine: this.engineName(), sample: null, note: 'no voice message stored yet' }
    const t0 = Date.now()
    const media = await this.svc.downloadMedia(last.acc, last.row.chat_jid, last.row.id)
    const info = audioInfo(last.row.raw)
    const r = await this.transcribeAudio(media.buf, media.mimetype, info?.seconds ?? null)
    return { ok: true, engine: this.engineName(), sample: { chat: (await last.acc.store.nameOf(last.row.chat_jid)) ?? last.row.chat_jid, seconds: info?.seconds ?? null, text: r.text.slice(0, 300), ms: Date.now() - t0 } }
  }

  private onEvent(ev: WaEvent): void {
    if (ev.type !== 'message.received' || this.cfg.engine === 'off' || !this.cfg.auto) return
    const d = ev.data as { id?: string; chat?: string; type?: string; upsertType?: string; seconds?: number | null }
    if (d.type !== 'audioMessage' || d.upsertType !== 'notify' || !d.id || !d.chat) return
    if (d.seconds != null && d.seconds > AUTO_MAX_SECONDS) return
    let acc: WaAccount
    try {
      acc = this.accounts.get(ev.account)
    } catch {
      return
    }
    void this.transcribe(acc, d.chat, d.id).catch((e) => logger.warn({ mod: 'voice', account: ev.account, err: String((e as Error)?.message ?? e).slice(0, 300) }, 'voice message not transcribed'))
  }

  stop(): void {
    this.worker.stop()
  }
}
