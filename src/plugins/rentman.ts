/**
 * Plugin: Rentman ⇄ WhatsApp.
 *
 * Rentman has no discussions or comments in its API, so the plugin works on projects: a project
 * switched on (by hand, or by itself when it reaches a chosen status) gets WhatsApp groups with the
 * crew planned on it. Structure (setting): one group per project, or a Community per project with a
 * group per subproject or per department (function group).
 *   - WhatsOps' main number (the default one unless chosen) creates every group: it is their creator;
 *     whoever created the project in Rentman becomes admin, and so does the backup number.
 *   - Crew members join when they accept the Rentman invitation (or as soon as planned: setting) and
 *     leave the group when they are taken off the planning (setting).
 *   - WhatsOps posts the project card (dates, location, who does what and when — never rates) and then
 *     the updates: dates, location, people joining and leaving, changed times (setting).
 * WhatsApp → Rentman: nothing (no place for messages in Rentman's API).
 *
 * API: https://api.rentman.net, `Authorization: Bearer <JWT>`, 10 requests/s, 50,000/day, pages of
 * max 1500 (`next_page_url`), filters `field[gt]=…`, `fields=`, `expand=`. Webhooks: ONE URL per
 * account, set in Rentman (Configuration → Integrations → Webhooks); body signed with HMAC
 * (`Digest: sha512=<hex>`) using the token Rentman shows there.
 */
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { getSetting, now, setSetting } from '../db/index.js'
import { logger } from '../log.js'
import { AppError, userOf } from '../util.js'
import { authenticate, requireScope, type App } from '../app.js'
import type { Principal } from '../security/auth.js'
import { defaultLang, tr, type Lang } from '../i18n.js'
import { phoneDigits, pluginAccess } from '../users.js'
import type { WaAccount } from '../wa/account.js'
import { addToGroup, clip, createCommunity, createGroup, ensureAdmins, postToGroup, removeFromGroup } from './wagroups.js'

export const RM_ID = 'rentman'
const apiBase = () => (process.env.WA_RENTMAN_API || 'https://api.rentman.net').replace(/\/+$/, '') // override only for tests
const CONFIG_KEY = 'plugin:rentman'
const NAMES_KEY = 'plugin:rentman:names'
export const RM_POLL = [2, 5, 15, 30] as const
export const RM_MODES = ['project', 'subproject', 'department'] as const
export type Mode = (typeof RM_MODES)[number]
const LIST_REFRESH_MS = 30 * 60_000
const FULL_RESYNC_MS = 30 * 60_000 // removals are not in the "modified" feeds: re-read synced projects now and then
const ENDED_MS = 2 * 86400_000 // groups of a project that ended 2 days ago are left alone
const GROUP_DAY_MAX = 50 // new WhatsApp groups per 24 h at most (WhatsApp limits how many a number creates)
const SLACK_MS = 2 * 60_000
const MIN_GAP_MS = 120 // Rentman allows 10 requests a second
const RETRY_FAILED_MS = 6 * 3600_000 // numbers WhatsApp refused are tried again after 6 h
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type RmConfig = {
  token: string
  workspace: string // account name (yourcompany in yourcompany.rentmanapp.com)
  company: string
  timezone: string
  account: string // WhatsApp number that creates the groups (empty = the default one)
  backupAccount: string
  mode: Mode
  creatorAdmin: boolean
  joinOn: 'accepted' | 'planned'
  removeOnUnplan: boolean
  posts: 'updates' | 'card' | 'none'
  countryCode: string // calling code for numbers written without it (from the Rentman account's country)
  inviteFallback: boolean
  autoStatuses: string[] // Rentman status ids: a project reaching one of them gets its groups by itself
  autoSince: number
  pollMinutes: number
  hookSecret: string
  webhookToken: string // the token Rentman shows next to the webhook URL (checks the Digest header)
  lastHookAt: number
  cursor: number
}
const DEFAULT_CONFIG: RmConfig = {
  token: '',
  workspace: '',
  company: '',
  timezone: '',
  account: '',
  backupAccount: '',
  mode: 'project',
  creatorAdmin: true,
  joinOn: 'accepted',
  removeOnUnplan: true,
  posts: 'updates',
  countryCode: '',
  inviteFallback: true,
  autoStatuses: [],
  autoSince: 0,
  pollMinutes: 2,
  hookSecret: '',
  webhookToken: '',
  lastHookAt: 0,
  cursor: 0,
}
export type RmPatch = Partial<Pick<RmConfig, 'token' | 'account' | 'backupAccount' | 'mode' | 'creatorAdmin' | 'joinOn' | 'removeOnUnplan' | 'posts' | 'countryCode' | 'inviteFallback' | 'autoStatuses' | 'pollMinutes' | 'webhookToken'>>

type ProjRow = {
  id: string
  name: string | null
  number: string | null
  creator: string | null
  start_at: number | null
  end_at: number | null
  location: string | null
  statuses: string | null // {subprojectId: statusId}
  rms_created: number | null
  seen_at: number | null
  sync: number | null
  state: string | null
  error: string | null
  mode: string | null
  auto_at: number | null
  off_hand: number | null
  snap: string | null
  community_jid: string | null
  synced_at: number | null
  created_at: number | null
}
type GroupRow = {
  key: string
  project_id: string
  kind: string
  ref_id: string | null
  name: string | null
  group_jid: string | null
  state: string | null
  error: string | null
  members: string | null // phones WhatsOps added (or invited) as crew
  failed: string | null // {phone: when} WhatsApp refused
  admins: string | null
  card: string | null
  created_at: number | null
  updated_at: number | null
}

// ------------------------------------------------------------------ pure helpers (tested)
/** "/crew/12" → "12" */
export const idOf = (ref: unknown): string | null => {
  if (ref == null || ref === '') return null
  if (typeof ref === 'number') return String(ref)
  if (typeof ref === 'object') return idOf((ref as { id?: unknown }).id)
  const m = String(ref).match(/(\d+)\s*$/)
  return m ? m[1] : null
}
const ts = (v: unknown): number | null => (v ? Date.parse(String(v)) || null : null)

const CALLING: Record<string, string> = {
  nl: '31', be: '32', fr: '33', es: '34', it: '39', sm: '39', va: '39', de: '49', gb: '44', uk: '44', ie: '353', pt: '351', ch: '41', at: '43', dk: '45', se: '46', no: '47', pl: '48',
  lu: '352', cz: '420', sk: '421', gr: '30', hu: '36', ro: '40', bg: '359', hr: '385', si: '386', fi: '358', ee: '372', lv: '371', lt: '370', mt: '356', cy: '357', is: '354',
  us: '1', ca: '1', mx: '52', br: '55', ar: '54', cl: '56', co: '57', au: '61', nz: '64', za: '27', ae: '971', sa: '966', qa: '974', kw: '965', bh: '973', om: '968',
  il: '972', tr: '90', eg: '20', ma: '212', in: '91', sg: '65', hk: '852', jp: '81', cn: '86', kr: '82', th: '66', my: '60', id: '62', ph: '63',
}
/** Calling code of a country (ISO 3166 alpha-2), e.g. "nl" → "31". */
export const callingCode = (country: string | null | undefined): string => CALLING[String(country ?? '').toLowerCase()] ?? ''

/**
 * A crew phone as written in Rentman → international digits, or null.
 * "+31 6 1234 5678", "0031 6…" → as is; "06 1234 5678" with calling code 31 → 31612345678;
 * Italy keeps the leading 0 of landlines and has none on mobiles: "333 123 4567" → 393331234567.
 */
export function normPhone(raw: unknown, cc: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  let d: string
  if (/^(\+|00)/.test(s)) d = s.replace(/^00/, '').replace(/\D+/g, '')
  else {
    d = s.replace(/\D+/g, '')
    if (!d) return null
    if (cc === '39') d = d.startsWith('39') && d.length >= 11 ? d : '39' + d
    else if (cc && d.startsWith('0')) d = cc + d.slice(1)
    else if (cc && !(d.startsWith(cc) && d.length >= cc.length + 8)) d = cc + d
  }
  return d.length >= 8 && d.length <= 15 ? d : null
}

/** Rentman signs every webhook: `Digest: sha512=<hex>` = HMAC of the raw body with the webhook token. */
export function verifyDigest(raw: string, header: string | string[] | undefined, token: string): boolean {
  const h = Array.isArray(header) ? header[0] : header
  const m = String(h ?? '').match(/^(sha256|sha384|sha512)=([0-9a-f]+)$/i)
  if (!m || !token) return false
  const want = crypto.createHmac(m[1].toLowerCase(), token).update(raw, 'utf8').digest()
  const got = Buffer.from(m[2], 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

export type SnapCrew = { pc: string; crew: string; name: string; phone: string | null; fn: string; fnName: string; start: number | null; end: number | null; ok: boolean }
export type Snap = {
  id: string
  name: string
  number: string
  location: string | null
  start: number | null
  end: number | null
  creator: string | null
  subs: { id: string; name: string; status: string | null; start: number | null; end: number | null }[]
  fgroups: { id: string; name: string }[]
  fns: { id: string; name: string; sub: string | null; group: string | null; start: number | null; end: number | null }[]
  crew: SnapCrew[]
}
export type GroupPlan = { key: string; kind: Mode; ref: string; name: string; crew: SnapCrew[] }

export const projectTitle = (s: { name: string; number?: string | null }) => (s.number ? `${s.name} · ${s.number}` : s.name)

/** The WhatsApp groups a project should have in this structure, each with the crew that belongs there. */
export function desiredGroups(s: Snap, mode: Mode, general: string): GroupPlan[] {
  const ok = s.crew.filter((c) => c.ok)
  const fnOf = new Map(s.fns.map((f) => [f.id, f]))
  if (mode === 'project') return [{ key: `p:${s.id}`, kind: 'project', ref: s.id, name: projectTitle(s), crew: ok }]
  if (mode === 'subproject') {
    const first = s.subs[0]?.id ?? null
    return s.subs.map((sub) => ({ key: `s:${sub.id}`, kind: 'subproject' as const, ref: sub.id, name: sub.name || projectTitle(s), crew: ok.filter((c) => (fnOf.get(c.fn)?.sub ?? first) === sub.id) }))
  }
  const out: GroupPlan[] = s.fgroups.map((g) => ({ key: `d:${s.id}:${g.id}`, kind: 'department' as const, ref: g.id, name: g.name || general, crew: ok.filter((c) => fnOf.get(c.fn)?.group === g.id) }))
  const known = new Set(s.fgroups.map((g) => g.id))
  const loose = ok.filter((c) => !known.has(fnOf.get(c.fn)?.group ?? ''))
  if (loose.length) out.push({ key: `d:${s.id}:0`, kind: 'department', ref: '0', name: general, crew: loose })
  return out
}

/** Who to add and who to remove, given who WhatsOps already put in the group. Admins are never removed. */
export function planMembers(want: string[], tracked: string[], admins: string[], removeOld: boolean): { add: string[]; remove: string[] } {
  const w = new Set(want)
  const a = new Set(admins)
  const t = new Set(tracked)
  return { add: [...w].filter((p) => !t.has(p)), remove: removeOld ? [...t].filter((p) => !w.has(p) && !a.has(p)) : [] }
}

export type CardState = { title: string; start: number | null; end: number | null; location: string | null; crew: { crew: string; name: string; fn: string; start: number | null; end: number | null }[] }
export function cardState(s: Snap, g: GroupPlan): CardState {
  const crew = g.crew
    .map((c) => ({ crew: c.crew, name: c.name, fn: c.fnName, start: c.start, end: c.end }))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.name.localeCompare(b.name))
  const sub = g.kind === 'subproject' ? s.subs.find((x) => x.id === g.ref) : null
  return { title: g.kind === 'project' ? projectTitle(s) : `${projectTitle(s)} — ${g.name}`, start: sub?.start ?? s.start, end: sub?.end ?? s.end, location: s.location, crew }
}

function fmt(lang: Lang, tz: string, opts: Intl.DateTimeFormatOptions) {
  const loc = lang === 'it' ? 'it-IT' : 'en-GB'
  try {
    return new Intl.DateTimeFormat(loc, { ...opts, timeZone: tz || undefined })
  } catch {
    return new Intl.DateTimeFormat(loc, opts)
  }
}
/** "12 dic 08:00 → 18:00" or "12 dic 08:00 → 14 dic 23:00" */
export function fmtRange(lang: Lang, tz: string, a: number | null, b: number | null, withTime = true): string {
  if (!a && !b) return '—'
  const day = fmt(lang, tz, { day: 'numeric', month: 'short', ...(withTime ? {} : { year: 'numeric' }) })
  const time = fmt(lang, tz, { hour: '2-digit', minute: '2-digit', hour12: false })
  const one = (t: number) => (withTime ? `${day.format(t)} ${time.format(t)}` : day.format(t))
  if (!a || !b) return one((a ?? b)!)
  if (!withTime && day.format(a) === day.format(b)) return day.format(a)
  if (withTime && day.format(a) === day.format(b)) return `${day.format(a)} ${time.format(a)} → ${time.format(b)}`
  return `${one(a)} → ${one(b)}`
}

export function cardText(lang: Lang, tz: string, c: CardState, creator: string | null): string {
  const lines = [`🎬 *${c.title}*`, `📅 ${fmtRange(lang, tz, c.start, c.end, false)}`]
  if (c.location) lines.push(`📍 ${c.location}`)
  if (creator) lines.push(`👤 ${tr(lang, 'Created by {0}', [creator])}`)
  lines.push('', `👥 *${tr(lang, 'Crew')}*`)
  if (!c.crew.length) lines.push(tr(lang, 'No crew confirmed yet'))
  for (const p of c.crew) lines.push(`• ${p.name} — ${p.fn} · ${fmtRange(lang, tz, p.start, p.end)}`)
  return lines.join('\n')
}

/** What changed between two cards, as one message; null when nothing did. */
export function diffText(lang: Lang, tz: string, a: CardState, b: CardState): string | null {
  const lines: string[] = []
  if (a.title !== b.title) lines.push(`✏️ ${tr(lang, 'Name: {0} → {1}', [a.title, b.title])}`)
  if (a.start !== b.start || a.end !== b.end) lines.push(`📅 ${tr(lang, 'Dates: {0} → {1}', [fmtRange(lang, tz, a.start, a.end, false), fmtRange(lang, tz, b.start, b.end, false)])}`)
  if ((a.location ?? '') !== (b.location ?? '')) lines.push(`📍 ${tr(lang, 'Location: {0} → {1}', [a.location || '—', b.location || '—'])}`)
  const k = (p: CardState['crew'][number]) => `${p.crew}|${p.fn}`
  const before = new Map(a.crew.map((p) => [k(p), p]))
  const after = new Map(b.crew.map((p) => [k(p), p]))
  for (const [key, p] of after) {
    const o = before.get(key)
    if (!o) lines.push(`➕ ${p.name} — ${p.fn} · ${fmtRange(lang, tz, p.start, p.end)}`)
    else if (o.start !== p.start || o.end !== p.end) lines.push(`🕒 ${p.name} — ${p.fn}: ${fmtRange(lang, tz, o.start, o.end)} → ${fmtRange(lang, tz, p.start, p.end)}`)
  }
  for (const [key, p] of before) if (!after.has(key)) lines.push(`➖ ${p.name} — ${p.fn}`)
  if (!lines.length) return null
  return [`🔄 *${b.title}* — ${tr(lang, 'update')}`, ...lines].join('\n')
}

/** Projects that just reached a status that creates their groups. */
export function statusHits(prev: Record<string, string> | null, next: Record<string, string>, auto: string[]): boolean {
  const a = new Set(auto)
  return Object.entries(next).some(([sub, st]) => a.has(st) && !(prev && a.has(prev[sub] ?? '')))
}

const uniq = <T>(xs: (T | null | undefined | false)[]): T[] => [...new Set(xs.filter(Boolean) as T[])]
const errText = (e: unknown) => (e instanceof AppError ? e.message : String((e as Error)?.message ?? e)).slice(0, 500)

// ------------------------------------------------------------------ the plugin
export type RmScope = { crew: Set<string> } | null

export class RentmanPlugin {
  cfg: RmConfig = { ...DEFAULT_CONFIG }
  lastRefresh = 0
  lastPoll = 0
  private pollStarted = 0
  private refreshing: Promise<void> | null = null
  private locks = new Map<string, Promise<unknown>>()
  private apiGate: Promise<void> = Promise.resolve()
  private lastCall = 0
  private calls = { day: '', n: 0 }
  private crew = new Map<string, { name: string; phone: string | null; raw: string; active: boolean }>()
  private crewAt = 0
  private statuses = new Map<string, string>()
  private accepted: { at: number; set: Set<string> } | null = null
  // which project an item belongs to (from the snapshots): planning, functions, subprojects
  private pcIndex = new Map<string, string>()
  private fnIndex = new Map<string, string>()
  private subIndex = new Map<string, string>()
  private dirty = new Set<string>()
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  private working = false

  constructor(private app: App) {}

  async start(): Promise<void> {
    try {
      this.cfg = { ...DEFAULT_CONFIG, ...(JSON.parse((await getSetting(this.app.h, CONFIG_KEY)) || '{}') as Partial<RmConfig>) }
    } catch {
      this.cfg = { ...DEFAULT_CONFIG }
    }
    if (!RM_POLL.includes(this.cfg.pollMinutes as 2)) this.cfg.pollMinutes = 2
    if (!RM_MODES.includes(this.cfg.mode)) this.cfg.mode = 'project'
    if (!this.cfg.hookSecret) {
      this.cfg.hookSecret = crypto.randomBytes(18).toString('base64url')
      await this.save()
    }
    for (const r of (await this.app.h.db.selectFrom('rm_projects').select(['id', 'snap']).where('sync', '=', 1).execute()) as ProjRow[]) {
      try {
        if (r.snap) this.index(JSON.parse(r.snap) as Snap)
      } catch {
        /* rebuilt at the next sync */
      }
    }
    await this.loadNames()
    this.pollStarted = Date.now()
    setInterval(() => {
      if (!this.configured()) return
      if (Date.now() - this.lastRefresh > LIST_REFRESH_MS) void this.refresh().catch((e) => logger.warn({ mod: 'rentman', err: errText(e) }, 'refresh failed'))
      if (Date.now() - this.pollStarted < this.cfg.pollMinutes * 60_000) return
      this.pollStarted = Date.now()
      void this.poll().catch((e) => logger.warn({ mod: 'rentman', err: errText(e) }, 'poll failed'))
    }, 30_000).unref()
  }

  configured(): boolean {
    return !!this.cfg.token
  }

  private async save(): Promise<void> {
    await setSetting(this.app.h, CONFIG_KEY, JSON.stringify(this.cfg))
  }

  publicConfig() {
    const { token, hookSecret, webhookToken, cursor: _c, ...rest } = this.cfg
    return { ...rest, tokenSet: !!token, webhookTokenSet: !!webhookToken, hookUrl: hookSecret ? `/plugins/${RM_ID}/hook/${hookSecret}` : null }
  }

  async updateConfig(p: RmPatch): Promise<void> {
    if (p.token !== undefined && p.token.trim()) {
      this.cfg.token = p.token.trim()
      this.cfg.workspace = ''
      this.cfg.cursor = 0
      this.crew.clear()
      this.statuses.clear()
      this.crewAt = 0
    }
    if (p.account !== undefined) this.cfg.account = p.account
    if (p.backupAccount !== undefined) this.cfg.backupAccount = p.backupAccount
    if (p.mode !== undefined) this.cfg.mode = RM_MODES.includes(p.mode) ? p.mode : 'project'
    if (p.creatorAdmin !== undefined) this.cfg.creatorAdmin = !!p.creatorAdmin
    if (p.joinOn !== undefined) this.cfg.joinOn = p.joinOn === 'planned' ? 'planned' : 'accepted'
    if (p.removeOnUnplan !== undefined) this.cfg.removeOnUnplan = !!p.removeOnUnplan
    if (p.posts !== undefined) this.cfg.posts = p.posts === 'none' || p.posts === 'card' ? p.posts : 'updates'
    if (p.inviteFallback !== undefined) this.cfg.inviteFallback = !!p.inviteFallback
    if (p.countryCode !== undefined) {
      const cc = String(p.countryCode).replace(/\D+/g, '')
      if (cc.length > 4) throw new AppError('RM_COUNTRY', 'The country calling code has 1 to 4 digits (e.g. 39, 31, 971)', 400)
      if (cc !== this.cfg.countryCode) {
        this.cfg.countryCode = cc
        // numbers written without a country code read again with the new one
        for (const c of this.crew.values()) c.phone = normPhone(c.raw, cc)
      }
    }
    if (p.pollMinutes !== undefined) {
      if (!RM_POLL.includes(p.pollMinutes as 2)) throw new AppError('RM_POLL', 'Choose 2, 5, 15 or 30 minutes', 400)
      this.cfg.pollMinutes = p.pollMinutes
    }
    if (p.webhookToken !== undefined) this.cfg.webhookToken = p.webhookToken.trim()
    if (p.autoStatuses !== undefined) {
      const next = uniq(p.autoStatuses.map((s) => idOf(s)))
      // only projects reaching a status from now on get their groups by themselves
      if (next.some((s) => !this.cfg.autoStatuses.includes(s))) this.cfg.autoSince = Date.now()
      this.cfg.autoStatuses = next
    }
    await this.save()
  }

  // ------------------------------------------------------------------ Rentman API
  private slot(): Promise<void> {
    const t = this.apiGate.then(async () => {
      const w = this.lastCall + MIN_GAP_MS - Date.now()
      if (w > 0) await sleep(w)
      this.lastCall = Date.now()
      const day = new Date().toISOString().slice(0, 10)
      if (this.calls.day !== day) this.calls = { day, n: 0 }
      if (++this.calls.n === 40_000) logger.warn({ mod: 'rentman' }, 'Rentman API: 40,000 calls today (limit 50,000)')
    })
    this.apiGate = t.catch(() => undefined)
    return t
  }

  async api<T = { data: unknown; next_page_url?: string | null }>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured()) throw new AppError('RM_NOT_CONFIGURED', 'Connect Rentman first (API token)', 409)
    const API = apiBase()
    // next_page_url is absolute: keep its path and cursor, on our base
    const url = /^https?:\/\//.test(path) ? API + new URL(path).pathname + new URL(path).search : API + path
    for (let attempt = 0; ; attempt++) {
      await this.slot()
      let r: Response
      try {
        r = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${this.cfg.token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        })
      } catch {
        if (attempt >= 2) throw new AppError('RM_UNREACHABLE', 'Rentman cannot be reached right now', 503)
        await sleep(2000)
        continue
      }
      if (r.status === 429 && attempt < 4) {
        await sleep(1000 * 2 ** attempt + 500) // Rentman sends no Retry-After
        continue
      }
      const text = await r.text()
      let j: unknown = {}
      try {
        j = text ? JSON.parse(text) : {}
      } catch {
        j = { raw: text.slice(0, 200) }
      }
      if (r.status === 401 || r.status === 403) throw new AppError('RM_AUTH', 'Rentman refused the API token', 401)
      if (!r.ok) {
        const msg = (j as { message?: unknown; errors?: unknown }).message ?? (j as { errors?: unknown }).errors ?? text.slice(0, 200)
        throw new AppError('RM_ERROR', 'Rentman answered {0}: {1}', r.status === 404 ? 404 : 502, [r.status, typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300)])
      }
      return j as T
    }
  }

  /** Every page of a collection (follows next_page_url). */
  private async list<T = Record<string, unknown>>(path: string, maxPages = 5): Promise<T[]> {
    const out: T[] = []
    let next: string | null | undefined = path
    for (let i = 0; next && i < maxPages; i++) {
      const j: { data?: T[]; next_page_url?: string | null } = await this.api('GET', next)
      out.push(...(j.data ?? []))
      next = j.next_page_url
    }
    return out
  }

  private async one<T = Record<string, unknown>>(path: string): Promise<T> {
    return ((await this.api<{ data: T }>('GET', path)).data ?? {}) as T
  }

  /** Check the token and read the account: name, country (calling code), time zone. */
  async test() {
    const w = await this.one<{ name?: string; company_name?: string; country_code?: string; timezone?: string }>('/workspace/:getInfo')
    this.cfg.workspace = String(w.name ?? '')
    this.cfg.company = String(w.company_name ?? '')
    this.cfg.timezone = String(w.timezone ?? '')
    if (!this.cfg.countryCode) this.cfg.countryCode = callingCode(w.country_code)
    await this.save()
    return { ok: true, workspace: this.cfg.workspace, company: this.cfg.company, timezone: this.cfg.timezone, countryCode: this.cfg.countryCode }
  }

  webUrl(projectId: string): string | null {
    return this.cfg.workspace ? `https://${this.cfg.workspace}.rentmanapp.com/#/projects/${projectId}/details` : null
  }

  async loadStatuses(force = false): Promise<{ id: string; name: string }[]> {
    if (force || !this.statuses.size) {
      const list = await this.list<{ id: number; name?: string; displayname?: string }>('/statuses?fields=id,name,displayname', 2)
      this.statuses = new Map(list.map((s) => [String(s.id), String(s.displayname || s.name || `#${s.id}`)]))
      await this.saveNames()
    }
    return [...this.statuses].map(([id, name]) => ({ id, name }))
  }

  private async loadCrew(force = false): Promise<void> {
    if (!force && this.crew.size && Date.now() - this.crewAt < LIST_REFRESH_MS) return
    const list = await this.list<{ id: number; displayname?: string; firstname?: string; lastname?: string; phone?: string; active?: boolean }>('/crew?fields=id,displayname,firstname,lastname,phone,active&limit=1500', 4)
    this.crew = new Map(list.map((c) => [String(c.id), this.crewOf(c)]))
    this.crewAt = Date.now()
    await this.saveNames()
  }

  /** Crew names/phones and status names survive a restart: the list, the scope of a user and the MCP need them before the first read. */
  private async saveNames(): Promise<void> {
    const crew = [...this.crew].map(([id, c]) => [id, c.name, c.raw, c.active ? 1 : 0])
    await setSetting(this.app.h, NAMES_KEY, JSON.stringify({ at: this.crewAt, crew, statuses: [...this.statuses] }))
  }

  private async loadNames(): Promise<void> {
    try {
      const n = JSON.parse((await getSetting(this.app.h, NAMES_KEY)) || 'null') as { at: number; crew: [string, string, string, number][]; statuses: [string, string][] } | null
      if (!n) return
      this.crew = new Map(n.crew.map(([id, name, raw, active]) => [id, { name, phone: normPhone(raw, this.cfg.countryCode), raw, active: !!active }]))
      this.statuses = new Map(n.statuses)
      this.crewAt = n.at || 0
    } catch {
      /* read again from Rentman */
    }
  }

  private crewOf(c: { id: number; displayname?: string; firstname?: string; lastname?: string; phone?: string; active?: boolean }) {
    return { name: String(c.displayname || [c.firstname, c.lastname].filter(Boolean).join(' ') || `#${c.id}`), phone: normPhone(c.phone, this.cfg.countryCode), raw: String(c.phone ?? ''), active: c.active !== false }
  }

  private async crewInfo(id: string) {
    const have = this.crew.get(id)
    if (have) return have
    try {
      const c = await this.one<{ id: number; displayname?: string; firstname?: string; lastname?: string; phone?: string; active?: boolean }>(`/crew/${id}?fields=id,displayname,firstname,lastname,phone,active`)
      const info = this.crewOf({ ...c, id: Number(id) })
      this.crew.set(id, info)
      return info
    } catch {
      return { name: `#${id}`, phone: null, raw: '', active: true }
    }
  }

  /** Planning ids (projectcrew) whose invitation was accepted: the latest 3000 accepted invitations, kept 1 minute. */
  private async acceptedSet(): Promise<Set<string>> {
    if (this.accepted && Date.now() - this.accepted.at < 60_000) return this.accepted.set
    const list = await this.list<{ projectcrew?: string | null; accepted?: boolean }>('/invitations?accepted=true&sort=-id&limit=1500&fields=id,projectcrew,accepted', 2)
    const set = new Set(list.filter((i) => i.accepted !== false).map((i) => idOf(i.projectcrew)).filter(Boolean) as string[])
    this.accepted = { at: Date.now(), set }
    return set
  }

  // ------------------------------------------------------------------ projects list
  private async proj(id: string): Promise<ProjRow | undefined> {
    return (await this.app.h.db.selectFrom('rm_projects').selectAll().where('id', '=', id).executeTakeFirst()) as ProjRow | undefined
  }

  private async setProj(id: string, set: Partial<ProjRow>): Promise<void> {
    if (await this.proj(id)) await this.app.h.db.updateTable('rm_projects').set(set).where('id', '=', id).execute()
    else await this.app.h.db.insertInto('rm_projects').values({ id, created_at: now(), sync: 0, state: 'off', ...set }).execute()
  }

  private projFields(p: Record<string, unknown>): Partial<ProjRow> {
    const loc = p.location && typeof p.location === 'object' ? String((p.location as { displayname?: string; name?: string }).displayname ?? (p.location as { name?: string }).name ?? '') || null : undefined
    return {
      name: String(p.name ?? p.displayname ?? `#${p.id}`),
      number: p.number != null && p.number !== '' ? String(p.number) : null,
      creator: idOf(p.creator),
      start_at: ts(p.planperiod_start),
      end_at: ts(p.planperiod_end),
      rms_created: ts(p.created),
      seen_at: now(),
      ...(loc !== undefined ? { location: loc } : {}),
    }
  }

  /** Read the latest projects (and their statuses) into the list. Statuses reached since the last read create groups (settings). */
  async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        if (!this.cfg.workspace) await this.test()
        await this.loadStatuses(true).catch((e) => logger.debug({ mod: 'rentman', err: errText(e) }, 'statuses not readable'))
        await this.loadCrew(true)
        const projects = await this.list<Record<string, unknown>>('/projects?sort=-id&limit=1500&fields=id,name,number,creator,planperiod_start,planperiod_end,created', 1)
        for (const p of projects) await this.setProj(String(p.id), this.projFields(p))
        const subs = await this.list<{ id: number; project?: string; status?: string }>('/subprojects?sort=-id&limit=1500&fields=id,project,status', 2)
        await this.applyStatuses(subs)
        this.lastRefresh = Date.now()
        logger.info({ mod: 'rentman', projects: projects.length }, `projects read from Rentman: ${projects.length}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  get isRefreshing(): boolean {
    return !!this.refreshing
  }

  /** Statuses of subprojects → stored per project; a project reaching an "auto" status gets its groups. */
  private async applyStatuses(subs: { id: number | string; project?: string | null; status?: string | null }[]): Promise<void> {
    const byProject = new Map<string, Record<string, string>>()
    for (const s of subs) {
      const p = idOf(s.project)
      const st = idOf(s.status)
      if (!p || !st) continue
      this.subIndex.set(String(s.id), p)
      if (!byProject.has(p)) byProject.set(p, {})
      byProject.get(p)![String(s.id)] = st
    }
    for (const [pid, upd] of byProject) {
      let row = await this.proj(pid)
      if (!row) {
        try {
          await this.setProj(pid, this.projFields(await this.one(`/projects/${pid}?fields=id,name,number,creator,planperiod_start,planperiod_end,created`)))
          row = await this.proj(pid)
        } catch {
          continue
        }
      }
      if (!row) continue
      const prev = row.statuses ? (JSON.parse(row.statuses) as Record<string, string>) : null
      const next = { ...(prev ?? {}), ...upd }
      await this.setProj(pid, { statuses: JSON.stringify(next) })
      if (!this.cfg.autoStatuses.length || row.sync || row.off_hand || row.auto_at) continue
      // a project seen before must REACH the status; one we never saw must be new (created after the setting)
      if (!statusHits(prev, upd, this.cfg.autoStatuses)) continue
      if (!prev && !(row.rms_created && row.rms_created >= this.cfg.autoSince - SLACK_MS)) continue
      await this.setProj(pid, { sync: 1, state: 'queued', auto_at: now(), mode: row.mode || this.cfg.mode, error: null })
      logger.info({ mod: 'rentman', project: pid }, `project ${row.name ?? pid} reached an automatic status: groups queued`)
      this.markDirty(pid)
    }
  }

  /** Projects for the page / API / MCP: current and upcoming ones, or the ones matching a search. */
  async projects(q?: string, scope: RmScope = null) {
    if (this.configured() && !this.crew.size) await this.loadCrew().catch(() => undefined)
    if (this.configured() && !this.statuses.size) await this.loadStatuses().catch(() => undefined)
    let rows = (await this.app.h.db.selectFrom('rm_projects').selectAll().execute()) as ProjRow[]
    const withGroups = new Set(((await this.app.h.db.selectFrom('rm_groups').select('project_id').where('group_jid', 'is not', null).execute()) as { project_id: string }[]).map((g) => g.project_id))
    const needle = (q ?? '').trim().toLowerCase()
    const from = now() - 7 * 86400_000
    rows = rows.filter((r) => (needle ? `${r.name ?? ''} ${r.number ?? ''} ${r.id}`.toLowerCase().includes(needle) : r.sync || withGroups.has(r.id) || (r.end_at ?? r.start_at ?? now()) >= from))
    if (scope) rows = rows.filter((r) => !!r.creator && scope.crew.has(r.creator))
    rows.sort((a, b) => (a.start_at ?? 9e15) - (b.start_at ?? 9e15) || Number(b.id) - Number(a.id))
    rows = rows.slice(0, 300)
    const ids = rows.map((r) => r.id)
    const groups = ids.length ? ((await this.app.h.db.selectFrom('rm_groups').selectAll().where('project_id', 'in', ids).execute()) as GroupRow[]) : []
    return rows.map((r) => {
      const snap = r.snap ? (JSON.parse(r.snap) as Snap) : null
      const st = r.statuses ? Object.values(JSON.parse(r.statuses) as Record<string, string>) : []
      const creator = r.creator ? this.crew.get(r.creator) : undefined
      return {
        id: r.id,
        name: r.name,
        number: r.number,
        start: r.start_at ? new Date(r.start_at).toISOString() : null,
        end: r.end_at ? new Date(r.end_at).toISOString() : null,
        location: snap?.location ?? r.location,
        statuses: uniq(st.map((s) => this.statuses.get(s) ?? `#${s}`)),
        creator: r.creator ? { id: r.creator, name: creator?.name ?? `#${r.creator}`, whatsapp: !!creator?.phone } : null,
        url: this.webUrl(r.id),
        sync: !!r.sync,
        state: r.state ?? 'off',
        error: r.error,
        auto: !!r.auto_at,
        mode: r.mode,
        crew: snap ? { planned: snap.crew.length, confirmed: snap.crew.filter((c) => c.ok).length, noPhone: snap.crew.filter((c) => c.ok && !c.phone).map((c) => c.name) } : null,
        groups: groups
          .filter((g) => g.project_id === r.id)
          .map((g) => ({ key: g.key, kind: g.kind, name: g.name, state: g.state, error: g.error, members: (JSON.parse(g.members || '[]') as string[]).length })),
      }
    })
  }

  // ------------------------------------------------------------------ WhatsApp numbers
  private mainAcc(): WaAccount {
    return this.app.accounts.get(this.cfg.account || undefined)
  }
  private backupAcc(): WaAccount | null {
    if (!this.cfg.backupAccount) return null
    try {
      const b = this.app.accounts.get(this.cfg.backupAccount)
      return b.row.id === this.mainAcc().row.id ? null : b
    } catch {
      return null
    }
  }
  /** The number carrying the groups now: the main one, or the backup while the main one is offline. */
  private activeAcc(): WaAccount {
    const main = this.mainAcc()
    if (main.state === 'open') return main
    const b = this.backupAcc()
    if (b && b.state === 'open') return b
    main.requireOpen()
    return main
  }
  private static phoneOf(a: WaAccount | null): string {
    return a ? userOf(a.row.me_jid ?? '') || a.row.phone || '' : ''
  }

  // ------------------------------------------------------------------ users
  /** A user limited to their own projects sees the projects created by the Rentman crew member with their WhatsApp number. */
  scopeOf(p: Principal): RmScope {
    if (p.kind !== 'user') return null
    const pp = pluginAccess(p.user, RM_ID)
    if (pp?.scope === 'all') return null
    const mine = phoneDigits(p.user?.phone)
    return { crew: new Set([...this.crew].filter(([, c]) => mine && c.phone === mine).map(([id]) => id)) }
  }

  // ------------------------------------------------------------------ switch a project on / off
  async setGroup(id: string, on: boolean, scope: RmScope = null): Promise<{ id: string; group: boolean; state: string }> {
    if (!/^\d{1,12}$/.test(id)) throw new AppError('RM_NO_PROJECT', 'Project {0} not found in Rentman', 404, [id])
    let row = await this.proj(id)
    if (!row && on) {
      try {
        await this.setProj(id, this.projFields(await this.one(`/projects/${id}?fields=id,name,number,creator,planperiod_start,planperiod_end,created`)))
      } catch (e) {
        if (e instanceof AppError && e.status === 404) throw new AppError('RM_NO_PROJECT', 'Project {0} not found in Rentman', 404, [id])
        throw e
      }
      row = await this.proj(id)
    }
    if (!row) throw new AppError('RM_NO_PROJECT', 'Project {0} not found in Rentman', 404, [id])
    if (scope && !(row.creator && scope.crew.has(row.creator))) throw new AppError('RM_NOT_YOURS', 'You can only manage the projects you created in Rentman', 403)
    const groups = await this.app.h.db.selectFrom('rm_groups').select('key').where('project_id', '=', id).where('group_jid', 'is not', null).execute()
    if (!on) {
      const state = groups.length ? 'paused' : 'off'
      await this.setProj(id, { sync: 0, state, off_hand: 1 })
      logger.info({ mod: 'rentman', project: id }, 'project groups off')
      return { id, group: false, state }
    }
    // fail fast when WhatsApp is not connected (new groups are created only by the main number)
    if (groups.length) this.activeAcc()
    else this.mainAcc().requireOpen()
    await this.setProj(id, { sync: 1, state: 'creating', off_hand: 0, error: null, mode: groups.length ? row.mode || this.cfg.mode : this.cfg.mode })
    void this.syncProject(id).catch(() => undefined)
    return { id, group: true, state: 'creating' }
  }

  // ------------------------------------------------------------------ read a project and bring its groups in line
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }

  private index(s: Snap): void {
    for (const c of s.crew) this.pcIndex.set(c.pc, s.id)
    for (const f of s.fns) this.fnIndex.set(f.id, s.id)
    for (const sub of s.subs) this.subIndex.set(sub.id, s.id)
  }

  /** Everything WhatsApp needs to know about a project: 5 calls (+ accepted invitations, shared). */
  async snapshot(id: string): Promise<Snap> {
    let p: Record<string, unknown>
    try {
      p = await this.one(`/projects/${id}?expand=location&fields=id,name,number,creator,planperiod_start,planperiod_end,created,location.displayname`)
    } catch (e) {
      if (!(e instanceof AppError) || e.status === 404 || e.code !== 'RM_ERROR') throw e
      p = await this.one(`/projects/${id}`) // the account does not allow expanding the location
    }
    const subs = await this.list<Record<string, unknown>>(`/projects/${id}/subprojects?fields=id,name,status,order,planperiod_start,planperiod_end`)
    const fgroups = await this.list<Record<string, unknown>>(`/projects/${id}/projectfunctiongroups?fields=id,name`)
    const fns = await this.list<Record<string, unknown>>(`/projects/${id}/projectfunctions?fields=id,name,name_external,subproject,group,planperiod_start,planperiod_end`)
    const pcs = await this.list<Record<string, unknown>>(`/projects/${id}/projectcrew?fields=id,function,crewmember,planperiod_start,planperiod_end`)
    const accepted = this.cfg.joinOn === 'accepted' ? await this.acceptedSet() : null
    const fnOf = new Map(fns.map((f) => [String(f.id), f]))
    const crew: SnapCrew[] = []
    for (const pc of pcs) {
      const cid = idOf(pc.crewmember)
      if (!cid) continue // a function still to be filled
      const info = await this.crewInfo(cid)
      const fid = idOf(pc.function) ?? ''
      const f = fnOf.get(fid)
      crew.push({
        pc: String(pc.id),
        crew: cid,
        name: info.name,
        phone: info.phone,
        fn: fid,
        fnName: String(f?.name || f?.name_external || '—'),
        start: ts(pc.planperiod_start) ?? ts(f?.planperiod_start),
        end: ts(pc.planperiod_end) ?? ts(f?.planperiod_end),
        ok: accepted ? accepted.has(String(pc.id)) : true,
      })
    }
    const loc = p.location && typeof p.location === 'object' ? String((p.location as { displayname?: string }).displayname ?? '') || null : null
    const s: Snap = {
      id: String(p.id ?? id),
      name: String(p.name ?? p.displayname ?? `#${id}`),
      number: p.number != null ? String(p.number) : '',
      location: loc,
      start: ts(p.planperiod_start),
      end: ts(p.planperiod_end),
      creator: idOf(p.creator),
      subs: subs
        .map((x) => ({ id: String(x.id), name: String(x.name ?? ''), status: idOf(x.status), start: ts(x.planperiod_start), end: ts(x.planperiod_end), order: Number(x.order ?? 0) }))
        .sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id))
        .map(({ order: _o, ...x }) => x),
      fgroups: fgroups.map((g) => ({ id: String(g.id), name: String(g.name ?? '') })),
      fns: fns.map((f) => ({ id: String(f.id), name: String(f.name || f.name_external || ''), sub: idOf(f.subproject), group: idOf(f.group), start: ts(f.planperiod_start), end: ts(f.planperiod_end) })),
      crew,
    }
    this.index(s)
    return s
  }

  private async groupsOf(projectId: string): Promise<GroupRow[]> {
    return (await this.app.h.db.selectFrom('rm_groups').selectAll().where('project_id', '=', projectId).execute()) as GroupRow[]
  }

  private async setGroupRow(key: string, set: Partial<GroupRow>): Promise<void> {
    const have = await this.app.h.db.selectFrom('rm_groups').select('key').where('key', '=', key).executeTakeFirst()
    if (have) await this.app.h.db.updateTable('rm_groups').set({ ...set, updated_at: now() }).where('key', '=', key).execute()
    else await this.app.h.db.insertInto('rm_groups').values({ key, created_at: now(), updated_at: now(), members: '[]', failed: '{}', ...set }).execute()
  }

  private async groupsToday(): Promise<number> {
    const rows = await this.app.h.db.selectFrom('rm_groups').select('key').where('created_at', '>', now() - 86400_000).where('group_jid', 'is not', null).execute()
    return rows.length
  }

  /** Read the project in Rentman and bring its WhatsApp groups in line (create, add, remove, admins, card, updates). */
  syncProject(id: string): Promise<void> {
    return this.lock(`p:${id}`, async () => {
      const row = await this.proj(id)
      if (!row?.sync) return
      try {
        await this.syncNow(row)
      } catch (e) {
        logger.error({ mod: 'rentman', project: id, err: errText(e) }, 'project groups not updated')
        await this.setProj(id, { state: 'error', error: errText(e) })
      }
    })
  }

  private async syncNow(row: ProjRow): Promise<void> {
    const id = row.id
    const snap = await this.snapshot(id)
    const existing = await this.groupsOf(id)
    await this.setProj(id, { snap: JSON.stringify(snap), name: snap.name, number: snap.number || null, creator: snap.creator, start_at: snap.start, end_at: snap.end, location: snap.location })
    if (existing.some((g) => g.group_jid) && snap.end && snap.end < now() - ENDED_MS) {
      await this.setProj(id, { state: 'ended', synced_at: now(), error: null })
      return
    }
    const mode = (RM_MODES.includes(row.mode as Mode) ? row.mode : this.cfg.mode) as Mode
    const lang = defaultLang()
    const tz = this.cfg.timezone
    const plans = desiredGroups(snap, mode, tr(lang, 'General'))
    // groups that exist but have nobody planned any more: their people must leave too
    for (const e of existing) if (!plans.some((p) => p.key === e.key)) plans.push({ key: e.key, kind: (e.kind as Mode) ?? mode, ref: e.ref_id ?? '', name: e.name ?? '', crew: [] })
    const main = this.mainAcc()
    const mainPhone = RentmanPlugin.phoneOf(main)
    const backup = RentmanPlugin.phoneOf(this.backupAcc())
    const own = new Set(uniq([mainPhone, backup]))
    const creatorPhone = this.cfg.creatorAdmin && snap.creator ? (await this.crewInfo(snap.creator)).phone : null
    const creatorName = snap.creator ? (await this.crewInfo(snap.creator)).name : null
    // admins: whoever created the project in Rentman and the backup number (the main number is the creator)
    const admins = uniq([creatorPhone, backup]).filter((p) => p !== mainPhone)
    let community = row.community_jid
    let waiting = false
    for (const g of plans) {
      const have = existing.find((e) => e.key === g.key)
      const want = uniq(g.crew.map((c) => c.phone)).filter((p) => !own.has(p))
      let jid = have?.group_jid ?? null
      const card = cardState(snap, g)
      const desc = `${projectTitle(snap)}${this.webUrl(id) ? ` — ${this.webUrl(id)}` : ''}\nRentman · WhatsOps`
      if (!jid) {
        if (!want.length && g.kind !== 'project') continue // no empty groups for subprojects / departments
        if ((await this.groupsToday()) >= GROUP_DAY_MAX) {
          waiting = true
          logger.warn({ mod: 'rentman', max: GROUP_DAY_MAX }, 'daily limit of new WhatsApp groups reached: the rest waits')
          break
        }
        main.requireOpen()
        if (mode !== 'project' && !community) {
          community = await createCommunity(main, projectTitle(snap), desc)
          await this.setProj(id, { community_jid: community })
          logger.info({ mod: 'rentman', project: id }, `WhatsApp community created for ${projectTitle(snap)}`)
        }
        jid = await createGroup(main, mode === 'project' ? projectTitle(snap) : clip(g.name, 100), desc, mode === 'project' ? null : community)
        await this.setGroupRow(g.key, { project_id: id, kind: g.kind, ref_id: g.ref, name: g.name, group_jid: jid, state: 'on', error: null, members: '[]', failed: '{}' })
        logger.info({ mod: 'rentman', project: id, group: g.key, mode }, `WhatsApp group created: ${g.name}`)
      }
      const acc = have?.group_jid ? this.activeAcc() : main
      const tracked = JSON.parse(have?.members || '[]') as string[]
      const failed = JSON.parse(have?.failed || '{}') as Record<string, number>
      const plan = planMembers(want, tracked, admins, this.cfg.removeOnUnplan)
      const add = plan.add.filter((p) => !(failed[p] && now() - failed[p] < RETRY_FAILED_MS))
      const invite = this.cfg.inviteFallback ? (mode === 'project' ? projectTitle(snap) : `${projectTitle(snap)} — ${g.name}`) : null
      const r = await addToGroup(acc, jid, add, invite)
      for (const p of r.failed) failed[p] = now()
      for (const p of [...r.added, ...r.invited]) delete failed[p]
      let gone: string[] = []
      if (plan.remove.length) gone = await removeFromGroup(acc, jid, plan.remove).catch((e) => (logger.warn({ mod: 'rentman', group: g.key, err: errText(e) }, 'people not removed'), [] as string[]))
      const members = uniq([...tracked.filter((p) => !gone.includes(p)), ...r.added, ...r.invited])
      const adminPhones = admins.filter((p) => p !== RentmanPlugin.phoneOf(acc))
      await ensureAdmins(acc, jid, adminPhones, mode === 'project' ? null : community, invite).catch((e) => logger.warn({ mod: 'rentman', group: g.key, err: errText(e) }, 'group admins not set'))
      if (this.cfg.posts !== 'none') {
        if (!have?.card) await postToGroup(acc, jid, cardText(lang, tz, card, creatorName))
        else if (this.cfg.posts === 'updates') {
          const d = diffText(lang, tz, JSON.parse(have.card) as CardState, card)
          if (d) await postToGroup(acc, jid, d)
        }
      }
      await this.setGroupRow(g.key, { project_id: id, kind: g.kind, ref_id: g.ref, name: g.name, members: JSON.stringify(members), failed: JSON.stringify(failed), admins: JSON.stringify(adminPhones), card: JSON.stringify(card), state: 'on', error: null })
      if (r.added.length || gone.length || r.invited.length) logger.info({ mod: 'rentman', group: g.key, added: r.added.length, invited: r.invited.length, removed: gone.length }, `crew updated in ${g.name}`)
    }
    await this.setProj(id, { state: waiting ? 'queued' : 'on', synced_at: now(), error: null, mode })
  }

  // ------------------------------------------------------------------ changes in Rentman
  private markDirty(id: string): void {
    this.dirty.add(id)
    if (this.kickTimer) return
    const t = setTimeout(() => {
      this.kickTimer = null
      void this.work()
    }, 3000)
    t.unref?.()
    this.kickTimer = t
  }

  /** Sync the projects that changed, one at a time. */
  private async work(): Promise<void> {
    if (this.working) return
    this.working = true
    try {
      while (this.dirty.size) {
        const id = this.dirty.values().next().value as string
        this.dirty.delete(id)
        const row = await this.proj(id)
        if (!row?.sync) continue
        try {
          if (this.mainAcc().state !== 'open' && !(await this.groupsOf(id)).some((g) => g.group_jid)) continue // waits for WhatsApp
        } catch {
          continue
        }
        await this.syncProject(id)
      }
    } finally {
      this.working = false
    }
  }

  private async syncedActive(): Promise<ProjRow[]> {
    const rows = (await this.app.h.db.selectFrom('rm_projects').selectAll().where('sync', '=', 1).execute()) as ProjRow[]
    return rows.filter((r) => r.state !== 'ended')
  }

  /**
   * Every N minutes (webhooks bring the same at once): what changed in Rentman since the last check —
   * subprojects (statuses), projects, planning, invitations, crew phones: 1 call each, only when needed.
   */
  async poll(): Promise<void> {
    if (!this.configured()) return
    const started = Date.now()
    const since = new Date((this.cfg.cursor || started - this.cfg.pollMinutes * 60_000) - SLACK_MS).toISOString()
    const q = `modified[gt]=${encodeURIComponent(since)}&limit=1500`
    const synced = await this.syncedActive()
    const isSynced = new Set(synced.map((r) => r.id))
    const hit = (pid: string | null | undefined) => {
      if (pid && isSynced.has(pid)) this.markDirty(pid)
    }
    if (this.cfg.autoStatuses.length || synced.length) {
      const subs = await this.list<{ id: number; project?: string; status?: string }>(`/subprojects?${q}&fields=id,project,status`, 3)
      await this.applyStatuses(subs)
      for (const s of subs) hit(idOf(s.project))
    }
    if (synced.length) {
      const projs = await this.list<Record<string, unknown>>(`/projects?${q}&fields=id,name,number,creator,planperiod_start,planperiod_end,created`, 3)
      for (const p of projs) {
        await this.setProj(String(p.id), this.projFields(p))
        hit(String(p.id))
      }
      const fns = await this.list<{ id: number; project?: string }>(`/projectfunctions?${q}&fields=id,project`, 3)
      for (const f of fns) {
        const pid = idOf(f.project)
        if (pid) this.fnIndex.set(String(f.id), pid)
        hit(pid)
      }
      const pcs = await this.list<{ id: number; function?: string }>(`/projectcrew?${q}&fields=id,function`, 3)
      for (const pc of pcs) hit(this.pcIndex.get(String(pc.id)) ?? this.fnIndex.get(idOf(pc.function) ?? ''))
      if (this.cfg.joinOn === 'accepted') {
        const inv = await this.list<{ id: number; projectcrew?: string | null }>(`/invitations?${q}&fields=id,projectcrew`, 3)
        if (inv.length) this.accepted = null
        for (const i of inv) hit(this.pcIndex.get(idOf(i.projectcrew) ?? ''))
      }
      const crew = await this.list<{ id: number; displayname?: string; firstname?: string; lastname?: string; phone?: string; active?: boolean }>(`/crew?${q}&fields=id,displayname,firstname,lastname,phone,active`, 2)
      for (const c of crew) this.crew.set(String(c.id), this.crewOf(c))
      if (crew.length) {
        const changed = new Set(crew.map((c) => String(c.id)))
        for (const r of synced) {
          const s = r.snap ? (JSON.parse(r.snap) as Snap) : null
          if (s?.crew.some((c) => changed.has(c.crew)) || (s?.creator && changed.has(s.creator))) hit(r.id)
        }
      }
      // removals are not in these feeds: re-read the synced projects every 30 minutes, a few at a time
      for (const r of synced.filter((x) => (x.synced_at ?? 0) < started - FULL_RESYNC_MS).slice(0, 5)) hit(r.id)
      for (const r of synced.filter((x) => x.state === 'queued' || (x.state === 'error' && (x.synced_at ?? 0) < started - 10 * 60_000))) hit(r.id)
    }
    this.cfg.cursor = started
    await this.save()
    this.lastPoll = Date.now()
  }

  /** A webhook from Rentman: work out which project changed, then sync it (or check its statuses). */
  async onHook(body: unknown): Promise<void> {
    const b = (body ?? {}) as { itemType?: string; eventType?: string; items?: unknown[]; account?: string }
    if (this.cfg.workspace && b.account && b.account !== this.cfg.workspace) return
    this.cfg.lastHookAt = now()
    const type = String(b.itemType ?? '')
    const ev = String(b.eventType ?? '')
    const items = (b.items ?? []).map((x) => (typeof x === 'object' && x ? (x as { id?: unknown; parent?: { id?: unknown; itemType?: string } }) : { id: x }))
    const projects = new Set<string>()
    for (const it of items) {
      const iid = idOf(it.id)
      if (!iid) continue
      const parent = 'parent' in it && it.parent ? it.parent : null
      const parentProject = parent?.itemType === 'Project' ? idOf(parent.id) : null
      if (type === 'Project') projects.add(iid)
      else if (type === 'Subproject') {
        const pid = parentProject ?? this.subIndex.get(iid) ?? (ev !== 'delete' ? idOf((await this.one<{ project?: string }>(`/subprojects/${iid}?fields=id,project`).catch(() => ({}) as { project?: string })).project) : null)
        if (pid) projects.add(pid)
      } else if (type === 'ProjectCrew') {
        let pid = this.pcIndex.get(iid) ?? null
        if (!pid && ev !== 'delete') {
          const pc = await this.one<{ function?: string }>(`/projectcrew/${iid}?fields=id,function`).catch(() => ({}) as { function?: string })
          const fid = idOf(pc.function)
          pid = (fid && this.fnIndex.get(fid)) || (fid ? idOf((await this.one<{ project?: string }>(`/projectfunctions/${fid}?fields=id,project`).catch(() => ({}) as { project?: string })).project) : null)
        }
        if (pid) projects.add(pid)
      } else if (type === 'ProjectFunction' || type === 'ProjectFunctionGroup') {
        const pid = parentProject ?? this.fnIndex.get(iid) ?? null
        if (pid) projects.add(pid)
      } else if (type === 'Crew') {
        this.crew.delete(iid)
        for (const r of await this.syncedActive()) {
          const s = r.snap ? (JSON.parse(r.snap) as Snap) : null
          if (s?.crew.some((c) => c.crew === iid) || s?.creator === iid) projects.add(r.id)
        }
      }
    }
    if (!projects.size) return
    if (type === 'ProjectCrew') this.accepted = null // an accepted invitation changes the planning
    for (const pid of projects) {
      const row = await this.proj(pid)
      if (row?.sync) this.markDirty(pid)
      else if (this.cfg.autoStatuses.length && (type === 'Subproject' || type === 'Project')) {
        const subs = await this.list<{ id: number; project?: string; status?: string }>(`/projects/${pid}/subprojects?fields=id,project,status`).catch(() => [])
        await this.applyStatuses(subs.map((s) => ({ ...s, project: s.project ?? `/projects/${pid}` })))
      }
    }
  }

  status(p?: Principal) {
    const base = { configured: this.configured(), refreshing: this.isRefreshing, lastRefresh: this.lastRefresh || null, lastPoll: this.lastPoll || null, callsToday: this.calls.day === new Date().toISOString().slice(0, 10) ? this.calls.n : 0 }
    if (p?.kind === 'user') {
      const pp = pluginAccess(p.user, RM_ID)
      return { ...base, ...(pp?.manage ? { config: this.publicConfig() } : { config: { workspace: this.cfg.workspace, mode: this.cfg.mode, timezone: this.cfg.timezone } }), me: { manage: !!pp?.manage, scope: pp?.scope ?? 'owned' } }
    }
    return { ...base, config: this.publicConfig() }
  }
}

// ---------------------------------------------------------------------- routes
type Need = 'view' | 'sync' | 'manage'
export function registerRentman(fastify: FastifyInstance, app: App, plugin: RentmanPlugin, tags: (t: string) => { tags: string[] }): void {
  const f = fastify.withTypeProvider<ZodTypeProvider>()
  const T = tags('Plugins')
  /** Owner, API keys and OAuth: by scope. Users: the plugin must be enabled for them; settings need its manage permission. */
  const access = (need: Need) => async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(app, req)
    if (!p) {
      reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
      throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
    }
    if (p.kind === 'user') {
      const pp = pluginAccess(p.user, RM_ID)
      if (!pp || (need === 'manage' && !pp.manage)) throw new AppError('FORBIDDEN', 'You are not allowed to do this', 403)
    } else requireScope(p, need === 'view' ? 'read' : need === 'sync' ? 'send' : 'admin')
    req.principal = p
  }
  const P = (req: FastifyRequest) => req.principal as Principal

  f.get(`/v1/plugins/${RM_ID}`, { preHandler: access('view'), schema: { ...T, summary: 'Rentman: connection, settings, webhook state' } }, async (req) => plugin.status(P(req)))
  f.put(
    `/v1/plugins/${RM_ID}/config`,
    {
      preHandler: access('manage'),
      schema: {
        ...T,
        summary: 'Rentman: save the connection and the plugin settings',
        body: z.object({
          token: z.string().max(4000).optional(),
          account: z.string().max(64).optional(),
          backupAccount: z.string().max(64).optional(),
          mode: z.enum(RM_MODES).optional(),
          creatorAdmin: z.boolean().optional(),
          joinOn: z.enum(['accepted', 'planned']).optional(),
          removeOnUnplan: z.boolean().optional(),
          posts: z.enum(['updates', 'card', 'none']).optional(),
          countryCode: z.string().max(8).optional(),
          inviteFallback: z.boolean().optional(),
          autoStatuses: z.array(z.string().max(40)).max(50).optional(),
          pollMinutes: z.union([z.literal(2), z.literal(5), z.literal(15), z.literal(30)]).optional(),
          webhookToken: z.string().max(500).optional(),
        }),
      },
    },
    async (req) => {
      await plugin.updateConfig(req.body)
      return plugin.status(P(req))
    },
  )
  f.post(`/v1/plugins/${RM_ID}/test`, { preHandler: access('manage'), schema: { ...T, summary: 'Rentman: test the connection (account name, country, time zone)' } }, async () => plugin.test())
  f.get(`/v1/plugins/${RM_ID}/statuses`, { preHandler: access('manage'), schema: { ...T, summary: 'Rentman: project statuses (pick the ones that create the groups by themselves)' } }, async () => plugin.loadStatuses(true))
  f.post(`/v1/plugins/${RM_ID}/refresh`, { preHandler: access('view'), schema: { ...T, summary: 'Rentman: read the projects again (runs in the background)' } }, async (req) => {
    const p = plugin.refresh()
    p.catch((e) => logger.warn({ mod: 'rentman', err: errText(e) }, 'refresh failed'))
    await Promise.race([p, new Promise((r) => setTimeout(r, 15_000))])
    return plugin.status(P(req))
  })
  f.get(
    `/v1/plugins/${RM_ID}/projects`,
    { preHandler: access('view'), schema: { ...T, summary: 'Rentman: current and upcoming projects with their WhatsApp groups (a user sees only what their permissions allow)', querystring: z.object({ q: z.string().max(200).optional() }) } },
    async (req) => plugin.projects(req.query.q, plugin.scopeOf(P(req))),
  )
  f.put(
    `/v1/plugins/${RM_ID}/projects/:id`,
    { preHandler: access('sync'), schema: { ...T, summary: 'Rentman: create the WhatsApp groups of a project, or stop managing them', params: z.object({ id: z.string().max(20) }), body: z.object({ group: z.boolean() }) } },
    async (req) => plugin.setGroup(req.params.id, req.body.group, plugin.scopeOf(P(req))),
  )

  // webhook target (no login: the secret is in the URL, and Rentman signs the body)
  fastify.register(async (inst) => {
    inst.removeContentTypeParser('application/json')
    inst.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (req, body, done) => {
      ;(req as FastifyRequest & { rawBody?: string }).rawBody = String(body)
      try {
        done(null, body ? JSON.parse(String(body)) : {})
      } catch (e) {
        done(e as Error, undefined)
      }
    })
    inst.post(`/plugins/${RM_ID}/hook/:secret`, { schema: { hide: true } }, async (req, reply) => {
      const secret = (req.params as { secret?: string }).secret
      if (!plugin.cfg.hookSecret || secret !== plugin.cfg.hookSecret) return reply.code(404).send()
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? ''
      if (plugin.cfg.webhookToken && !verifyDigest(raw, req.headers.digest, plugin.cfg.webhookToken)) {
        logger.warn({ mod: 'rentman' }, 'webhook with a wrong signature ignored (check the token in the plugin settings)')
        return reply.code(401).send({ ok: false })
      }
      void plugin.onHook(req.body).catch((e) => logger.warn({ mod: 'rentman', err: errText(e) }, 'webhook handling failed'))
      return { ok: true }
    })
  })
}
