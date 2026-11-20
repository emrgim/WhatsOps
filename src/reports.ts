/**
 * Feedback, crash reports and malfunction reports → GitHub issues of the public repo.
 *
 * - No GitHub login for the user: every installation uses the issues-only key shipped in the code
 *   (src/issues-key.ts) and signs each issue with its own installation code (WO-XXXX-XXXX), created
 *   on first start and kept in the database.
 * - Feedback is written by the user (Settings → Feedback) or sent by an AI client (MCP tool).
 * - Crashes (the process dies) are written to <data>/crash/ synchronously and picked up on the next
 *   start; malfunctions are error-level log entries. Both are scrubbed (no numbers, JIDs, e-mails,
 *   keys, home paths) and then, per the user's choice: kept until they press Send ("ask", default),
 *   sent automatically ("auto"), or not collected at all ("off").
 * - The same problem is one issue: reports carry a fingerprint; a repeat becomes a comment.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VERSION, config } from './config.js'
import { getSetting, setSetting, type DbHandle } from './db/index.js'
import { scrambledIssuesKey } from './issues-key.js'
import { logger, onLog, recentLogs, type LogEntry } from './log.js'
import type { Settings } from './settings.js'
import { AppError } from './util.js'

export const REPORT_REPO = process.env.WA_FEEDBACK_REPO || 'emrgim/WhatsOps'
const CRASH_DIR = path.join(config.dataDir, 'crash')

export type FeedbackKind = 'bug' | 'idea' | 'other'
export type ReportType = 'crash' | 'malfunction'
export type PendingReport = { id: string; type: ReportType; fp: string; title: string; detail: string; version: string; at: number; last: number; count: number }
export type SentReport = { type: 'feedback' | ReportType; kind?: FeedbackKind; title: string; number: number; url: string; at: number; via: 'web' | 'mcp' | 'auto' | 'manual'; fp?: string; comment?: boolean }
export type Diagnostics = Record<string, string>

const KIND_LABEL: Record<FeedbackKind, string> = { bug: 'bug', idea: 'enhancement', other: 'question' }
const KIND_NAME: Record<FeedbackKind, string> = { bug: 'Bug', idea: 'Idea', other: 'Other' }
const TYPE_NAME: Record<ReportType, string> = { crash: 'Crash', malfunction: 'Malfunction' }
const LEVEL_NAME: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
const MAX_PENDING = 30
const MAX_SENT = 100
const HOUR = 3600_000
const DAY = 24 * HOUR

function issuesKey(): string {
  if (process.env.WA_FEEDBACK_TOKEN) return process.env.WA_FEEDBACK_TOKEN
  const a = Buffer.from(scrambledIssuesKey[0], 'base64')
  const p = Buffer.from(scrambledIssuesKey[1], 'base64')
  return Buffer.from(a.map((v, i) => v ^ p[i % p.length])).toString('utf8')
}

// ------------------------------------------------------------------- privacy

const HOME = os.homedir()
let USER = ''
try {
  USER = os.userInfo().username
} catch {
  USER = ''
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Remove what could identify the owner or their contacts from text that leaves the machine. */
export function scrub(s: string): string {
  let out = String(s ?? '')
  if (config.dataDir.length > 1) out = out.split(config.dataDir).join('<data>')
  if (HOME.length > 1) out = out.split(HOME).join('~')
  if (USER.length > 2) out = out.replace(new RegExp(`\\b${escRe(USER)}\\b`, 'g'), '<user>')
  return out
    .replace(/\b(?:github_pat_|gh[pousr]_|wam_|wat_|wfk_|sk-)[A-Za-z0-9_-]{6,}/g, '<key>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 <key>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => (/@(s\.whatsapp\.net|g\.us|c\.us|broadcast|newsletter)$/.test(m) ? '<jid>' : '<email>'))
    .replace(/[\w.-]*@(lid|hosted|hosted\.lid)\b/g, '<jid>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\+?\d[\d ().-]{6,}\d/g, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) ? m : '<number>'))
}

function fingerprint(type: string, head: string, stack = ''): string {
  const frames = stack
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .slice(0, 3)
    .map((l) => l.trim().replace(/:\d+:\d+\)?$/, '').replace(/\(.*[\\/]/, '('))
  const msg = head.replace(/\d+/g, '#').replace(/'[^']*'|"[^"]*"/g, '…').slice(0, 200)
  return crypto.createHash('sha1').update([type, msg, ...frames].join('|')).digest('hex').slice(0, 8)
}

const fmtTime = (t: number) => new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
function logLine(e: LogEntry): string {
  const kv = e.data
    ? ' ' +
      Object.entries(e.data)
        .filter(([k]) => k !== 'err')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.split('\n')[0].slice(0, 160) : JSON.stringify(v)}`)
        .join(' ')
    : ''
  return `${fmtTime(e.t)} ${(LEVEL_NAME[e.level] ?? String(e.level)).padEnd(5)} ${(e.mod ?? '').padEnd(8)} ${e.msg}${kv}`
}
const recentContext = (n = 25) =>
  recentLogs({ limit: n })
    .reverse()
    .map(logLine)

/**
 * Called from the uncaughtException handler, right before the process exits: write the crash to
 * disk synchronously (the database may be in any state). Picked up by Reports.start() next time.
 */
export function recordCrashSync(err: unknown, origin: string): void {
  try {
    fs.mkdirSync(CRASH_DIR, { recursive: true, mode: 0o700 })
    const e = err instanceof Error ? err : new Error(String(err))
    const rec = { at: Date.now(), origin, version: VERSION, name: e.name, message: String(e.message), stack: String(e.stack ?? ''), log: recentContext(30) }
    fs.writeFileSync(path.join(CRASH_DIR, `crash-${rec.at}.json`), JSON.stringify(rec), { mode: 0o600 })
  } catch {
    /* nothing else to do while crashing */
  }
}

function parseJson<T>(raw: string | undefined, def: T): T {
  if (!raw) return def
  try {
    return JSON.parse(raw) as T
  } catch {
    return def
  }
}

function allow(list: number[], limits: [number, number][]): boolean {
  const t = Date.now()
  const longest = Math.max(...limits.map(([, w]) => w))
  while (list.length && t - list[0] >= longest) list.shift()
  for (const [max, win] of limits) if (list.filter((x) => t - x < win).length >= max) return false
  list.push(t)
  return true
}

// ------------------------------------------------------------------- reports

export class Reports {
  code = ''
  private pending: PendingReport[] = []
  private sent: SentReport[] = []
  private feedbackTimes: number[] = []
  private autoTimes: number[] = []
  private saving: Promise<void> = Promise.resolve()
  private sending = false

  constructor(
    private h: DbHandle,
    private settings: Settings,
    private info: () => Diagnostics,
  ) {}

  async start(): Promise<void> {
    this.code = (await getSetting(this.h, 'install_code')) ?? ''
    if (!/^WO-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(this.code)) {
      const ALPH = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
      const s = [...crypto.randomBytes(8)].map((b) => ALPH[b % ALPH.length]).join('')
      this.code = `WO-${s.slice(0, 4)}-${s.slice(4)}`
      await setSetting(this.h, 'install_code', this.code)
      logger.info({ mod: 'reports', installation: this.code }, 'installation code created')
    }
    this.pending = parseJson<PendingReport[]>(await getSetting(this.h, 'reports_pending'), [])
    this.sent = parseJson<SentReport[]>(await getSetting(this.h, 'reports_sent'), [])
    this.ingestCrashFiles()
    onLog((e) => this.onLogEntry(e))
    setTimeout(() => void this.autoSend(), 20_000).unref()
  }

  private mode(): 'ask' | 'auto' | 'off' {
    const m = this.settings.get().crashReports
    return m === 'auto' || m === 'off' ? m : 'ask'
  }

  diagnostics(): Diagnostics {
    return {
      WhatsOps: VERSION,
      Node: process.version,
      OS: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
      ...this.info(),
    }
  }

  status() {
    return { repo: REPORT_REPO, installCode: this.code, mode: this.mode(), pending: this.pending, sent: this.sent.slice(0, 50) }
  }

  private save(): void {
    const pending = JSON.stringify(this.pending)
    const sent = JSON.stringify(this.sent)
    this.saving = this.saving
      .then(async () => {
        await setSetting(this.h, 'reports_pending', pending)
        await setSetting(this.h, 'reports_sent', sent)
      })
      .catch((e) => logger.warn({ mod: 'reports', err: String(e) }, 'could not save reports'))
  }

  private add(r: Omit<PendingReport, 'id' | 'last' | 'count'>): void {
    if (this.mode() === 'off') return
    // the same problem already reported for this version in the last day: nothing new to say
    if (this.sent.some((s) => s.fp === r.fp && Date.now() - s.at < DAY && s.title === r.title)) return
    const have = this.pending.find((p) => p.fp === r.fp && p.type === r.type)
    if (have) {
      have.count++
      have.last = r.at
      have.detail = r.detail
    } else {
      this.pending.unshift({ ...r, id: crypto.randomBytes(5).toString('hex'), last: r.at, count: 1 })
      if (this.pending.length > MAX_PENDING) this.pending.length = MAX_PENDING
    }
    this.save()
    if (this.mode() === 'auto') setTimeout(() => void this.autoSend(), 5_000).unref()
  }

  private ingestCrashFiles(): void {
    let files: string[] = []
    try {
      files = fs.readdirSync(CRASH_DIR).filter((f) => /^crash-\d+\.json$/.test(f))
    } catch {
      return
    }
    for (const f of files.sort()) {
      const p = path.join(CRASH_DIR, f)
      try {
        const c = JSON.parse(fs.readFileSync(p, 'utf8')) as { at: number; origin: string; version: string; name: string; message: string; stack: string; log: string[] }
        const head = `${c.name}: ${c.message}`
        this.add({
          type: 'crash',
          fp: fingerprint('crash', head, c.stack),
          title: scrub(head).slice(0, 110),
          detail: scrub(`Origin: ${c.origin}\nVersion: ${c.version}\nTime: ${fmtTime(c.at)}\n\n${c.stack}\n\nLast log lines:\n${c.log.join('\n')}`).slice(0, 20_000),
          version: c.version,
          at: c.at,
        })
        logger.warn({ mod: 'reports', origin: c.origin }, `crash from the previous run recorded: ${scrub(head).slice(0, 120)}`)
      } catch {
        /* unreadable file: drop it */
      }
      try {
        fs.unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  }

  private onLogEntry(e: LogEntry): void {
    if (e.level < 50) return
    // WhatsApp's own library logs network trouble as errors; our reporting must never report itself
    if (e.mod === 'baileys' || e.mod === 'reports') return
    const err = typeof e.data?.err === 'string' ? e.data.err : ''
    const first = err.split('\n')[0]
    const head = `${e.mod ? e.mod + ': ' : ''}${e.msg}${first && !e.msg.includes(first) ? ' — ' + first : ''}`
    const extra = e.data ? Object.entries(e.data).filter(([k]) => k !== 'err').map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') : ''
    this.add({
      type: 'malfunction',
      fp: fingerprint('malfunction', head, err),
      title: scrub(head).slice(0, 110),
      detail: scrub(`Module: ${e.mod ?? '-'}\nVersion: ${VERSION}\nTime: ${fmtTime(e.t)}\n\n${e.msg}\n${extra}\n${err ? '\n' + err + '\n' : ''}\nLast log lines:\n${recentContext(25).join('\n')}`).slice(0, 20_000),
      version: VERSION,
      at: e.t,
    })
  }

  // ----------------------------------------------------------------- GitHub

  private async github<T>(method: string, p: string, body?: unknown): Promise<T> {
    let r: Response
    try {
      r = await fetch(`https://api.github.com/repos/${REPORT_REPO}${p}`, {
        method,
        headers: { authorization: `Bearer ${issuesKey()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': `WhatsOps/${VERSION}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      })
    } catch (e) {
      logger.warn({ mod: 'reports', err: String(e) }, 'GitHub unreachable')
      throw new AppError('REPORT_UNREACHABLE', 'GitHub cannot be reached right now, try again later', 503)
    }
    const j = (await r.json().catch(() => ({}))) as T & { message?: string }
    if (!r.ok) {
      logger.warn({ mod: 'reports', status: r.status, msg: j.message }, 'GitHub refused the report')
      throw new AppError('REPORT_REFUSED', 'GitHub did not accept the report ({0})', 502, [r.status])
    }
    return j
  }

  private footer(via: string): string {
    return `\n---\n<sub>Installation \`${this.code}\` · WhatsOps ${VERSION} · ${via}</sub>\n`
  }

  private diagBlock(d: Diagnostics): string {
    const esc = (s: string) => s.replace(/\|/g, '\\|')
    return `\n<details><summary>Technical info</summary>\n\n| | |\n|---|---|\n${Object.entries(d)
      .map(([k, v]) => `| ${esc(k)} | ${esc(v)} |`)
      .join('\n')}\n\n</details>\n`
  }

  async sendFeedback(input: { kind?: string; title?: string; message?: string; diagnostics?: boolean }, via: 'web' | 'mcp'): Promise<SentReport> {
    const kind: FeedbackKind = input.kind === 'bug' || input.kind === 'idea' ? input.kind : 'other'
    const title = String(input.title ?? '').replace(/\s+/g, ' ').trim()
    const message = String(input.message ?? '').replace(/\r\n/g, '\n').trim()
    if (title.length < 3 || title.length > 120) throw new AppError('FEEDBACK_INVALID', 'The title must be 3–120 characters', 400)
    if (message.length < 5 || message.length > 8000) throw new AppError('FEEDBACK_INVALID', 'The message must be 5–8000 characters', 400)
    if (!allow(this.feedbackTimes, [[5, HOUR], [20, DAY]])) throw new AppError('RATE_LIMITED', 'Too many reports from this installation, try again later', 429)
    const body = `**${KIND_NAME[kind]}**\n\n${message}\n${input.diagnostics === false ? '' : this.diagBlock(this.diagnostics())}${this.footer(via === 'mcp' ? 'sent through MCP' : 'sent from Settings → Feedback')}`
    const issue = await this.github<{ number: number; html_url: string }>('POST', '/issues', { title, body, labels: ['feedback', KIND_LABEL[kind]] })
    const s: SentReport = { type: 'feedback', kind, title, number: issue.number, url: issue.html_url, at: Date.now(), via }
    this.sent.unshift(s)
    if (this.sent.length > MAX_SENT) this.sent.length = MAX_SENT
    this.save()
    logger.info({ mod: 'reports', issue: issue.number, kind, via }, `feedback sent: issue #${issue.number}`)
    return s
  }

  /** Send one pending crash/malfunction report (a repeat of an open issue becomes a comment). */
  async sendReport(id: string, via: 'manual' | 'auto'): Promise<SentReport> {
    const r = this.pending.find((p) => p.id === id)
    if (!r) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404)
    const tag = `[${r.type} ${r.fp}]`
    const intro = `**${TYPE_NAME[r.type]}** · ${via === 'auto' ? 'sent automatically' : 'sent by the user'}\n\nOccurrences: ${r.count} · first ${fmtTime(r.at)} · last ${fmtTime(r.last)}`
    const detail = `\n\n\`\`\`text\n${r.detail.replace(/```/g, "'''")}\n\`\`\`\n`
    const open = await this.github<{ number: number; html_url: string; title: string }[]>('GET', `/issues?state=open&labels=${r.type}&per_page=100`)
    const same = open.find((i) => i.title.startsWith(tag))
    let s: SentReport
    if (same) {
      await this.github('POST', `/issues/${same.number}/comments`, { body: `Same ${r.type} on another run.\n\n${intro}${detail}${this.diagBlock(this.diagnostics())}${this.footer('report')}` })
      s = { type: r.type, title: r.title, number: same.number, url: same.html_url, at: Date.now(), via, fp: r.fp, comment: true }
    } else {
      const issue = await this.github<{ number: number; html_url: string }>('POST', '/issues', {
        title: `${tag} ${r.title}`.slice(0, 200),
        body: `${intro}${detail}${this.diagBlock(this.diagnostics())}${this.footer('report')}`,
        labels: [r.type],
      })
      s = { type: r.type, title: r.title, number: issue.number, url: issue.html_url, at: Date.now(), via, fp: r.fp }
    }
    this.pending = this.pending.filter((p) => p.id !== id)
    this.sent.unshift(s)
    if (this.sent.length > MAX_SENT) this.sent.length = MAX_SENT
    this.save()
    logger.info({ mod: 'reports', issue: s.number, type: r.type, via, comment: !!s.comment }, `${r.type} report sent: issue #${s.number}`)
    return s
  }

  discard(id: string): boolean {
    const n = this.pending.length
    this.pending = this.pending.filter((p) => p.id !== id)
    if (this.pending.length === n) return false
    this.save()
    return true
  }

  async autoSend(): Promise<void> {
    if (this.mode() !== 'auto' || this.sending) return
    this.sending = true
    try {
      for (const r of [...this.pending].reverse()) {
        if (!allow(this.autoTimes, [[10, DAY]])) break
        try {
          await this.sendReport(r.id, 'auto')
        } catch {
          break // offline or refused: retry at the next report / restart
        }
      }
    } finally {
      this.sending = false
    }
  }
}
