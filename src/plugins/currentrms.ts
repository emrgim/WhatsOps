/**
 * Plugin: Current RMS (OnRent Events) discussions ⇄ WhatsApp.
 *
 * Every discussion in Current RMS is attached to a record (opportunity, project, contact, invoice,
 * product, activity…). What is synced is chosen per record type, on three levels:
 *   record      a WhatsApp group for every new record (e.g. a new opportunity)
 *   discussion  a group for every new discussion on those records
 *   messages    comments ⇄ WhatsApp messages in the discussion groups (off: groups only for chatting,
 *               no Current RMS call per message)
 * Existing records and discussions get a group from the switches in the list. A discussion group
 * (or a group inside a Community for the record — a plugin setting) gets the discussion
 * participants that have a WhatsApp number in the chosen custom field; with messages on, it gets
 * the whole discussion so far, then mirrors both ways:
 *   Current → WhatsApp  new comment (webhook `discussion_comment`, or polling) → "*Name*\ntext"
 *   WhatsApp → Current  message in the group → comment (as the matching member when possible)
 * Loop guard: every mirrored item is recorded (comment id ⇄ WhatsApp message id) and skipped.
 *
 * API: https://api.current-rms.com/api/v1, headers X-SUBDOMAIN + X-AUTH-TOKEN, 60 requests/min,
 * pages of max 100. Webhooks have no signature: the target URL carries a random secret.
 */
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { generateMessageIDV2 } from '@whiskeysockets/baileys'
import { getSetting, now, setSetting } from '../db/index.js'
import type { WaEvent } from '../events.js'
import { logger } from '../log.js'
import { AppError, toJid, userOf } from '../util.js'
import { authenticate, requireScope, type App } from '../app.js'
import { publicOrigin, requestIp, sha256, type Principal } from '../security/auth.js'
import { reqLang, tr, type Lang } from '../i18n.js'
import { phoneDigits, pluginAccess, type User } from '../users.js'
import { joinPage, messagePage } from '../ui/pages.js'
import type { WaAccount } from '../wa/account.js'

export const PLUGIN_ID = 'currentrms'
const API = (process.env.WA_CRMS_API || 'https://api.current-rms.com/api/v1').replace(/\/+$/, '')
const CONFIG_KEY = 'plugin:currentrms'
export const POLL_CHOICES = [2, 5, 15, 30] as const // minutes between checks of the synced discussions
const LIST_REFRESH_MS = 30 * 60_000
const GROUP_GAP_MS = 45_000 // never create WhatsApp groups in a burst
const MAX_CHUNK = 3500

// ------------------------------------------------------------------ what to sync (3 levels per record type)
/** Record types the plugin can follow. Products and services are both "Item" in webhooks and discussions. */
export const LEVEL_TYPES = ['Opportunity', 'Project', 'Product', 'Service', 'Member', 'Invoice', 'Activity', 'Quarantine', 'PurchaseOrder'] as const
/**
 * Per record type: objects = a WhatsApp group for every new record; discussions = a group for every new
 * discussion on those records; messages = comments ⇄ WhatsApp messages in the discussion groups.
 */
export type Levels = { objects: boolean; discussions: boolean; messages: boolean }
const HOOK_PREFIX: Record<string, string> = { Opportunity: 'opportunity', Project: 'project', Product: 'item', Service: 'item', Member: 'member', Invoice: 'invoice', Activity: 'activity', Quarantine: 'quarantine', PurchaseOrder: 'po' }
const SLACK_MS = 2 * 60_000 // clock difference allowed between Current RMS and this computer
const AUTO_DAY_MAX = 50 // automatic groups per 24 h at most: WhatsApp limits how many groups a number creates
const AUTO_PER_CHECK = 25
export const levelKey = (type: string): string => (type === 'Item' ? 'Product' : type)
export const objKey = (type: string, id: string | number): string => `${levelKey(type)}:${id}`

/** Levels for every record type: nothing is created by itself unless chosen; messages are mirrored unless switched off. */
export function normLevels(input: unknown): Record<string, Levels> {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, Partial<Levels> | undefined>
  const out: Record<string, Levels> = {}
  for (const t of LEVEL_TYPES) {
    const l = src[t] ?? {}
    out[t] = { objects: !!l.objects, discussions: !!l.discussions, messages: l.messages === undefined ? true : !!l.messages }
  }
  return out
}

/** The Current RMS webhook events the chosen levels need. */
export function hookEvents(levels: Record<string, Levels>): string[] {
  const ev = new Set<string>()
  for (const t of LEVEL_TYPES) {
    const l = levels[t]
    if (!l) continue
    if (l.messages) ev.add('discussion_comment')
    if (l.discussions) ev.add(`${HOOK_PREFIX[t]}_discuss`)
    if (l.objects) ev.add(`${HOOK_PREFIX[t]}_create`)
  }
  return [...ev].sort()
}

/** Records created since `since` that have not been handled yet, oldest first, at most `max`. */
export function pickNew<T extends { id: string; createdAt: number }>(list: T[], since: number, seen: Set<string>, max: number): T[] {
  return list
    .filter((x) => !seen.has(x.id) && x.createdAt >= since)
    .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id))
    .slice(0, max)
}
const errText = (e: unknown) => (e instanceof AppError ? e.message : String((e as Error)?.message ?? e)).slice(0, 500)

export type CrmsConfig = {
  subdomain: string
  apiKey: string
  account: string // WhatsApp account id (phone number)
  mode: 'groups' | 'community'
  whatsappField: string // Member custom field (document_layout_name) holding the WhatsApp number
  inviteFallback: boolean // send the invite link privately to people who can't be added
  ownerAdmin: boolean // the owner of the record in Current RMS (a user with a registered number) is admin of its groups
  backupAccount: string // second WhatsOps number: admin of every group and Community, takes over if the main one is offline
  pollMinutes: number // check the synced discussions every N minutes (2, 5, 15, 30); webhooks bring changes at once anyway
  hookSecret: string
  hooks: { id: number; event: string }[]
  hooksError: string | null
  hookBase: string // public URL the webhooks were registered with: they follow the levels when these change
  levels: Record<string, Levels>
  since: Record<string, number> // 'obj:<Type>' / 'disc:<Type>' → when that level was turned on: only what is created after gets a group by itself
  cursor: Record<string, number> // newest creation time already read ('obj:<Type>', 'disc')
}
const DEFAULT_CONFIG: CrmsConfig = { subdomain: '', apiKey: '', account: '', mode: 'groups', whatsappField: '', inviteFallback: true, ownerAdmin: true, backupAccount: '', pollMinutes: 2, hookSecret: '', hooks: [], hooksError: null, hookBase: '', levels: normLevels({}), since: {}, cursor: {} }
export type ConfigPatch = Partial<Pick<CrmsConfig, 'subdomain' | 'apiKey' | 'account' | 'mode' | 'whatsappField' | 'inviteFallback' | 'ownerAdmin' | 'backupAccount' | 'pollMinutes'>> & { levels?: Record<string, Partial<Levels>> }

type Participant = { memberId: number; name: string; whatsapp: string | null }
type DiscRow = {
  id: string
  subject: string | null
  object_type: string
  object_id: string
  object_name: string | null
  participants: string | null
  reply_count: number | null
  last_comment_id: number | null
  last_at: number | null
  sync: number | null
  state: string | null
  group_jid: string | null
  error: string | null
  synced_comment_id: number | null
  created_at: number | null
  owner_member_id: string | null
  admins: string | null
  auto_at: number | null // set when the group is (to be) created by itself: never switched on again after a manual off
  rms_created_at: number | null
}
/** A record (opportunity, product…): its Community and its own WhatsApp group. */
type ObjRow = {
  key: string
  community_jid: string | null
  name: string | null
  created_at: number | null
  object_type: string | null
  object_id: string | null
  group_jid: string | null
  sync: number | null
  state: string | null
  error: string | null
  owner_member_id: string | null
  admins: string | null
  participants: string | null
  auto_at: number | null
  rms_created_at: number | null
}
type RecInfo = { type: string; id: string; name: string; owner: string | null; createdAt: number; memberIds: number[]; membership?: string }
type RawDisc = { id: number; subject?: string; discussable_type: string; discussable_id: number; reply_count?: number; last_comment_id?: number; updated_at?: string; created_at?: string; participants?: { member_id: number }[] }
type CrmsUserRow = {
  member_id: string
  name: string | null
  email: string | null
  phone: string | null
  verified_at: number | null
  invite_hash: string | null
  invite_expires: number | null
  code_hash: string | null
  code_phone: string | null
  code_expires: number | null
  code_tries: number | null
  sends: string | null
  created_at: number | null
}
type RmsUser = { name: string; email: string | null; whatsapp: string | null }
/** What a caller may see and switch: null = everything; otherwise only the records owned by that Current RMS user. */
export type Scope = { member: string | null } | null
const INVITE_DAYS = 14
const mask = (d: string | null | undefined) => (d ? `+${d.slice(0, 2)} ••• ${d.slice(-4)}` : null)

/** Who must be added to a group and who promoted to admin, given the group's participants. */
export function planAdmins(participants: { id: string; phoneNumber?: string; admin?: string | null }[], phones: string[]): { add: string[]; promote: string[] } {
  const add: string[] = []
  const promote: string[] = []
  for (const ph of phones) {
    const p = participants.find((x) => userOf(x.phoneNumber ?? '') === ph || (x.id.endsWith('@s.whatsapp.net') && userOf(x.id) === ph))
    if (!p) add.push(ph)
    else if (!p.admin) promote.push(p.id)
  }
  return { add, promote }
}

/** Discussable types → API collection, name field, path in the web app, short label. */
const TYPES: Record<string, { coll: string; one: string; name: string; web: string; short: string }> = {
  Opportunity: { coll: 'opportunities', one: 'opportunity', name: 'subject', web: 'opportunities', short: 'Opp.' },
  Project: { coll: 'projects', one: 'project', name: 'name', web: 'projects', short: 'Prj.' },
  Member: { coll: 'members', one: 'member', name: 'name', web: 'members', short: '' },
  Invoice: { coll: 'invoices', one: 'invoice', name: 'subject', web: 'invoices', short: 'Inv.' },
  Item: { coll: 'products', one: 'product', name: 'name', web: 'products', short: '' },
  Product: { coll: 'products', one: 'product', name: 'name', web: 'products', short: '' },
  Service: { coll: 'services', one: 'service', name: 'name', web: 'services', short: '' },
  Activity: { coll: 'activities', one: 'activity', name: 'subject', web: 'activities', short: 'Act.' },
  Quarantine: { coll: 'quarantines', one: 'quarantine', name: 'reference', web: 'quarantines', short: 'Qua.' },
  PurchaseOrder: { coll: 'purchase_orders', one: 'purchase_order', name: 'subject', web: 'purchase_orders', short: 'PO' },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** Comments come as HTML or plain text; WhatsApp wants plain text with *bold*. */
export function htmlToText(s: string): string {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<(strong|b)>(.*?)<\/\1>/gi, '*$2*')
    .replace(/<(em|i)>(.*?)<\/\1>/gi, '_$2_')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
type RawComment = Record<string, unknown> & { id: number; created_at?: string }
const commentText = (c: RawComment) => htmlToText(String(c.remark ?? c.body ?? c.text ?? c.comment ?? c.content ?? ''))
function commentAuthor(c: RawComment): string {
  const m = (c.member ?? c.creator ?? c.created_by_member) as { name?: string } | undefined
  return String(m?.name ?? c.member_name ?? c.created_by_name ?? c.author ?? '').trim() || '—'
}

export class CurrentRmsPlugin {
  cfg: CrmsConfig = { ...DEFAULT_CONFIG }
  private calls: number[] = []
  private locks = new Map<string, Promise<unknown>>()
  private ownSent = new Set<string>() // WhatsApp ids we are sending right now (mirrors)
  private lastGroupAt = 0
  private refreshing: Promise<void> | null = null
  lastRefresh = 0
  lastPoll = 0
  private pollStarted = Date.now()
  private rmsUsers = new Map<string, RmsUser>() // Current RMS users (membership type User) by member id
  private usersAt = 0
  private adminQueue = new Set<string>()
  private adminRunning = false
  private draining = false
  private capLogged = 0
  private groupGate: Promise<void> = Promise.resolve()

  constructor(private app: App) {}

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    try {
      this.cfg = { ...DEFAULT_CONFIG, ...(JSON.parse((await getSetting(this.app.h, CONFIG_KEY)) || '{}') as Partial<CrmsConfig>) }
    } catch {
      this.cfg = { ...DEFAULT_CONFIG }
    }
    if (!this.cfg.hookSecret) {
      this.cfg.hookSecret = crypto.randomBytes(18).toString('base64url')
      await this.save()
    }
    this.app.bus.on('event', (ev: WaEvent) => void this.onWhatsApp(ev).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'WhatsApp → Current failed')))
    if (!POLL_CHOICES.includes(this.cfg.pollMinutes as 2)) this.cfg.pollMinutes = 2
    this.cfg.levels = normLevels(this.cfg.levels)
    this.cfg.since = { ...(this.cfg.since ?? {}) }
    this.cfg.cursor = { ...(this.cfg.cursor ?? {}) }
    this.cfg.hookBase ??= ''
    // an old "connect first" error from pressing Register before connecting
    if (!this.configured() && this.cfg.hooksError && !this.cfg.hooks.length) {
      this.cfg.hooksError = null
      await this.save()
    }
    // ticks every 30 s; polls when the chosen interval has passed
    setInterval(() => {
      if (Date.now() - this.pollStarted < this.cfg.pollMinutes * 60_000) return
      this.pollStarted = Date.now()
      void this.poll().catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'poll failed'))
    }, 30_000).unref()
    setInterval(() => {
      if (this.configured()) void this.refresh().catch(() => undefined)
    }, LIST_REFRESH_MS).unref()
  }

  configured(): boolean {
    return !!(this.cfg.subdomain && this.cfg.apiKey)
  }

  private async save(): Promise<void> {
    await setSetting(this.app.h, CONFIG_KEY, JSON.stringify(this.cfg))
  }

  publicConfig() {
    const { apiKey, hookSecret, cursor: _c, ...rest } = this.cfg
    return { ...rest, levelTypes: LEVEL_TYPES, apiKeySet: !!apiKey, hookUrl: hookSecret ? `/plugins/${PLUGIN_ID}/hook/${hookSecret}` : null }
  }

  /** Are comments ⇄ WhatsApp messages mirrored for this kind of record? */
  msgOn(type: string): boolean {
    return this.cfg.levels[levelKey(type)]?.messages ?? true
  }

  async updateConfig(p: ConfigPatch): Promise<void> {
    const before = `${this.cfg.ownerAdmin}|${this.cfg.backupAccount}|${this.cfg.account}`
    if (p.subdomain !== undefined) this.cfg.subdomain = p.subdomain.trim().replace(/^https?:\/\//, '').replace(/\.current-rms\.com.*$/, '').toLowerCase()
    if (p.apiKey) this.cfg.apiKey = p.apiKey.trim()
    if (p.account !== undefined) this.cfg.account = p.account
    if (p.mode) this.cfg.mode = p.mode === 'community' ? 'community' : 'groups'
    if (p.whatsappField !== undefined) this.cfg.whatsappField = p.whatsappField
    if (p.inviteFallback !== undefined) this.cfg.inviteFallback = !!p.inviteFallback
    if (p.ownerAdmin !== undefined) this.cfg.ownerAdmin = !!p.ownerAdmin
    if (p.backupAccount !== undefined) this.cfg.backupAccount = p.backupAccount
    if (p.pollMinutes !== undefined) {
      if (!POLL_CHOICES.includes(p.pollMinutes as 2)) throw new AppError('CRMS_POLL', 'Choose 2, 5, 15 or 30 minutes', 400)
      this.cfg.pollMinutes = p.pollMinutes
    }
    let msgTurnedOn: string[] = []
    let hooksChanged = false
    if (p.levels) {
      const merged: Record<string, Partial<Levels>> = {}
      for (const t of LEVEL_TYPES) merged[t] = { ...this.cfg.levels[t], ...(p.levels[t] ?? {}) }
      const next = normLevels(merged)
      for (const t of LEVEL_TYPES) {
        for (const [k, sk] of [['objects', `obj:${t}`], ['discussions', `disc:${t}`]] as const) {
          // only what is created from now on gets a group by itself
          if (next[t][k] && !this.cfg.levels[t][k]) {
            this.cfg.since[sk] = Date.now()
            if (k === 'objects') delete this.cfg.cursor[sk]
          }
          if (!next[t][k]) delete this.cfg.since[sk]
        }
      }
      msgTurnedOn = LEVEL_TYPES.filter((t) => next[t].messages && !this.cfg.levels[t].messages)
      hooksChanged = hookEvents(next).join() !== hookEvents(this.cfg.levels).join()
      this.cfg.levels = next
    }
    await this.save()
    // messages switched on: start from the comments there are now, never flood a group with the old ones
    if (msgTurnedOn.length) await this.rebaseline(msgTurnedOn).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'message sync start point not set'))
    if (hooksChanged && this.cfg.hookBase && this.configured()) void this.registerHooks(this.cfg.hookBase).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'webhooks not updated'))
    // new backup number or owner rule: bring the existing groups in line, one at a time
    if (before !== `${this.cfg.ownerAdmin}|${this.cfg.backupAccount}|${this.cfg.account}`) this.queueAdmins(await this.syncedIds())
  }

  // ------------------------------------------------------------------ Current RMS API
  private async rate(): Promise<void> {
    for (;;) {
      const t = Date.now()
      this.calls = this.calls.filter((x) => t - x < 60_000)
      if (this.calls.length < 50) break
      await sleep(60_000 - (t - this.calls[0]) + 50)
    }
    this.calls.push(Date.now())
  }

  async api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured()) throw new AppError('CRMS_NOT_CONFIGURED', 'Connect Current RMS first (subdomain and API key)', 409)
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.rate()
      let r: Response
      try {
        r = await fetch(`${API}${path}`, {
          method,
          headers: { 'X-SUBDOMAIN': this.cfg.subdomain, 'X-AUTH-TOKEN': this.cfg.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        })
      } catch (e) {
        if (attempt === 2) throw new AppError('CRMS_UNREACHABLE', 'Current RMS cannot be reached right now', 503)
        await sleep(2000)
        continue
      }
      if (r.status === 429) {
        const reset = Number(r.headers.get('x-ratelimit-reset') || 0)
        await sleep(Math.min(65_000, reset ? Math.max(1000, reset * 1000 - Date.now()) : 15_000))
        continue
      }
      const text = await r.text()
      let j: unknown = {}
      try {
        j = text ? JSON.parse(text) : {}
      } catch {
        j = { raw: text.slice(0, 200) }
      }
      if (r.status === 401 || r.status === 403) throw new AppError('CRMS_AUTH', 'Current RMS refused the subdomain or the API key', 401)
      if (!r.ok) {
        const msg = (j as { errors?: unknown; error?: unknown }).errors ?? (j as { error?: unknown }).error ?? text.slice(0, 200)
        throw new AppError('CRMS_ERROR', 'Current RMS answered {0}: {1}', 502, [r.status, typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300)])
      }
      return j as T
    }
    throw new AppError('CRMS_UNREACHABLE', 'Current RMS cannot be reached right now', 503)
  }

  private async all<T>(path: string, key: string, max = 50): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= max; page++) {
      const sep = path.includes('?') ? '&' : '?'
      const j = await this.api<Record<string, unknown>>('GET', `${path}${sep}page=${page}&per_page=100`)
      const list = (j[key] as T[]) ?? []
      out.push(...list)
      const total = Number((j.meta as { total_row_count?: number } | undefined)?.total_row_count ?? 0)
      if (list.length < 100 || (total && out.length >= total)) break
    }
    return out
  }

  async test() {
    const d = await this.api<{ discussions?: unknown[]; meta?: { total_row_count?: number } }>('GET', '/discussions?per_page=1')
    return { ok: true, discussions: Number(d.meta?.total_row_count ?? d.discussions?.length ?? 0) }
  }

  async customFields() {
    const list = await this.all<{ id: number; name: string; document_layout_name?: string; module_type?: string; field_type?: number | string }>('/custom_fields?q[module_type_eq]=Member', 'custom_fields', 5)
    return list.filter((f) => !f.module_type || f.module_type === 'Member').map((f) => ({ key: f.document_layout_name || f.name, name: f.name }))
  }

  webUrl(type: string, id: string): string {
    const t = TYPES[type]
    return `https://${this.cfg.subdomain}.current-rms.com/${t ? t.web : type.toLowerCase() + 's'}/${id}`
  }

  // ------------------------------------------------------------------ discussions list
  /** Read every discussion from Current RMS and keep the table in step (sync flags survive). */
  async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const list = await this.all<RawDisc>('/discussions', 'discussions')
        // names of the records the discussions belong to
        const byType = new Map<string, Set<number>>()
        for (const d of list) {
          if (!byType.has(d.discussable_type)) byType.set(d.discussable_type, new Set())
          byType.get(d.discussable_type)!.add(d.discussable_id)
        }
        const names = new Map<string, string>()
        const owners = new Map<string, string>() // record → owner user (member id)
        for (const [type, ids] of byType) {
          const t = TYPES[type]
          if (!t) continue
          const arr = [...ids]
          for (let i = 0; i < arr.length; i += 50) {
            const q = arr.slice(i, i + 50).map((id) => `q[id_in][]=${id}`).join('&')
            try {
              const rows = await this.all<Record<string, unknown>>(`/${t.coll}?${q}`, t.coll, 1)
              for (const r of rows) {
                names.set(`${type}:${r.id}`, String(r[t.name] ?? r.name ?? r.subject ?? `#${r.id}`))
                if (r.owned_by != null && r.owned_by !== '') owners.set(`${type}:${r.id}`, String(r.owned_by))
              }
            } catch (e) {
              logger.debug({ mod: 'currentrms', type, err: String(e) }, 'record names not readable')
            }
          }
        }
        // participants: names and WhatsApp numbers, 100 members per call
        const members = await this.membersById(list.flatMap((d) => (d.participants ?? []).map((p) => p.member_id)))
        await this.loadUsers(true).catch((e) => logger.debug({ mod: 'currentrms', err: String(e) }, 'users not readable'))
        const have = new Map(((await this.app.h.db.selectFrom('crms_discussions').selectAll().execute()) as DiscRow[]).map((r) => [r.id, r]))
        const ownerChanged: string[] = []
        for (const d of list) {
          const id = String(d.id)
          const cur = have.get(id)
          const row: Partial<DiscRow> = {
            subject: d.subject ?? null,
            object_type: d.discussable_type,
            object_id: String(d.discussable_id),
            object_name: names.get(`${d.discussable_type}:${d.discussable_id}`) ?? cur?.object_name ?? null,
            participants: d.participants
              ? JSON.stringify(d.participants.map((p) => members.get(p.member_id) ?? { memberId: p.member_id, name: '', whatsapp: null }))
              : cur?.participants ?? '[]',
            reply_count: d.reply_count ?? null,
            last_comment_id: d.last_comment_id ?? null,
            last_at: Date.parse(d.updated_at ?? d.created_at ?? '') || null,
            owner_member_id: owners.get(`${d.discussable_type}:${d.discussable_id}`) ?? cur?.owner_member_id ?? null,
            rms_created_at: Date.parse(d.created_at ?? '') || cur?.rms_created_at || null,
          }
          if (cur?.sync && cur.group_jid && row.owner_member_id !== cur.owner_member_id) ownerChanged.push(id)
          if (cur) await this.app.h.db.updateTable('crms_discussions').set(row).where('id', '=', id).execute()
          else await this.app.h.db.insertInto('crms_discussions').values({ ...row, id, sync: 0, state: 'off', group_jid: null, error: null, synced_comment_id: null, created_at: now() }).execute()
        }
        this.lastRefresh = Date.now()
        if (ownerChanged.length) this.queueAdmins(ownerChanged)
        await this.handleNewDiscussions(list).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'new discussions not handled'))
        logger.info({ mod: 'currentrms', discussions: list.length }, `discussions read from Current RMS: ${list.length}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** Records → discussions, for the plugin page / API / MCP. */
  async tree(q?: string, scope: Scope = null) {
    const rows = (await this.app.h.db.selectFrom('crms_discussions').selectAll().execute()) as DiscRow[]
    const objs = new Map(((await this.app.h.db.selectFrom('crms_objects').selectAll().execute()) as ObjRow[]).map((o) => [o.key, o]))
    const groupOf = (o: ObjRow | undefined) => (o && (o.sync || o.group_jid || o.state === 'queued') ? { sync: !!o.sync, state: o.state ?? 'off', jid: o.group_jid, error: o.error } : null)
    const registered = new Set(((await this.app.h.db.selectFrom('crms_users').select(['member_id', 'phone', 'verified_at']).execute()) as CrmsUserRow[]).filter((u) => u.phone && u.verified_at).map((u) => u.member_id))
    const needle = (q ?? '').trim().toLowerCase()
    type Rec = { type: string; id: string; name: string; url: string; owner: { id: string; name: string; whatsapp: boolean } | null; group: ReturnType<typeof groupOf>; discussions: unknown[]; last: number }
    const groups = new Map<string, Rec>()
    const ownerOf = (id: string | null) => {
      if (!id) return null
      const ou = this.rmsUsers.get(id)
      return { id, name: ou?.name || `#${id}`, whatsapp: registered.has(id) || !!ou?.whatsapp }
    }
    for (const r of rows) {
      if (!this.inScope(r, scope)) continue
      const name = r.object_name || `${r.object_type} #${r.object_id}`
      if (needle && !`${name} ${r.subject ?? ''}`.toLowerCase().includes(needle)) continue
      const k = objKey(r.object_type, r.object_id)
      if (!groups.has(k)) groups.set(k, { type: r.object_type, id: r.object_id, name, url: this.webUrl(r.object_type, r.object_id), owner: ownerOf(r.owner_member_id), group: groupOf(objs.get(k)), discussions: [], last: 0 })
      const g = groups.get(k)!
      const parts = JSON.parse(r.participants || '[]') as Participant[]
      g.discussions.push({
        id: r.id,
        subject: r.subject,
        replies: r.reply_count,
        lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        participants: parts.map((p) => ({ name: p.name || `#${p.memberId}`, whatsapp: !!p.whatsapp })),
        sync: !!r.sync,
        state: r.state ?? 'off',
        group: r.group_jid,
        error: r.error,
        messages: this.msgOn(r.object_type),
      })
      g.last = Math.max(g.last, r.last_at ?? 0)
    }
    // records with their own group and no discussion yet (e.g. a new opportunity)
    for (const [k, o] of objs) {
      if (groups.has(k) || !o.object_type || !o.object_id || !groupOf(o) || !this.inScope(o, scope)) continue
      const name = o.name || `${o.object_type} #${o.object_id}`
      if (needle && !name.toLowerCase().includes(needle)) continue
      groups.set(k, { type: o.object_type, id: o.object_id, name, url: this.webUrl(o.object_type, o.object_id), owner: ownerOf(o.owner_member_id), group: groupOf(o), discussions: [], last: o.rms_created_at ?? o.created_at ?? 0 })
    }
    return [...groups.values()].sort((a, b) => b.last - a.last).map(({ last: _l, ...g }) => g)
  }

  // ------------------------------------------------------------------ sync on / off
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }

  /** The number that creates the groups (the default one unless set in the plugin). */
  private mainAcc(): WaAccount {
    return this.app.accounts.get(this.cfg.account || undefined)
  }

  /** The backup number (second admin), if set and different from the main one. */
  private backupAcc(): WaAccount | null {
    if (!this.cfg.backupAccount) return null
    try {
      const b = this.app.accounts.get(this.cfg.backupAccount)
      return b.row.id === this.mainAcc().row.id ? null : b
    } catch {
      return null
    }
  }

  /** The number that carries the sync now: the main one, or the backup while the main one is offline. */
  private activeAcc(): WaAccount {
    const main = this.mainAcc()
    if (main.state === 'open') return main
    const b = this.backupAcc()
    if (b && b.state === 'open') return b
    main.requireOpen()
    return main
  }

  private activeId(): string | null {
    try {
      return this.activeAcc().row.id
    } catch {
      return null
    }
  }

  private static phoneOf(a: WaAccount | null): string {
    return a ? userOf(a.row.me_jid ?? '') || a.row.phone || '' : ''
  }

  /** Records a user may see and switch: null = all of them. */
  scopeOf(p: Principal): Scope {
    if (p.kind !== 'user') return null
    const pp = pluginAccess(p.user, PLUGIN_ID)
    if (pp?.scope === 'all') return null
    const src = p.user?.source ?? ''
    return { member: src.startsWith(`${PLUGIN_ID}:`) ? src.slice(PLUGIN_ID.length + 1) : null }
  }

  private inScope(r: { owner_member_id: string | null }, scope: Scope): boolean {
    return !scope || (!!scope.member && r.owner_member_id === scope.member)
  }

  /** Groups WhatsOps manages: discussion ids, and 'obj:<key>' for the groups of records. */
  private async syncedIds(ownerMemberId?: string): Promise<string[]> {
    let q = this.app.h.db.selectFrom('crms_discussions').select('id').where('sync', '=', 1).where('group_jid', 'is not', null)
    if (ownerMemberId) q = q.where('owner_member_id', '=', ownerMemberId)
    let q2 = this.app.h.db.selectFrom('crms_objects').select('key').where('sync', '=', 1).where('group_jid', 'is not', null)
    if (ownerMemberId) q2 = q2.where('owner_member_id', '=', ownerMemberId)
    return [...((await q.execute()) as { id: string }[]).map((r) => r.id), ...((await q2.execute()) as { key: string }[]).map((o) => `obj:${o.key}`)]
  }

  private async row(id: string): Promise<DiscRow> {
    const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('id', '=', id).executeTakeFirst()) as DiscRow | undefined
    if (!r) throw new AppError('CRMS_NO_DISCUSSION', 'Discussion {0} not found (refresh the list)', 404, [id])
    return r
  }

  private async setRow(id: string, set: Partial<DiscRow>): Promise<void> {
    await this.app.h.db.updateTable('crms_discussions').set(set).where('id', '=', id).execute()
  }

  async setSync(id: string, on: boolean, scope: Scope = null): Promise<unknown> {
    const r = await this.row(id)
    if (!this.inScope(r, scope)) throw new AppError('CRMS_NOT_YOURS', 'You can only manage the discussions of the records you own', 403)
    if (!on) {
      await this.setRow(id, { sync: 0, state: r.group_jid ? 'paused' : 'off' })
      logger.info({ mod: 'currentrms', discussion: id }, 'sync off')
      return (await this.tree()).flatMap((g) => g.discussions).find((d) => (d as { id: string }).id === id)
    }
    // fail fast when WhatsApp is not connected (new groups are created only by the main number)
    if (r.group_jid) this.activeAcc()
    else this.mainAcc().requireOpen()
    await this.setRow(id, { sync: 1, state: r.group_jid ? 'on' : 'creating', error: null })
    void this.lock(id, () => this.activate(id)).catch(async (e) => {
      const msg = e instanceof AppError ? e.message : String((e as Error)?.message ?? e)
      logger.error({ mod: 'currentrms', discussion: id, err: msg }, 'could not start the sync')
      await this.setRow(id, { state: 'error', error: msg.slice(0, 500) })
    })
    return { id, sync: true, state: r.group_jid ? 'on' : 'creating' }
  }

  /** The WhatsApp number in the chosen custom field (digits), or null. */
  private waNumber(fields?: Record<string, unknown>): string | null {
    if (!this.cfg.whatsappField || !fields) return null
    const digits = String(fields[this.cfg.whatsappField] ?? '').replace(/\D+/g, '')
    return digits.length >= 7 ? digits : null
  }

  /** Participants of a discussion with their WhatsApp number (custom field on the member). */
  private async participants(discussionId: string): Promise<Participant[]> {
    const d = await this.api<{ discussion: { participants?: { member_id: number; member?: { name?: string } }[] } }>('GET', `/discussions/${discussionId}`)
    const list = d.discussion.participants ?? []
    const members = await this.membersById(list.map((p) => p.member_id))
    return list.map((p) => members.get(p.member_id) ?? { memberId: p.member_id, name: p.member?.name ?? '', whatsapp: null })
  }

  /** Names and WhatsApp numbers of contacts, 100 per call. */
  private async membersById(ids: number[]): Promise<Map<number, Participant>> {
    const out = new Map<number, Participant>()
    const uniq = [...new Set(ids.map(Number).filter(Boolean))]
    for (let i = 0; i < uniq.length; i += 100) {
      const q = uniq.slice(i, i + 100).map((id) => `q[id_in][]=${id}`).join('&')
      try {
        const rows = await this.all<{ id: number; name?: string; custom_fields?: Record<string, unknown> }>(`/members?${q}`, 'members', 1)
        for (const m of rows) out.set(m.id, { memberId: m.id, name: m.name ?? '', whatsapp: this.waNumber(m.custom_fields) })
      } catch (e) {
        logger.debug({ mod: 'currentrms', err: String(e) }, 'participants not readable')
      }
    }
    return out
  }

  private async comments(discussionId: string): Promise<RawComment[]> {
    const list = await this.all<RawComment>(`/discussions/${discussionId}/comments`, 'comments')
    return list.sort((a, b) => a.id - b.id)
  }

  private groupSubject(r: DiscRow, inCommunity: boolean): string {
    const subject = (r.subject || '').trim() || `#${r.id}`
    if (inCommunity) return clip(subject, 100)
    const t = TYPES[r.object_type]
    const obj = (r.object_name || `#${r.object_id}`).trim()
    return clip(`${t?.short ? t.short + ' ' : ''}${obj} · ${subject}`, 100)
  }

  private paceGroups(): Promise<void> {
    const turn = this.groupGate.then(async () => {
      const wait = this.lastGroupAt + GROUP_GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastGroupAt = Date.now()
    })
    this.groupGate = turn.catch(() => undefined)
    return turn
  }

  /** Sealed: only admins add people or change the group, new members need approval. */
  private async sealGroup(sock: ReturnType<WaAccount['requireOpen']>, group: string, description: string): Promise<void> {
    await sock.groupUpdateDescription(group, description).catch(() => undefined)
    await sock.groupMemberAddMode(group, 'admin_add').catch(() => undefined)
    await sock.groupJoinApprovalMode(group, 'on').catch(() => undefined)
    await sock.groupSettingUpdate(group, 'locked').catch(() => undefined)
  }

  private async activate(id: string): Promise<void> {
    const r = await this.row(id)
    if (!r.sync) return
    const acc = r.group_jid ? this.activeAcc() : this.mainAcc()
    const sock = acc.requireOpen()
    const me = userOf(acc.row.me_jid ?? '')
    const parts = await this.participants(id)
    await this.setRow(id, { participants: JSON.stringify(parts) })
    const jids = [...new Set(parts.filter((p) => p.whatsapp && p.whatsapp !== me).map((p) => toJid(p.whatsapp!)))]
    let group = r.group_jid
    if (!group) {
      await this.paceGroups()
      const description = `${r.object_name ?? r.object_type} — ${this.webUrl(r.object_type, r.object_id)}\nCurrent RMS ⇄ WhatsApp (WhatsOps)`
      let meta: { id: string } | null
      if (this.cfg.mode === 'community') {
        const community = await this.communityFor(r.object_type, r.object_id, r.object_name)
        meta = await sock.communityCreateGroup(this.groupSubject(r, true), [], community)
      } else {
        meta = await sock.groupCreate(this.groupSubject(r, false), [])
      }
      if (!meta?.id) throw new AppError('CRMS_GROUP', 'WhatsApp did not create the group', 502)
      group = meta.id
      await this.setRow(id, { group_jid: group, ...(r.auto_at ? { auto_at: now() } : {}) })
      await this.sealGroup(sock, group, description)
      logger.info({ mod: 'currentrms', discussion: id, mode: this.cfg.mode }, `WhatsApp group created for discussion ${id}`)
    }
    // participants (people who can't be added get the invite link privately)
    if (jids.length) {
      const res = await sock.groupParticipantsUpdate(group, jids, 'add').catch(() => [] as { status: string; jid?: string }[])
      const refused = res.filter((x) => x.status === '403' || x.status === '408').map((x) => x.jid).filter(Boolean) as string[]
      await this.sendInvites(acc, group, r.subject || r.object_name || '', refused)
    }
    // the record's owner and the backup number become admins
    await this.ensureAdminsNow(id).catch((e) => logger.warn({ mod: 'currentrms', discussion: id, err: String((e as Error)?.message ?? e) }, 'group admins not set'))
    // the whole discussion so far, grouped by day, in few messages — only when messages are mirrored
    if (r.synced_comment_id == null && !this.msgOn(r.object_type)) await this.setRow(id, { synced_comment_id: r.last_comment_id ?? 0 })
    else if (r.synced_comment_id == null) {
      const list = await this.comments(id)
      if (list.length) {
        for (const chunk of this.historyChunks(list, r)) {
          const waId = await this.sendToGroup(acc, group, chunk.text)
          await this.mapRows(id, chunk.ids, waId, 'c2w')
        }
        await this.setRow(id, { synced_comment_id: list[list.length - 1].id })
      } else await this.setRow(id, { synced_comment_id: 0 })
    }
    await this.setRow(id, { state: 'on', error: null })
    this.lastPoll = 0
  }

  /** The record's Community (created once, by the main number). */
  private communityFor(type: string, id: string, objName: string | null): Promise<string> {
    const k = objKey(type, id)
    return this.lock(`community:${k}`, async () => {
      const have = await this.obj(k)
      if (have?.community_jid) return have.community_jid
      const sock = this.mainAcc().requireOpen()
      await this.paceGroups()
      const name = clip(`${TYPES[type]?.short ? TYPES[type].short + ' ' : ''}${objName || '#' + id}`, 100)
      const meta = await sock.communityCreate(name, `${this.webUrl(type, id)}\nCurrent RMS ⇄ WhatsApp (WhatsOps)`)
      if (!meta?.id) throw new AppError('CRMS_GROUP', 'WhatsApp did not create the community', 502)
      await sock.communityJoinApprovalMode(meta.id, 'on').catch(() => undefined)
      await sock.communityMemberAddMode(meta.id, 'admin_add').catch(() => undefined)
      await this.upsertObj(k, { community_jid: meta.id, ...(have ? {} : { name: objName, object_type: levelKey(type), object_id: id }) })
      logger.info({ mod: 'currentrms', object: k }, 'WhatsApp community created')
      return meta.id
    })
  }

  private async communityJidOf(type: string, id: string): Promise<string | null> {
    return (await this.obj(objKey(type, id)))?.community_jid ?? null
  }

  /** Invite link, privately, to people WhatsApp did not let us add (their privacy settings). */
  private async sendInvites(acc: WaAccount, group: string, title: string, jids: string[]): Promise<void> {
    if (!jids.length || !this.cfg.inviteFallback) return
    const code = await acc.requireOpen().groupInviteCode(group).catch(() => null)
    if (!code) return
    for (const j of jids) await acc.sendRaw(j, { text: `${title.trim()}\nhttps://chat.whatsapp.com/${code}` }).catch(() => undefined)
  }

  // ------------------------------------------------------------------ records (level 1) and new discussions (level 2)
  private async obj(key: string): Promise<ObjRow | undefined> {
    return (await this.app.h.db.selectFrom('crms_objects').selectAll().where('key', '=', key).executeTakeFirst()) as ObjRow | undefined
  }

  private async upsertObj(key: string, set: Partial<ObjRow>): Promise<void> {
    if (await this.obj(key)) await this.app.h.db.updateTable('crms_objects').set(set).where('key', '=', key).execute()
    else await this.app.h.db.insertInto('crms_objects').values({ key, created_at: now(), ...set }).execute()
  }

  private recInfo(type: string, o: Record<string, unknown>): RecInfo {
    const t = TYPES[type]
    const parts = (Array.isArray(o.participants) ? o.participants : []) as { member_id?: number }[]
    return {
      type: levelKey(type),
      id: String(o.id),
      name: String(o[t?.name ?? 'name'] ?? o.name ?? o.subject ?? `#${o.id}`),
      owner: o.owned_by != null && o.owned_by !== '' ? String(o.owned_by) : null,
      createdAt: Date.parse(String(o.created_at ?? '')) || 0,
      memberIds: parts.map((p) => Number(p.member_id)).filter(Boolean),
      membership: typeof o.membership_type === 'string' ? o.membership_type : undefined,
    }
  }

  private async readObject(type: string, id: string): Promise<RecInfo> {
    const t = TYPES[type]
    if (!t) throw new AppError('CRMS_TYPE', 'Unknown record type {0}', 400, [type])
    const j = await this.api<Record<string, unknown>>('GET', `/${t.coll}/${encodeURIComponent(id)}`)
    const o = (j[t.one] ?? Object.values(j).find((v) => v && typeof v === 'object' && !Array.isArray(v))) as Record<string, unknown> | undefined
    if (!o) throw new AppError('CRMS_NO_RECORD', 'Record {0} {1} not found', 404, [type, id])
    return this.recInfo(type, o)
  }

  /** Create the WhatsApp group of a record by hand (or stop managing it: the group stays on WhatsApp). */
  async setObjectGroup(typeIn: string, id: string, on: boolean, scope: Scope = null): Promise<unknown> {
    const t = levelKey(typeIn)
    if (!TYPES[t]) throw new AppError('CRMS_TYPE', 'Unknown record type {0}', 400, [typeIn])
    const key = objKey(t, id)
    const have = await this.obj(key)
    if (!on) {
      if (have && !this.inScope(have, scope)) throw new AppError('CRMS_NOT_YOURS_REC', 'You can only manage the records you own', 403)
      if (have) await this.upsertObj(key, { sync: 0, state: have.group_jid ? 'paused' : 'off' })
      logger.info({ mod: 'currentrms', object: key }, 'record group off')
      return { type: t, id, group: false, state: have?.group_jid ? 'paused' : 'off' }
    }
    const info = await this.readObject(t, id)
    if (!this.inScope({ owner_member_id: info.owner }, scope)) throw new AppError('CRMS_NOT_YOURS_REC', 'You can only manage the records you own', 403)
    // fail fast when WhatsApp is not connected (new groups are created only by the main number)
    if (have?.group_jid) this.activeAcc()
    else this.mainAcc().requireOpen()
    const state = have?.group_jid ? 'on' : 'creating'
    await this.upsertObj(key, { object_type: t, object_id: id, name: info.name, owner_member_id: info.owner, participants: JSON.stringify(info.memberIds.map((m) => ({ memberId: m, name: '', whatsapp: null }))), rms_created_at: info.createdAt || null, sync: 1, state, error: null })
    void this.lock(`obj:${key}`, () => this.activateObj(key)).catch(async (e) => {
      logger.error({ mod: 'currentrms', object: key, err: errText(e) }, 'record group not created')
      await this.upsertObj(key, { state: 'error', error: errText(e) })
    })
    return { type: t, id, group: true, state }
  }

  private async activateObj(key: string): Promise<void> {
    const o = await this.obj(key)
    if (!o?.sync || !o.object_type || !o.object_id) return
    const acc = o.group_jid ? this.activeAcc() : this.mainAcc()
    const sock = acc.requireOpen()
    const me = userOf(acc.row.me_jid ?? '')
    const ids = (JSON.parse(o.participants || '[]') as Participant[]).map((p) => p.memberId)
    const members = await this.membersById(ids)
    const parts = ids.map((m) => members.get(m) ?? { memberId: m, name: '', whatsapp: null })
    if (parts.length) await this.upsertObj(key, { participants: JSON.stringify(parts) })
    const jids = [...new Set(parts.filter((p) => p.whatsapp && p.whatsapp !== me).map((p) => toJid(p.whatsapp!)))]
    const name = (o.name || `#${o.object_id}`).trim()
    let group = o.group_jid
    if (!group) {
      await this.paceGroups()
      let meta: { id: string } | null
      if (this.cfg.mode === 'community') {
        const community = await this.communityFor(o.object_type, o.object_id, o.name)
        meta = await sock.communityCreateGroup(clip(name, 100), [], community)
      } else {
        const short = TYPES[o.object_type]?.short
        meta = await sock.groupCreate(clip(`${short ? short + ' ' : ''}${name}`, 100), [])
      }
      if (!meta?.id) throw new AppError('CRMS_GROUP', 'WhatsApp did not create the group', 502)
      group = meta.id
      await this.upsertObj(key, { group_jid: group, ...(o.auto_at ? { auto_at: now() } : {}) })
      await this.sealGroup(sock, group, `${name} — ${this.webUrl(o.object_type, o.object_id)}\nCurrent RMS · WhatsOps`)
      logger.info({ mod: 'currentrms', object: key, mode: this.cfg.mode }, `WhatsApp group created for ${key}`)
    }
    if (jids.length) {
      const res = await sock.groupParticipantsUpdate(group, jids, 'add').catch(() => [] as { status: string; jid?: string }[])
      await this.sendInvites(acc, group, name, res.filter((x) => x.status === '403' || x.status === '408').map((x) => x.jid).filter(Boolean) as string[])
    }
    await this.ensureAdminsNow(`obj:${key}`).catch((e) => logger.warn({ mod: 'currentrms', object: key, err: errText(e) }, 'group admins not set'))
    await this.upsertObj(key, { state: 'on', error: null })
  }

  /** Records of this type created after their level was turned on: queued for a group. */
  private async queueObjects(t: string, infos: RecInfo[], since: number): Promise<number> {
    const rows = (await this.app.h.db.selectFrom('crms_objects').selectAll().where('object_type', '=', t).execute()) as ObjRow[]
    const seen = new Set(rows.filter((r) => r.auto_at || r.sync || r.group_jid).map((r) => String(r.object_id)))
    const fresh = pickNew(infos.filter((i) => !(t === 'Member' && i.membership === 'User')), since - SLACK_MS, seen, AUTO_PER_CHECK)
    for (const i of fresh) {
      await this.upsertObj(objKey(t, i.id), {
        object_type: t,
        object_id: i.id,
        name: i.name,
        owner_member_id: i.owner,
        participants: JSON.stringify(i.memberIds.map((m) => ({ memberId: m, name: '', whatsapp: null }))),
        rms_created_at: i.createdAt || null,
        sync: 1,
        state: 'queued',
        error: null,
        auto_at: now(),
      })
    }
    if (fresh.length) {
      logger.info({ mod: 'currentrms', type: t, n: fresh.length }, `${fresh.length} new ${t} record(s): group queued`)
      this.drainQueue()
    }
    return fresh.length
  }

  /** Level 1 without webhooks: one call per record type that has it on. */
  private async checkNewObjects(): Promise<void> {
    for (const t of LEVEL_TYPES) {
      const since = this.cfg.since[`obj:${t}`]
      if (!since || !this.cfg.levels[t]?.objects) continue
      const T = TYPES[t]
      const from = Math.max(since, this.cfg.cursor[`obj:${t}`] ?? 0) - SLACK_MS
      let list: Record<string, unknown>[]
      try {
        const j = await this.api<Record<string, unknown>>('GET', `/${T.coll}?q[created_at_gteq]=${encodeURIComponent(new Date(from).toISOString())}&q[s]=created_at%20desc&per_page=100`)
        list = (j[T.coll] as Record<string, unknown>[]) ?? []
      } catch (e) {
        logger.warn({ mod: 'currentrms', type: t, err: errText(e) }, 'new records not readable')
        continue
      }
      const infos = list.map((o) => this.recInfo(t, o))
      await this.queueObjects(t, infos, since)
      const newest = Math.max(0, ...infos.map((i) => i.createdAt))
      if (newest > (this.cfg.cursor[`obj:${t}`] ?? 0)) {
        this.cfg.cursor[`obj:${t}`] = newest
        await this.save()
      }
    }
  }

  /** Discussions created after their level was turned on: queued for a group. Never again after a manual off. */
  private async handleNewDiscussions(list: RawDisc[]): Promise<number> {
    let n = 0
    for (const d of list) {
      const lk = levelKey(d.discussable_type)
      const since = this.cfg.since[`disc:${lk}`]
      if (!since || !this.cfg.levels[lk]?.discussions) continue
      const created = Date.parse(d.created_at ?? '') || 0
      if (created < since - SLACK_MS) continue
      const id = String(d.id)
      const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('id', '=', id).executeTakeFirst()) as DiscRow | undefined
      if (r && (r.auto_at || r.sync || r.group_jid)) continue
      if (!r) {
        let info: RecInfo | null = null
        try {
          info = await this.readObject(d.discussable_type, String(d.discussable_id))
        } catch {
          /* the record name arrives with the next refresh */
        }
        await this.app.h.db
          .insertInto('crms_discussions')
          .values({ id, subject: d.subject ?? null, object_type: d.discussable_type, object_id: String(d.discussable_id), object_name: info?.name ?? null, participants: '[]', reply_count: d.reply_count ?? null, last_comment_id: d.last_comment_id ?? null, last_at: Date.parse(d.updated_at ?? d.created_at ?? '') || null, sync: 0, state: 'off', group_jid: null, error: null, synced_comment_id: null, created_at: now(), owner_member_id: info?.owner ?? null, rms_created_at: created || null })
          .execute()
      }
      await this.setRow(id, { sync: 1, state: 'queued', error: null, auto_at: now() })
      n++
    }
    if (n) {
      logger.info({ mod: 'currentrms', n }, `${n} new discussion(s): group queued`)
      this.drainQueue()
    }
    return n
  }

  /** Level 2 without webhooks: one call for all record types. */
  private async checkNewDiscussions(): Promise<void> {
    const on = LEVEL_TYPES.filter((t) => this.cfg.levels[t]?.discussions && this.cfg.since[`disc:${t}`])
    if (!on.length) return
    const from = Math.max(Math.min(...on.map((t) => this.cfg.since[`disc:${t}`])), this.cfg.cursor.disc ?? 0) - SLACK_MS
    const j = await this.api<{ discussions?: RawDisc[] }>('GET', `/discussions?q[created_at_gteq]=${encodeURIComponent(new Date(from).toISOString())}&q[s]=created_at%20desc&per_page=100`)
    const list = j.discussions ?? []
    await this.handleNewDiscussions(list)
    const newest = Math.max(0, ...list.map((d) => Date.parse(d.created_at ?? '') || 0))
    if (newest > (this.cfg.cursor.disc ?? 0)) {
      this.cfg.cursor.disc = newest
      await this.save()
    }
  }

  private async onNewObject(subjectType: string, id: string): Promise<void> {
    const types = (subjectType === 'Item' ? ['Product', 'Service'] : [levelKey(subjectType)]).filter((t) => this.cfg.levels[t]?.objects && this.cfg.since[`obj:${t}`])
    for (const t of types) {
      let info: RecInfo
      try {
        info = await this.readObject(t, id)
      } catch {
        continue // e.g. an Item that is a service, not a product
      }
      if (await this.queueObjects(t, [info], this.cfg.since[`obj:${t}`])) return
    }
  }

  private async onNewDiscussion(id: string): Promise<void> {
    const j = await this.api<{ discussion?: RawDisc }>('GET', `/discussions/${encodeURIComponent(id)}`)
    const d = j.discussion
    if (!d) return
    await this.handleNewDiscussions([d])
    // not to be synced by itself: still listed
    const have = await this.app.h.db.selectFrom('crms_discussions').select('id').where('id', '=', String(d.id)).executeTakeFirst()
    if (!have)
      await this.app.h.db
        .insertInto('crms_discussions')
        .values({ id: String(d.id), subject: d.subject ?? null, object_type: d.discussable_type, object_id: String(d.discussable_id), object_name: null, participants: '[]', reply_count: d.reply_count ?? null, last_comment_id: d.last_comment_id ?? null, last_at: Date.parse(d.updated_at ?? d.created_at ?? '') || null, sync: 0, state: 'off', group_jid: null, error: null, synced_comment_id: null, created_at: now(), rms_created_at: Date.parse(d.created_at ?? '') || null })
        .execute()
  }

  /** Automatic groups created in the last 24 hours. */
  private async autoToday(): Promise<number> {
    const t = now() - 86400_000
    const a = await this.app.h.db.selectFrom('crms_objects').select('key').where('auto_at', '>', t).where('group_jid', 'is not', null).execute()
    const b = await this.app.h.db.selectFrom('crms_discussions').select('id').where('auto_at', '>', t).where('group_jid', 'is not', null).execute()
    return a.length + b.length
  }

  /** Create the queued groups one at a time (records first, then discussions), 45 s apart, at most 50 a day. */
  private drainQueue(): void {
    if (this.draining) return
    this.draining = true
    void (async () => {
      try {
        for (;;) {
          try {
            if (this.mainAcc().state !== 'open') break
          } catch {
            break
          }
          if ((await this.autoToday()) >= AUTO_DAY_MAX) {
            if (Date.now() - this.capLogged > 3600_000) logger.warn({ mod: 'currentrms', max: AUTO_DAY_MAX }, 'daily limit of automatic WhatsApp groups reached: the rest waits')
            this.capLogged = Date.now()
            break
          }
          const o = (await this.app.h.db.selectFrom('crms_objects').selectAll().where('state', '=', 'queued').where('sync', '=', 1).orderBy('auto_at').limit(1).executeTakeFirst()) as ObjRow | undefined
          if (o) {
            await this.upsertObj(o.key, { state: 'creating' })
            await this.lock(`obj:${o.key}`, () => this.activateObj(o.key)).catch(async (e) => {
              logger.error({ mod: 'currentrms', object: o.key, err: errText(e) }, 'record group not created')
              await this.upsertObj(o.key, { state: 'error', error: errText(e) })
            })
            continue
          }
          const d = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('state', '=', 'queued').where('sync', '=', 1).orderBy('auto_at').limit(1).executeTakeFirst()) as DiscRow | undefined
          if (!d) break
          await this.setRow(d.id, { state: 'creating' })
          await this.lock(d.id, () => this.activate(d.id)).catch(async (e) => {
            logger.error({ mod: 'currentrms', discussion: d.id, err: errText(e) }, 'could not start the sync')
            await this.setRow(d.id, { state: 'error', error: errText(e) })
          })
        }
      } finally {
        this.draining = false
      }
    })()
  }

  /** Last comment id of each discussion: 100 discussions per call (single reads for what the list misses, a few per check). */
  private async lastComments(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const want = new Set(ids)
    for (let i = 0; i < ids.length; i += 100) {
      const q = ids.slice(i, i + 100).map((id) => `q[id_in][]=${encodeURIComponent(id)}`).join('&')
      try {
        const j = await this.api<{ discussions?: { id: number; last_comment_id?: number }[] }>('GET', `/discussions?${q}&per_page=100`)
        for (const d of j.discussions ?? []) if (want.has(String(d.id))) out.set(String(d.id), d.last_comment_id ?? 0)
      } catch (e) {
        logger.debug({ mod: 'currentrms', err: errText(e) }, 'discussions not readable in bulk')
      }
    }
    const missing = ids.filter((id) => !out.has(id))
    const start = missing.length ? Math.floor(Math.random() * missing.length) : 0
    for (let k = 0; k < Math.min(25, missing.length); k++) {
      const id = missing[(start + k) % missing.length]
      try {
        const d = await this.api<{ discussion: { last_comment_id?: number } }>('GET', `/discussions/${encodeURIComponent(id)}`)
        out.set(id, d.discussion.last_comment_id ?? 0)
      } catch {
        /* next check */
      }
    }
    return out
  }

  /** Messages switched on for these record types: the existing groups start from the current comments. */
  private async rebaseline(types: string[]): Promise<void> {
    const rows = ((await this.app.h.db.selectFrom('crms_discussions').selectAll().where('sync', '=', 1).where('group_jid', 'is not', null).execute()) as DiscRow[]).filter((r) => types.includes(levelKey(r.object_type)))
    if (!rows.length) return
    const last = await this.lastComments(rows.map((r) => r.id))
    for (const r of rows) {
      const l = last.get(r.id)
      if (l != null && l > (r.synced_comment_id ?? 0)) await this.setRow(r.id, { synced_comment_id: l, last_comment_id: l })
    }
  }

  /**
   * Admins of a synced group (and of its Community): the owner of the record in Current RMS, when
   * they have a registered number, and the backup number. The main number created the group and
   * stays its creator. Missing people are added first; nobody is ever demoted.
   */
  private async ensureAdminsNow(id: string): Promise<void> {
    let r: { group_jid: string; owner_member_id: string | null; object_type: string; object_id: string; title: string; save: (admins: string) => Promise<void> }
    if (id.startsWith('obj:')) {
      const o = await this.obj(id.slice(4))
      if (!o?.sync || !o.group_jid || !o.object_type || !o.object_id) return
      r = { group_jid: o.group_jid, owner_member_id: o.owner_member_id, object_type: o.object_type, object_id: o.object_id, title: o.name || '', save: (a) => this.upsertObj(id.slice(4), { admins: a }) }
    } else {
      const d = await this.row(id)
      if (!d.sync || !d.group_jid) return
      r = { group_jid: d.group_jid, owner_member_id: d.owner_member_id, object_type: d.object_type, object_id: d.object_id, title: d.subject || d.object_name || '', save: (a) => this.setRow(id, { admins: a }) }
    }
    const acc = this.activeAcc()
    const sock = acc.requireOpen()
    const me = CurrentRmsPlugin.phoneOf(acc)
    const want = new Map<string, 'main' | 'backup' | 'owner'>()
    const main = this.mainAcc()
    if (acc !== main && CurrentRmsPlugin.phoneOf(main)) want.set(CurrentRmsPlugin.phoneOf(main), 'main')
    const backup = CurrentRmsPlugin.phoneOf(this.backupAcc())
    if (backup) want.set(backup, 'backup')
    const owner = this.cfg.ownerAdmin && r.owner_member_id ? await this.userPhone(r.owner_member_id) : null
    if (owner) want.set(owner, 'owner')
    want.delete(me)
    if (want.size) {
      const phones = [...want.keys()]
      // the group first (adding someone to a Community group also makes them a Community member)
      const g = await sock.groupMetadata(r.group_jid)
      const plan = planAdmins(g.participants, phones)
      const promote = [...plan.promote]
      if (plan.add.length) {
        const res = await sock.groupParticipantsUpdate(r.group_jid, plan.add.map((p) => toJid(p)), 'add').catch(() => [] as { status: string; jid?: string }[])
        for (const x of res) if ((x.status === '200' || x.status === '409') && x.jid) promote.push(x.jid)
        await this.sendInvites(acc, r.group_jid, r.title, res.filter((x) => x.status === '403' || x.status === '408').map((x) => x.jid).filter(Boolean) as string[])
      }
      if (promote.length) await sock.groupParticipantsUpdate(r.group_jid, promote, 'promote')
      const community = this.cfg.mode === 'community' ? await this.communityJidOf(r.object_type, r.object_id) : null
      if (community) {
        const c = await sock.groupMetadata(community)
        const cp = planAdmins(c.participants, phones)
        const cpromote = [...cp.promote, ...cp.add.map((p) => toJid(p))]
        if (cpromote.length) await sock.communityParticipantsUpdate(community, cpromote, 'promote').catch((e) => logger.debug({ mod: 'currentrms', err: String(e) }, 'community admins not set yet'))
      }
    }
    await r.save(JSON.stringify([...want].map(([phone, role]) => ({ phone, role }))))
  }

  /** Bring groups in line in the background, one at a time, with a pause between them. */
  private queueAdmins(ids: string[]): void {
    for (const id of ids) this.adminQueue.add(id)
    if (this.adminRunning || !this.adminQueue.size) return
    this.adminRunning = true
    void (async () => {
      try {
        while (this.adminQueue.size) {
          const id = this.adminQueue.values().next().value as string
          this.adminQueue.delete(id)
          await this.lock(id, () => this.ensureAdminsNow(id)).catch((e) => logger.warn({ mod: 'currentrms', discussion: id, err: String((e as Error)?.message ?? e) }, 'group admins not updated'))
          await sleep(3000)
        }
      } finally {
        this.adminRunning = false
      }
    })()
  }

  // ------------------------------------------------------------------ Current RMS users
  /** Users of Current RMS (membership type User) with the WhatsApp number of the custom field. */
  private async loadUsers(force = false): Promise<void> {
    if (!force && this.rmsUsers.size && Date.now() - this.usersAt < 10 * 60_000) return
    type M = { id: number; name?: string; membership_type?: string; active?: boolean; email?: string; primary_email?: string | null; emails?: { address?: string }[]; custom_fields?: Record<string, unknown> }
    const list = await this.all<M>('/members?q[membership_type_eq]=User', 'members', 5)
    const map = new Map<string, RmsUser>()
    for (const m of list) {
      if ((m.membership_type && m.membership_type !== 'User') || m.active === false) continue
      map.set(String(m.id), { name: m.name ?? '', email: m.email ?? m.primary_email ?? m.emails?.[0]?.address ?? null, whatsapp: this.waNumber(m.custom_fields) })
    }
    this.rmsUsers = map
    this.usersAt = Date.now()
  }

  /** A user's WhatsApp number: the one they confirmed with their invite link, else the custom field. */
  private async userPhone(memberId: string): Promise<string | null> {
    const u = (await this.app.h.db.selectFrom('crms_users').select(['phone', 'verified_at']).where('member_id', '=', memberId).executeTakeFirst()) as CrmsUserRow | undefined
    if (u?.phone && u.verified_at) return u.phone
    await this.loadUsers().catch(() => undefined)
    return this.rmsUsers.get(memberId)?.whatsapp ?? null
  }

  async users() {
    await this.loadUsers(true)
    const local = new Map(((await this.app.h.db.selectFrom('crms_users').selectAll().execute()) as CrmsUserRow[]).map((u) => [u.member_id, u]))
    const rows = (await this.app.h.db.selectFrom('crms_discussions').select(['object_type', 'object_id', 'owner_member_id', 'sync']).execute()) as DiscRow[]
    const wo = new Map((await this.app.users.list()).filter((u) => u.source?.startsWith(`${PLUGIN_ID}:`)).map((u) => [u.source!.slice(PLUGIN_ID.length + 1), u]))
    const out = []
    for (const [id, u] of this.rmsUsers) {
      const l = local.get(id)
      const mine = rows.filter((r) => r.owner_member_id === id)
      const w = wo.get(id)
      const verified = !!(l?.phone && l.verified_at)
      out.push({
        id,
        name: u.name,
        email: u.email,
        phone: verified ? l!.phone : u.whatsapp,
        phoneSource: verified ? 'confirmed' : u.whatsapp ? 'currentrms' : null,
        confirmedAt: verified ? new Date(l!.verified_at!).toISOString() : null,
        records: new Set(mine.map((r) => `${r.object_type}:${r.object_id}`)).size,
        synced: mine.filter((r) => r.sync).length,
        invite: l?.invite_expires && l.invite_expires > now() ? { expiresAt: new Date(l.invite_expires).toISOString() } : null,
        access: w ? { userId: w.id, active: w.active, ...(w.perms.plugins[PLUGIN_ID] ?? { access: false, scope: 'owned', manage: false }), lastLogin: w.lastLogin ? new Date(w.lastLogin).toISOString() : null } : null,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Personal link (14 days) where a Current RMS user registers their WhatsApp number. A new link cancels the old one. */
  async invite(memberId: string, origin: string) {
    await this.loadUsers()
    const u = this.rmsUsers.get(memberId)
    if (!u) throw new AppError('CRMS_NO_USER', 'Current RMS user {0} not found', 404, [memberId])
    const token = crypto.randomBytes(24).toString('base64url')
    const expires = now() + INVITE_DAYS * 86400_000
    const have = await this.app.h.db.selectFrom('crms_users').select('member_id').where('member_id', '=', memberId).executeTakeFirst()
    if (have) await this.app.h.db.updateTable('crms_users').set({ name: u.name, email: u.email, invite_hash: sha256(token), invite_expires: expires }).where('member_id', '=', memberId).execute()
    else await this.app.h.db.insertInto('crms_users').values({ member_id: memberId, name: u.name, email: u.email, phone: null, verified_at: null, invite_hash: sha256(token), invite_expires: expires, code_hash: null, code_phone: null, code_expires: null, code_tries: 0, sends: '[]', created_at: now() }).execute()
    logger.info({ mod: 'currentrms', user: memberId }, `invite link created for ${u.name}`)
    return { user: memberId, name: u.name, url: `${origin}/join/${PLUGIN_ID}/${token}`, expiresAt: new Date(expires).toISOString() }
  }

  async removePhone(memberId: string): Promise<void> {
    await this.app.h.db.updateTable('crms_users').set({ phone: null, verified_at: null }).where('member_id', '=', memberId).execute()
    const w = await this.app.users.bySource(`${PLUGIN_ID}:${memberId}`)
    if (w) await this.app.users.update(w.id, { phone: this.rmsUsers.get(memberId)?.whatsapp ?? null }).catch(() => undefined)
  }

  /**
   * Access of a Current RMS user to WhatsOps (owner only): on/off, which records (only theirs or all),
   * and whether they manage the plugin. Creates the WhatsOps user the first time.
   */
  async setAccess(memberId: string, p: { access?: boolean; scope?: 'owned' | 'all'; manage?: boolean }): Promise<User | null> {
    await this.loadUsers()
    const ru = this.rmsUsers.get(memberId)
    if (!ru) throw new AppError('CRMS_NO_USER', 'Current RMS user {0} not found', 404, [memberId])
    const src = `${PLUGIN_ID}:${memberId}`
    const phone = await this.userPhone(memberId)
    let u = await this.app.users.bySource(src)
    if (!u) {
      if (!p.access) return null
      u = await this.app.users.create({ name: ru.name || `#${memberId}`, phone, source: src, perms: { plugins: { [PLUGIN_ID]: { access: true, scope: p.scope ?? 'owned', manage: !!p.manage } } } })
    } else {
      if (phone && u.phone !== phone) u = await this.app.users.update(u.id, { phone })
      if (p.access && !u.active) u = await this.app.users.update(u.id, { active: true })
      u = await this.app.users.setPluginPerms(u.id, PLUGIN_ID, { ...(p.access !== undefined ? { access: p.access } : {}), ...(p.scope ? { scope: p.scope } : {}), ...(p.manage !== undefined ? { manage: p.manage } : {}) })
    }
    logger.info({ mod: 'currentrms', user: memberId, access: u.perms.plugins[PLUGIN_ID] }, `access of ${u.name} changed`)
    return u
  }

  // ---- the invite page
  private async byToken(token: string): Promise<CrmsUserRow | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
    const u = (await this.app.h.db.selectFrom('crms_users').selectAll().where('invite_hash', '=', sha256(token)).executeTakeFirst()) as CrmsUserRow | undefined
    return u && u.invite_expires && u.invite_expires > now() ? u : null
  }

  async joinInfo(token: string) {
    const u = await this.byToken(token)
    return u ? { name: u.name || '', company: this.cfg.subdomain, phone: u.verified_at ? mask(u.phone) : null } : null
  }

  async joinSendCode(token: string, phoneIn: string, lang: Lang) {
    const u = await this.byToken(token)
    if (!u) throw new AppError('CRMS_JOIN_INVALID', 'This link is not valid or has expired. Ask for a new one.', 404)
    const d = phoneDigits(phoneIn)
    if (d.length < 8 || d.length > 15) throw new AppError('INVALID_PHONE', 'Write the full number with the country code, e.g. +39 333 123 4567', 400)
    const sends = (JSON.parse(u.sends || '[]') as number[]).filter((t) => now() - t < 3600_000)
    if (sends.length >= 5) throw new AppError('TOO_MANY_REQUESTS', 'Too many codes requested, wait a few minutes', 429)
    const acc = this.activeAcc()
    const chk = await acc.checkNumber(d)
    if (!chk.exists || !chk.jid) throw new AppError('CRMS_JOIN_NOWA', '{0} is not on WhatsApp', 400, ['+' + d])
    const phone = phoneDigits(chk.phone) || d
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    await acc.sendRaw(chk.jid, { text: tr(lang, '@crms_code', [code, `${this.cfg.subdomain}.current-rms.com`]) })
    await this.app.h.db
      .updateTable('crms_users')
      .set({ code_hash: sha256(`${u.member_id}:${code}`), code_phone: phone, code_expires: now() + 10 * 60_000, code_tries: 0, sends: JSON.stringify([...sends, now()]) })
      .where('member_id', '=', u.member_id)
      .execute()
    return { sentTo: mask(phone) }
  }

  async joinVerify(token: string, codeIn: string): Promise<{ phone: string | null; memberId: string }> {
    const u = await this.byToken(token)
    if (!u) throw new AppError('CRMS_JOIN_INVALID', 'This link is not valid or has expired. Ask for a new one.', 404)
    if (!u.code_hash || !u.code_expires || u.code_expires < now()) throw new AppError('INVALID_CODE', 'Wrong or expired code', 400)
    if ((u.code_tries ?? 0) >= 5) throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed attempts, try again in a few minutes', 429)
    if (sha256(`${u.member_id}:${codeIn.replace(/\D+/g, '')}`) !== u.code_hash) {
      await this.app.h.db.updateTable('crms_users').set({ code_tries: (u.code_tries ?? 0) + 1 }).where('member_id', '=', u.member_id).execute()
      throw new AppError('INVALID_CODE', 'Wrong or expired code', 400)
    }
    await this.app.h.db.updateTable('crms_users').set({ phone: u.code_phone, verified_at: now(), code_hash: null, code_phone: null, code_expires: null, code_tries: 0 }).where('member_id', '=', u.member_id).execute()
    const w = await this.app.users.bySource(`${PLUGIN_ID}:${u.member_id}`)
    if (w && w.phone !== u.code_phone) await this.app.users.update(w.id, { phone: u.code_phone }).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'user number not updated'))
    logger.info({ mod: 'currentrms', user: u.member_id }, `${u.name ?? u.member_id} registered a WhatsApp number`)
    if (this.cfg.ownerAdmin) this.queueAdmins(await this.syncedIds(u.member_id))
    return { phone: mask(u.code_phone), memberId: u.member_id }
  }

  private historyChunks(list: RawComment[], r: DiscRow): { text: string; ids: number[] }[] {
    const day = (c: RawComment) => new Date(c.created_at ?? Date.now()).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })
    const time = (c: RawComment) => new Date(c.created_at ?? Date.now()).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    const chunks: { text: string; ids: number[] }[] = []
    let cur = { text: `🗂 *${clip((r.subject || '').trim() || '#' + r.id, 90)}* — ${list.length}\n`, ids: [] as number[] }
    let lastDay = ''
    for (const c of list) {
      const d = day(c)
      const block = `${d !== lastDay ? `\n📅 *${d}*\n` : ''}\n*${commentAuthor(c)}* · ${time(c)}\n${commentText(c)}\n`
      if (cur.text.length + block.length > MAX_CHUNK && cur.ids.length) {
        chunks.push(cur)
        cur = { text: `📅 *${d}*\n`, ids: [] }
        lastDay = d
        cur.text += `\n*${commentAuthor(c)}* · ${time(c)}\n${commentText(c)}\n`
      } else {
        cur.text += block
        lastDay = d
      }
      cur.ids.push(c.id)
    }
    if (cur.ids.length) chunks.push(cur)
    return chunks
  }

  private async sendToGroup(acc: WaAccount, group: string, text: string): Promise<string> {
    const messageId = generateMessageIDV2(acc.row.me_jid ?? undefined)
    this.ownSent.add(messageId)
    setTimeout(() => this.ownSent.delete(messageId), 10 * 60_000).unref()
    const m = await acc.sendRaw(group, { text }, { messageId } as never)
    return m.key.id ?? messageId
  }

  private async mapRows(discussionId: string, commentIds: number[], waId: string, dir: 'c2w' | 'w2c'): Promise<void> {
    for (const cid of commentIds) {
      await this.app.h.db
        .insertInto('crms_map')
        .values({ discussion_id: discussionId, comment_id: String(cid), wa_id: waId, dir, at: now() })
        .execute()
        .catch(() => undefined)
    }
  }

  private async mapped(by: 'comment_id' | 'wa_id', v: string): Promise<boolean> {
    return !!(await this.app.h.db.selectFrom('crms_map').select('wa_id').where(by, '=', v).executeTakeFirst())
  }

  // ------------------------------------------------------------------ Current → WhatsApp
  /** Post new comments of a synced discussion into its group. */
  async pull(id: string): Promise<number> {
    return this.lock(id, async () => {
      const r = await this.row(id)
      if (!r.sync || !r.group_jid || r.synced_comment_id == null || !this.msgOn(r.object_type)) return 0
      const acc = this.activeAcc()
      const list = (await this.comments(id)).filter((c) => c.id > (r.synced_comment_id ?? 0))
      let n = 0
      for (const c of list) {
        if (!(await this.mapped('comment_id', String(c.id)))) {
          const waId = await this.sendToGroup(acc, r.group_jid, `*${commentAuthor(c)}*\n${commentText(c)}`)
          await this.mapRows(id, [c.id], waId, 'c2w')
          n++
        }
        await this.setRow(id, { synced_comment_id: c.id, last_comment_id: c.id, last_at: Date.parse(c.created_at ?? '') || now() })
      }
      return n
    })
  }

  /**
   * Every N minutes (the webhooks bring the same at once): new records and new discussions of the
   * types that want a group (one call per type, one for the discussions), then new comments of the
   * discussion groups that mirror messages (one call per 100 groups).
   */
  async poll(): Promise<void> {
    if (!this.configured()) return
    await this.checkNewObjects().catch((e) => logger.warn({ mod: 'currentrms', err: errText(e) }, 'new records not checked'))
    await this.checkNewDiscussions().catch((e) => logger.warn({ mod: 'currentrms', err: errText(e) }, 'new discussions not checked'))
    this.drainQueue()
    // groups that failed before they existed (e.g. WhatsApp was offline): a few per check
    const failed = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('sync', '=', 1).where('state', '=', 'error').where('group_jid', 'is', null).limit(5).execute()) as DiscRow[]
    for (const r of failed) void this.lock(r.id, () => this.activate(r.id)).catch(() => undefined)
    const failedObj = (await this.app.h.db.selectFrom('crms_objects').selectAll().where('sync', '=', 1).where('state', '=', 'error').where('group_jid', 'is', null).limit(5).execute()) as ObjRow[]
    for (const o of failedObj) void this.lock(`obj:${o.key}`, () => this.activateObj(o.key)).catch(() => undefined)
    // new comments: only the discussion groups whose record type mirrors messages
    const rows = ((await this.app.h.db.selectFrom('crms_discussions').selectAll().where('sync', '=', 1).where('state', '=', 'on').where('group_jid', 'is not', null).execute()) as DiscRow[]).filter((r) => this.msgOn(r.object_type))
    if (rows.length) {
      const last = await this.lastComments(rows.map((r) => r.id))
      for (const r of rows) {
        if ((last.get(r.id) ?? 0) <= (r.synced_comment_id ?? 0)) continue
        await this.pull(r.id).catch((e) => logger.debug({ mod: 'currentrms', discussion: r.id, err: errText(e) }, 'poll failed'))
      }
    }
    this.lastPoll = Date.now()
  }

  /** Webhook from Current RMS (target URL carries the secret). */
  async onHook(body: unknown): Promise<void> {
    const a = (body as { action?: Record<string, unknown> })?.action
    if (!a) return
    const subjectType = String(a.subject_type ?? '')
    const sourceType = String(a.source_type ?? '')
    const actionType = String(a.action_type ?? '')
    if (subjectType === 'Discussion') {
      const id = String(a.subject_id)
      const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('id', '=', id).executeTakeFirst()) as DiscRow | undefined
      if (r?.sync && this.msgOn(r.object_type)) await this.pull(id)
      else if (!r) await this.onNewDiscussion(id)
      return
    }
    // a new record (level 1)
    if (actionType === 'create') return this.onNewObject(subjectType, String(a.subject_id ?? ''))
    // a new discussion on a record (level 2)
    if (sourceType === 'Discussion' && a.source_id != null) return this.onNewDiscussion(String(a.source_id))
    if (actionType === 'discuss') await this.checkNewDiscussions()
  }

  async registerHooks(publicUrl: string): Promise<void> {
    if (!this.configured()) throw new AppError('CRMS_NOT_CONFIGURED', 'Connect Current RMS first (subdomain and API key)', 409)
    if (!/^https:\/\//.test(publicUrl)) {
      this.cfg.hooksError = 'NO_PUBLIC_URL'
      await this.save()
      return
    }
    for (const h of this.cfg.hooks) await this.api('DELETE', `/webhooks/${h.id}`).catch(() => undefined)
    this.cfg.hooks = []
    this.cfg.hookBase = publicUrl.replace(/\/+$/, '')
    const target = `${this.cfg.hookBase}/plugins/${PLUGIN_ID}/hook/${this.cfg.hookSecret}`
    const errors: string[] = []
    // only the events the chosen levels need
    for (const event of hookEvents(this.cfg.levels)) {
      try {
        const w = await this.api<{ webhook: { id: number } }>('POST', '/webhooks', { webhook: { name: `WhatsOps ${event}`, event, target_url: target, active: true } })
        this.cfg.hooks.push({ id: w.webhook.id, event })
      } catch (e) {
        errors.push(`${event}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.cfg.hooksError = errors[0] ?? null
    await this.save()
    logger.info({ mod: 'currentrms', hooks: this.cfg.hooks.length, error: this.cfg.hooksError }, 'Current RMS webhooks registered')
  }

  // ------------------------------------------------------------------ WhatsApp → Current
  private async onWhatsApp(ev: WaEvent): Promise<void> {
    if (!this.configured()) return
    // the same group is seen by the main and the backup number: only the one carrying the sync counts
    if (ev.account !== this.activeId()) return
    if (ev.type === 'group.participants') {
      // someone joined (e.g. the owner through the invite link): make them admin if they should be
      const d = ev.data as { group?: string; action?: string }
      if (d?.action !== 'add' || !d.group) return
      const r = (await this.app.h.db.selectFrom('crms_discussions').select(['id', 'sync']).where('group_jid', '=', d.group).executeTakeFirst()) as { id: string; sync: number } | undefined
      if (r?.sync) this.queueAdmins([r.id])
      return
    }
    if (ev.type !== 'message.received' && ev.type !== 'message.sent') return
    const m = ev.data as { id: string; chat: string; fromMe: boolean; senderName?: string | null; senderPhone?: string | null; text?: string | null; type: string; hasMedia?: boolean; upsertType?: string }
    if (!m?.chat?.endsWith('@g.us') || m.upsertType === 'append') return
    if (this.ownSent.has(m.id)) return
    const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('group_jid', '=', m.chat).executeTakeFirst()) as DiscRow | undefined
    if (!r?.sync || !this.msgOn(r.object_type)) return
    if (await this.mapped('wa_id', m.id)) return
    const text = (m.text ?? '').trim() || (m.hasMedia ? `[${m.type.replace(/Message$/, '')}]` : '')
    if (!text) return
    await this.lock(r.id, async () => {
      const parts = JSON.parse(r.participants || '[]') as Participant[]
      const phone = String(m.senderPhone ?? '').replace(/\D+/g, '')
      let member: { memberId: number } | undefined = !m.fromMe && phone ? parts.find((p) => p.whatsapp === phone) : undefined
      if (!member && !m.fromMe && phone) {
        // a Current RMS user who registered this number (e.g. the record's owner)
        const u = (await this.app.h.db.selectFrom('crms_users').select('member_id').where('phone', '=', phone).where('verified_at', 'is not', null).executeTakeFirst()) as { member_id: string } | undefined
        if (u) member = { memberId: Number(u.member_id) }
      }
      const label = `${m.senderName || (phone ? '+' + phone : '?')} (WhatsApp)`
      let created: { comment?: { id: number } } | null = null
      if (member) {
        created = await this.api<{ comment: { id: number } }>('POST', `/discussions/${r.id}/comments`, { comment: { remark: text, created_by: member.memberId } }).catch(() => null)
      }
      if (!created) {
        const body = m.fromMe ? text : `${label}: ${text}`
        created = await this.api<{ comment: { id: number } }>('POST', `/discussions/${r.id}/comments`, { comment: { remark: body } })
      }
      const cid = created?.comment?.id
      if (cid) {
        await this.mapRows(r.id, [cid], m.id, 'w2c')
        await this.setRow(r.id, { synced_comment_id: Math.max(cid, r.synced_comment_id ?? 0), last_comment_id: cid, last_at: now() })
      }
      logger.info({ mod: 'currentrms', discussion: r.id, comment: cid ?? null }, 'WhatsApp message → Current RMS comment')
    })
  }

  get isRefreshing(): boolean {
    return !!this.refreshing
  }

  status(p?: Principal) {
    const base = { configured: this.configured(), refreshing: this.isRefreshing, lastRefresh: this.lastRefresh || null, lastPoll: this.lastPoll || null }
    if (p?.kind === 'user') {
      // a user who doesn't manage the plugin sees no connection details
      const pp = pluginAccess(p.user, PLUGIN_ID)
      const scope = this.scopeOf(p)
      return { ...base, ...(pp?.manage ? { config: this.publicConfig() } : { config: { subdomain: this.cfg.subdomain, mode: this.cfg.mode } }), me: { manage: !!pp?.manage, scope: pp?.scope ?? 'owned', member: scope?.member ?? null } }
    }
    return { ...base, config: this.publicConfig() }
  }
}

// ---------------------------------------------------------------------- routes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Guard = (scope: 'read' | 'send' | 'admin') => any
type Need = 'view' | 'sync' | 'manage' | 'owner'
export function registerCurrentRms(fastify: FastifyInstance, app: App, plugin: CurrentRmsPlugin, _guard: Guard, tags: (t: string) => { tags: string[] }): void {
  const f = fastify.withTypeProvider<ZodTypeProvider>()
  const T = tags('Plugins')
  /**
   * Owner, API keys and OAuth: by scope (view = read, sync = send, manage/owner = admin).
   * Users: the plugin must be enabled for them; `manage` needs the plugin's manage permission;
   * `owner` (who gets access and with which permissions) is never open to users.
   */
  const access = (need: Need) => async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(app, req)
    if (!p) {
      reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
      throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
    }
    if (p.kind === 'user') {
      const pp = pluginAccess(p.user, PLUGIN_ID)
      if (!pp || need === 'owner' || (need === 'manage' && !pp.manage)) throw new AppError('FORBIDDEN', 'You are not allowed to do this', 403)
    } else requireScope(p, need === 'view' ? 'read' : need === 'sync' ? 'send' : 'admin')
    req.principal = p
  }
  const P = (req: FastifyRequest) => req.principal as Principal

  f.get(`/v1/plugins/${PLUGIN_ID}`, { preHandler: access('view'), schema: { ...T, summary: 'Current RMS: connection, settings, webhook state' } }, async (req) => plugin.status(P(req)))
  f.put(
    `/v1/plugins/${PLUGIN_ID}/config`,
    {
      preHandler: access('manage'),
      schema: {
        ...T,
        summary: 'Current RMS: save the connection and the plugin settings',
        body: z.object({
          subdomain: z.string().max(100).optional(),
          apiKey: z.string().max(300).optional(),
          account: z.string().max(64).optional(),
          mode: z.enum(['groups', 'community']).optional(),
          whatsappField: z.string().max(100).optional(),
          inviteFallback: z.boolean().optional(),
          ownerAdmin: z.boolean().optional(),
          backupAccount: z.string().max(64).optional(),
          pollMinutes: z.union([z.literal(2), z.literal(5), z.literal(15), z.literal(30)]).optional(),
          levels: z.record(z.string(), z.object({ objects: z.boolean().optional(), discussions: z.boolean().optional(), messages: z.boolean().optional() })).optional(),
        }),
      },
    },
    async (req) => {
      await plugin.updateConfig(req.body)
      return plugin.status(P(req))
    },
  )
  f.post(`/v1/plugins/${PLUGIN_ID}/test`, { preHandler: access('manage'), schema: { ...T, summary: 'Current RMS: test the connection' } }, async () => plugin.test())
  f.get(`/v1/plugins/${PLUGIN_ID}/custom-fields`, { preHandler: access('manage'), schema: { ...T, summary: 'Current RMS: custom fields of contacts (pick the WhatsApp one)' } }, async () => plugin.customFields())
  f.post(`/v1/plugins/${PLUGIN_ID}/webhooks`, { preHandler: access('manage'), schema: { ...T, summary: 'Current RMS: register the webhooks (new comments arrive at once)' } }, async (req) => {
    await plugin.registerHooks(publicOrigin(req, app.settings.get().publicUrl))
    return plugin.status(P(req))
  })
  f.post(`/v1/plugins/${PLUGIN_ID}/refresh`, { preHandler: access('view'), schema: { ...T, summary: 'Current RMS: read the discussions again (runs in the background)' } }, async (req) => {
    const p = plugin.refresh()
    p.catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'refresh failed'))
    await Promise.race([p, new Promise((r) => setTimeout(r, 15_000))])
    return plugin.status(P(req))
  })
  f.get(
    `/v1/plugins/${PLUGIN_ID}/discussions`,
    { preHandler: access('view'), schema: { ...T, summary: 'Current RMS: records and their discussions, with the sync state (a user sees only what their permissions allow)', querystring: z.object({ q: z.string().max(200).optional() }) } },
    async (req) => plugin.tree(req.query.q, plugin.scopeOf(P(req))),
  )
  f.put(
    `/v1/plugins/${PLUGIN_ID}/discussions/:id`,
    {
      preHandler: access('sync'),
      schema: { ...T, summary: 'Current RMS: turn the WhatsApp sync of a discussion on or off', params: z.object({ id: z.string() }), body: z.object({ sync: z.boolean() }) },
    },
    async (req) => plugin.setSync(req.params.id, req.body.sync, plugin.scopeOf(P(req))),
  )
  f.put(
    `/v1/plugins/${PLUGIN_ID}/records/:type/:id`,
    {
      preHandler: access('sync'),
      schema: { ...T, summary: 'Current RMS: create the WhatsApp group of a record, or stop managing it', params: z.object({ type: z.string().max(40), id: z.string().max(40) }), body: z.object({ group: z.boolean() }) },
    },
    async (req) => plugin.setObjectGroup(req.params.type, req.params.id, req.body.group, plugin.scopeOf(P(req))),
  )

  // ---- Current RMS users: their WhatsApp number (invite link) and their access to WhatsOps
  f.get(`/v1/plugins/${PLUGIN_ID}/users`, { preHandler: access('manage'), schema: { ...T, summary: 'Current RMS: users, their WhatsApp number and their access to WhatsOps' } }, async () => plugin.users())
  f.post(
    `/v1/plugins/${PLUGIN_ID}/users/:id/invite`,
    { preHandler: access('manage'), schema: { ...T, summary: 'Current RMS: personal link (14 days) where the user registers their WhatsApp number', params: z.object({ id: z.string() }) } },
    async (req) => plugin.invite(req.params.id, publicOrigin(req, app.settings.get().publicUrl)),
  )
  f.delete(
    `/v1/plugins/${PLUGIN_ID}/users/:id/phone`,
    { preHandler: access('manage'), schema: { ...T, summary: 'Current RMS: forget the WhatsApp number a user registered', params: z.object({ id: z.string() }) } },
    async (req) => {
      await plugin.removePhone(req.params.id)
      return { ok: true }
    },
  )
  f.put(
    `/v1/plugins/${PLUGIN_ID}/users/:id/access`,
    {
      preHandler: access('owner'),
      schema: {
        ...T,
        summary: 'Current RMS: access of a user to WhatsOps — on/off, only the records they own or all, manage the plugin',
        params: z.object({ id: z.string() }),
        body: z.object({ access: z.boolean().optional(), scope: z.enum(['owned', 'all']).optional(), manage: z.boolean().optional() }),
      },
    },
    async (req) => {
      const u = await plugin.setAccess(req.params.id, req.body)
      return { ok: true, userId: u?.id ?? null, perms: u?.perms.plugins[PLUGIN_ID] ?? null }
    },
  )

  // ---- the personal invite page (no login: the token is in the URL)
  f.get(`/join/${PLUGIN_ID}/:token`, { schema: { hide: true, params: z.object({ token: z.string().max(80) }) } }, async (req, reply) => {
    const lang = reqLang(req)
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    const info = await plugin.joinInfo(req.params.token)
    if (!info) return reply.code(404).send(messagePage(lang, tr(lang, 'Invalid link'), tr(lang, 'This link is not valid or has expired. Ask for a new one.')))
    return reply.send(joinPage(lang, { ...info, base: `/join/${PLUGIN_ID}/${req.params.token}` }))
  })
  const joinHits = new Map<string, number[]>()
  const joinLimit = (req: FastifyRequest) => {
    const ip = requestIp(req)
    const t = Date.now()
    const h = (joinHits.get(ip) ?? []).filter((x) => t - x < 600_000)
    if (h.length >= 20) throw new AppError('TOO_MANY_REQUESTS', 'Too many codes requested, wait a few minutes', 429)
    h.push(t)
    joinHits.set(ip, h)
  }
  f.post(`/join/${PLUGIN_ID}/:token/code`, { schema: { hide: true, params: z.object({ token: z.string().max(80) }), body: z.object({ phone: z.string().max(40) }) } }, async (req) => {
    joinLimit(req)
    return plugin.joinSendCode(req.params.token, req.body.phone, reqLang(req))
  })
  f.post(`/join/${PLUGIN_ID}/:token/verify`, { schema: { hide: true, params: z.object({ token: z.string().max(80) }), body: z.object({ code: z.string().max(12) }) } }, async (req, reply) => {
    joinLimit(req)
    const r = await plugin.joinVerify(req.params.token, req.body.code)
    // already enabled for WhatsOps: signed in straight away (the code just proved the number)
    const w = await app.users.bySource(`${PLUGIN_ID}:${r.memberId}`)
    let signedIn = false
    if (w && pluginAccess(w, PLUGIN_ID)) {
      await app.users.touch(w.id)
      const tok = await app.admin.createSession(`${w.name} · invite link · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`, w.id)
      app.admin.setCookie(reply, tok, publicOrigin(req, app.settings.get().publicUrl).startsWith('https://'))
      signedIn = true
    }
    return { phone: r.phone, signedIn }
  })

  // webhook target (no login: the secret is in the URL)
  f.post(`/plugins/${PLUGIN_ID}/hook/:secret`, { schema: { hide: true, params: z.object({ secret: z.string() }) } }, async (req, reply) => {
    if (!plugin.cfg.hookSecret || req.params.secret !== plugin.cfg.hookSecret) return reply.code(404).send()
    void plugin.onHook(req.body).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'webhook handling failed'))
    return { ok: true }
  })
}
