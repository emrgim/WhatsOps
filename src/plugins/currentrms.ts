/**
 * Plugin: Current RMS (OnRent Events) discussions ⇄ WhatsApp.
 *
 * Every discussion in Current RMS is attached to a record (opportunity, project, contact, invoice,
 * product, activity…). The plugin lists them grouped by record; a toggle per discussion turns the
 * sync on: WhatsOps creates a WhatsApp group (or a group inside a Community for the record — a
 * plugin setting), adds the discussion participants that have a WhatsApp number in the chosen
 * custom field, posts the whole discussion so far, then mirrors both ways:
 *   Current → WhatsApp  new comment (webhook `discussion_comment`, or polling) → "*Name*\ntext"
 *   WhatsApp → Current  message in the group → comment (as the matching member when possible)
 * Loop guard: every mirrored item is recorded (comment id ⇄ WhatsApp message id) and skipped.
 *
 * API: https://api.current-rms.com/api/v1, headers X-SUBDOMAIN + X-AUTH-TOKEN, 60 requests/min,
 * pages of max 100. Webhooks have no signature: the target URL carries a random secret.
 */
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { generateMessageIDV2 } from '@whiskeysockets/baileys'
import { getSetting, now, setSetting } from '../db/index.js'
import type { WaEvent } from '../events.js'
import { logger } from '../log.js'
import { AppError, toJid, userOf } from '../util.js'
import type { App } from '../app.js'
import type { WaAccount } from '../wa/account.js'

export const PLUGIN_ID = 'currentrms'
const API = (process.env.WA_CRMS_API || 'https://api.current-rms.com/api/v1').replace(/\/+$/, '')
const CONFIG_KEY = 'plugin:currentrms'
const POLL_MS = 120_000
const LIST_REFRESH_MS = 30 * 60_000
const GROUP_GAP_MS = 45_000 // never create WhatsApp groups in a burst
const MAX_CHUNK = 3500

export type CrmsConfig = {
  subdomain: string
  apiKey: string
  account: string // WhatsApp account id (phone number)
  mode: 'groups' | 'community'
  whatsappField: string // Member custom field (document_layout_name) holding the WhatsApp number
  inviteFallback: boolean // send the invite link privately to people who can't be added
  hookSecret: string
  hooks: { id: number; event: string }[]
  hooksError: string | null
}
const DEFAULT_CONFIG: CrmsConfig = { subdomain: '', apiKey: '', account: '', mode: 'groups', whatsappField: '', inviteFallback: true, hookSecret: '', hooks: [], hooksError: null }

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
}

/** Discussable types → API collection, name field, path in the web app, short label. */
const TYPES: Record<string, { coll: string; name: string; web: string; short: string }> = {
  Opportunity: { coll: 'opportunities', name: 'subject', web: 'opportunities', short: 'Opp.' },
  Project: { coll: 'projects', name: 'name', web: 'projects', short: 'Prj.' },
  Member: { coll: 'members', name: 'name', web: 'members', short: '' },
  Invoice: { coll: 'invoices', name: 'subject', web: 'invoices', short: 'Inv.' },
  Item: { coll: 'products', name: 'name', web: 'products', short: '' },
  Product: { coll: 'products', name: 'name', web: 'products', short: '' },
  Service: { coll: 'services', name: 'name', web: 'services', short: '' },
  Activity: { coll: 'activities', name: 'subject', web: 'activities', short: 'Act.' },
  Quarantine: { coll: 'quarantines', name: 'reference', web: 'quarantines', short: 'Qua.' },
  PurchaseOrder: { coll: 'purchase_orders', name: 'subject', web: 'purchase_orders', short: 'PO' },
}
const HOOK_EVENTS = ['discussion_comment', 'opportunity_discuss', 'project_discuss', 'member_discuss', 'invoice_discuss', 'item_discuss', 'activity_discuss', 'quarantine_discuss', 'po_discuss']

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
    setInterval(() => void this.poll().catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'poll failed')), POLL_MS).unref()
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
    const { apiKey, hookSecret, ...rest } = this.cfg
    return { ...rest, apiKeySet: !!apiKey, hookUrl: hookSecret ? `/plugins/${PLUGIN_ID}/hook/${hookSecret}` : null }
  }

  async updateConfig(p: Partial<Pick<CrmsConfig, 'subdomain' | 'apiKey' | 'account' | 'mode' | 'whatsappField' | 'inviteFallback'>>): Promise<void> {
    if (p.subdomain !== undefined) this.cfg.subdomain = p.subdomain.trim().replace(/^https?:\/\//, '').replace(/\.current-rms\.com.*$/, '').toLowerCase()
    if (p.apiKey) this.cfg.apiKey = p.apiKey.trim()
    if (p.account !== undefined) this.cfg.account = p.account
    if (p.mode) this.cfg.mode = p.mode === 'community' ? 'community' : 'groups'
    if (p.whatsappField !== undefined) this.cfg.whatsappField = p.whatsappField
    if (p.inviteFallback !== undefined) this.cfg.inviteFallback = !!p.inviteFallback
    await this.save()
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
        type D = { id: number; subject?: string; discussable_type: string; discussable_id: number; reply_count?: number; last_comment_id?: number; updated_at?: string; created_at?: string; participants?: { member_id: number }[] }
        const list = await this.all<D>('/discussions', 'discussions')
        // names of the records the discussions belong to
        const byType = new Map<string, Set<number>>()
        for (const d of list) {
          if (!byType.has(d.discussable_type)) byType.set(d.discussable_type, new Set())
          byType.get(d.discussable_type)!.add(d.discussable_id)
        }
        const names = new Map<string, string>()
        for (const [type, ids] of byType) {
          const t = TYPES[type]
          if (!t) continue
          const arr = [...ids]
          for (let i = 0; i < arr.length; i += 50) {
            const q = arr.slice(i, i + 50).map((id) => `q[id_in][]=${id}`).join('&')
            try {
              const rows = await this.all<Record<string, unknown>>(`/${t.coll}?${q}`, t.coll, 1)
              for (const r of rows) names.set(`${type}:${r.id}`, String(r[t.name] ?? r.name ?? r.subject ?? `#${r.id}`))
            } catch (e) {
              logger.debug({ mod: 'currentrms', type, err: String(e) }, 'record names not readable')
            }
          }
        }
        // participants: names and WhatsApp numbers, 100 members per call
        const memberIds = [...new Set(list.flatMap((d) => (d.participants ?? []).map((p) => p.member_id)).filter(Boolean))]
        const members = new Map<number, Participant>()
        for (let i = 0; i < memberIds.length; i += 100) {
          const q = memberIds.slice(i, i + 100).map((id) => `q[id_in][]=${id}`).join('&')
          try {
            const rows = await this.all<{ id: number; name?: string; custom_fields?: Record<string, unknown> }>(`/members?${q}`, 'members', 1)
            for (const m of rows) members.set(m.id, { memberId: m.id, name: m.name ?? '', whatsapp: this.waNumber(m.custom_fields) })
          } catch (e) {
            logger.debug({ mod: 'currentrms', err: String(e) }, 'participants not readable')
          }
        }
        const have = new Map(((await this.app.h.db.selectFrom('crms_discussions').selectAll().execute()) as DiscRow[]).map((r) => [r.id, r]))
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
          }
          if (cur) await this.app.h.db.updateTable('crms_discussions').set(row).where('id', '=', id).execute()
          else await this.app.h.db.insertInto('crms_discussions').values({ ...row, id, sync: 0, state: 'off', group_jid: null, error: null, synced_comment_id: null, created_at: now() }).execute()
        }
        this.lastRefresh = Date.now()
        logger.info({ mod: 'currentrms', discussions: list.length }, `discussions read from Current RMS: ${list.length}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** Records → discussions, for the plugin page / API / MCP. */
  async tree(q?: string) {
    const rows = (await this.app.h.db.selectFrom('crms_discussions').selectAll().execute()) as DiscRow[]
    const needle = (q ?? '').trim().toLowerCase()
    const groups = new Map<string, { type: string; id: string; name: string; url: string; discussions: unknown[]; last: number }>()
    for (const r of rows) {
      const name = r.object_name || `${r.object_type} #${r.object_id}`
      if (needle && !`${name} ${r.subject ?? ''}`.toLowerCase().includes(needle)) continue
      const k = `${r.object_type}:${r.object_id}`
      if (!groups.has(k)) groups.set(k, { type: r.object_type, id: r.object_id, name, url: this.webUrl(r.object_type, r.object_id), discussions: [], last: 0 })
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
      })
      g.last = Math.max(g.last, r.last_at ?? 0)
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

  private account(): WaAccount {
    const acc = this.app.accounts.get(this.cfg.account || undefined)
    acc.requireOpen()
    return acc
  }

  private async row(id: string): Promise<DiscRow> {
    const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('id', '=', id).executeTakeFirst()) as DiscRow | undefined
    if (!r) throw new AppError('CRMS_NO_DISCUSSION', 'Discussion {0} not found (refresh the list)', 404, [id])
    return r
  }

  private async setRow(id: string, set: Partial<DiscRow>): Promise<void> {
    await this.app.h.db.updateTable('crms_discussions').set(set).where('id', '=', id).execute()
  }

  async setSync(id: string, on: boolean): Promise<unknown> {
    const r = await this.row(id)
    if (!on) {
      await this.setRow(id, { sync: 0, state: r.group_jid ? 'paused' : 'off' })
      logger.info({ mod: 'currentrms', discussion: id }, 'sync off')
      return (await this.tree()).flatMap((g) => g.discussions).find((d) => (d as { id: string }).id === id)
    }
    this.account() // fail fast when WhatsApp is not connected
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
    const out: Participant[] = []
    for (const p of d.discussion.participants ?? []) {
      let name = p.member?.name ?? ''
      let whatsapp: string | null = null
      try {
        const m = await this.api<{ member: { name?: string; custom_fields?: Record<string, unknown> } }>('GET', `/members/${p.member_id}`)
        name = m.member.name ?? name
        whatsapp = this.waNumber(m.member.custom_fields)
      } catch {
        /* member not readable: keep the name we have */
      }
      out.push({ memberId: p.member_id, name, whatsapp })
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

  private async paceGroups(): Promise<void> {
    const wait = this.lastGroupAt + GROUP_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastGroupAt = Date.now()
  }

  private async activate(id: string): Promise<void> {
    const r = await this.row(id)
    if (!r.sync) return
    const acc = this.account()
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
        const community = await this.communityFor(r)
        meta = await sock.communityCreateGroup(this.groupSubject(r, true), [], community)
      } else {
        meta = await sock.groupCreate(this.groupSubject(r, false), [])
      }
      if (!meta?.id) throw new AppError('CRMS_GROUP', 'WhatsApp did not create the group', 502)
      group = meta.id
      await this.setRow(id, { group_jid: group })
      // sealed: only admins add people or change the group, new members need approval
      await sock.groupUpdateDescription(group, description).catch(() => undefined)
      await sock.groupMemberAddMode(group, 'admin_add').catch(() => undefined)
      await sock.groupJoinApprovalMode(group, 'on').catch(() => undefined)
      await sock.groupSettingUpdate(group, 'locked').catch(() => undefined)
      logger.info({ mod: 'currentrms', discussion: id, mode: this.cfg.mode }, `WhatsApp group created for discussion ${id}`)
    }
    // participants (people who can't be added get the invite link privately)
    if (jids.length) {
      const res = await sock.groupParticipantsUpdate(group, jids, 'add').catch(() => [] as { status: string; jid?: string }[])
      const refused = res.filter((x) => x.status === '403' || x.status === '408').map((x) => x.jid).filter(Boolean) as string[]
      if (refused.length && this.cfg.inviteFallback) {
        const code = await sock.groupInviteCode(group).catch(() => null)
        if (code) {
          for (const j of refused) {
            await acc
              .sendRaw(j, { text: `${(r.subject || r.object_name || '').trim()}\nhttps://chat.whatsapp.com/${code}` })
              .catch(() => undefined)
          }
        }
      }
    }
    // the whole discussion so far, grouped by day, in few messages
    if (!r.synced_comment_id) {
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

  private async communityFor(r: DiscRow): Promise<string> {
    const k = `${r.object_type}:${r.object_id}`
    const have = (await this.app.h.db.selectFrom('crms_objects').selectAll().where('key', '=', k).executeTakeFirst()) as { community_jid: string } | undefined
    if (have?.community_jid) return have.community_jid
    const sock = this.account().requireOpen()
    await this.paceGroups()
    const name = clip(`${TYPES[r.object_type]?.short ? TYPES[r.object_type].short + ' ' : ''}${r.object_name || '#' + r.object_id}`, 100)
    const meta = await sock.communityCreate(name, `${this.webUrl(r.object_type, r.object_id)}\nCurrent RMS ⇄ WhatsApp (WhatsOps)`)
    if (!meta?.id) throw new AppError('CRMS_GROUP', 'WhatsApp did not create the community', 502)
    await sock.communityJoinApprovalMode(meta.id, 'on').catch(() => undefined)
    await sock.communityMemberAddMode(meta.id, 'admin_add').catch(() => undefined)
    await this.app.h.db.insertInto('crms_objects').values({ key: k, community_jid: meta.id, name, created_at: now() }).execute()
    logger.info({ mod: 'currentrms', object: k }, 'WhatsApp community created')
    return meta.id
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
      if (!r.sync || !r.group_jid || r.synced_comment_id == null) return 0
      const acc = this.account()
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

  /** Fallback when webhooks don't reach us: check the synced discussions every 2 minutes. */
  async poll(): Promise<void> {
    if (!this.configured()) return
    const rows = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('sync', '=', 1).execute()) as DiscRow[]
    for (const r of rows.slice(0, 25)) {
      if (r.state === 'creating') continue
      if (r.state === 'error' && !r.group_jid) {
        void this.lock(r.id, () => this.activate(r.id)).catch(() => undefined)
        continue
      }
      try {
        const d = await this.api<{ discussion: { last_comment_id?: number } }>('GET', `/discussions/${r.id}`)
        if ((d.discussion.last_comment_id ?? 0) > (r.synced_comment_id ?? 0)) await this.pull(r.id)
      } catch (e) {
        logger.debug({ mod: 'currentrms', discussion: r.id, err: String(e) }, 'poll failed')
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
    if (subjectType === 'Discussion') {
      const id = String(a.subject_id)
      const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('id', '=', id).executeTakeFirst()) as DiscRow | undefined
      if (r?.sync) await this.pull(id)
      else if (!r) void this.refresh().catch(() => undefined)
      return
    }
    if (sourceType === 'Discussion' || String(a.action_type ?? '') === 'discuss') void this.refresh().catch(() => undefined)
  }

  async registerHooks(publicUrl: string): Promise<void> {
    if (!/^https:\/\//.test(publicUrl)) {
      this.cfg.hooksError = 'NO_PUBLIC_URL'
      await this.save()
      return
    }
    for (const h of this.cfg.hooks) await this.api('DELETE', `/webhooks/${h.id}`).catch(() => undefined)
    this.cfg.hooks = []
    const target = `${publicUrl.replace(/\/+$/, '')}/plugins/${PLUGIN_ID}/hook/${this.cfg.hookSecret}`
    const errors: string[] = []
    for (const event of HOOK_EVENTS) {
      try {
        const w = await this.api<{ webhook: { id: number } }>('POST', '/webhooks', { webhook: { name: `WhatsOps ${event}`, event, target_url: target, active: true } })
        this.cfg.hooks.push({ id: w.webhook.id, event })
      } catch (e) {
        errors.push(`${event}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.cfg.hooksError = this.cfg.hooks.some((h) => h.event === 'discussion_comment') ? null : errors[0] ?? 'webhooks not created'
    await this.save()
    logger.info({ mod: 'currentrms', hooks: this.cfg.hooks.length, error: this.cfg.hooksError }, 'Current RMS webhooks registered')
  }

  // ------------------------------------------------------------------ WhatsApp → Current
  private async onWhatsApp(ev: WaEvent): Promise<void> {
    if (ev.type !== 'message.received' && ev.type !== 'message.sent') return
    if (!this.configured()) return
    const m = ev.data as { id: string; chat: string; fromMe: boolean; senderName?: string | null; senderPhone?: string | null; text?: string | null; type: string; hasMedia?: boolean; upsertType?: string }
    if (!m?.chat?.endsWith('@g.us') || m.upsertType === 'append') return
    if (this.ownSent.has(m.id)) return
    const r = (await this.app.h.db.selectFrom('crms_discussions').selectAll().where('group_jid', '=', m.chat).executeTakeFirst()) as DiscRow | undefined
    if (!r?.sync) return
    if (await this.mapped('wa_id', m.id)) return
    const text = (m.text ?? '').trim() || (m.hasMedia ? `[${m.type.replace(/Message$/, '')}]` : '')
    if (!text) return
    await this.lock(r.id, async () => {
      const parts = JSON.parse(r.participants || '[]') as Participant[]
      const phone = String(m.senderPhone ?? '').replace(/\D+/g, '')
      const member = !m.fromMe && phone ? parts.find((p) => p.whatsapp === phone) : undefined
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

  status() {
    return { configured: this.configured(), config: this.publicConfig(), refreshing: this.isRefreshing, lastRefresh: this.lastRefresh || null, lastPoll: this.lastPoll || null }
  }
}

// ---------------------------------------------------------------------- routes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Guard = (scope: 'read' | 'send' | 'admin') => any
export function registerCurrentRms(fastify: FastifyInstance, app: App, plugin: CurrentRmsPlugin, guard: Guard, tags: (t: string) => { tags: string[] }): void {
  const f = fastify.withTypeProvider<ZodTypeProvider>()
  const T = tags('Plugins')
  f.get(`/v1/plugins/${PLUGIN_ID}`, { preHandler: guard('admin'), schema: { ...T, summary: 'Current RMS: connection, settings, webhook state' } }, async () => plugin.status())
  f.put(
    `/v1/plugins/${PLUGIN_ID}/config`,
    {
      preHandler: guard('admin'),
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
        }),
      },
    },
    async (req) => {
      await plugin.updateConfig(req.body)
      return plugin.status()
    },
  )
  f.post(`/v1/plugins/${PLUGIN_ID}/test`, { preHandler: guard('admin'), schema: { ...T, summary: 'Current RMS: test the connection' } }, async () => plugin.test())
  f.get(`/v1/plugins/${PLUGIN_ID}/custom-fields`, { preHandler: guard('admin'), schema: { ...T, summary: 'Current RMS: custom fields of contacts (pick the WhatsApp one)' } }, async () => plugin.customFields())
  f.post(`/v1/plugins/${PLUGIN_ID}/webhooks`, { preHandler: guard('admin'), schema: { ...T, summary: 'Current RMS: register the webhooks (new comments arrive at once)' } }, async (req) => {
    const host = app.settings.get().publicUrl || `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`
    await plugin.registerHooks(String(host))
    return plugin.status()
  })
  f.post(`/v1/plugins/${PLUGIN_ID}/refresh`, { preHandler: guard('admin'), schema: { ...T, summary: 'Current RMS: read the discussions again (runs in the background)' } }, async () => {
    const p = plugin.refresh()
    p.catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'refresh failed'))
    await Promise.race([p, new Promise((r) => setTimeout(r, 15_000))])
    return plugin.status()
  })
  f.get(
    `/v1/plugins/${PLUGIN_ID}/discussions`,
    { preHandler: guard('read'), schema: { ...T, summary: 'Current RMS: records and their discussions, with the sync state', querystring: z.object({ q: z.string().max(200).optional() }) } },
    async (req) => plugin.tree(req.query.q),
  )
  f.put(
    `/v1/plugins/${PLUGIN_ID}/discussions/:id`,
    {
      preHandler: guard('send'),
      schema: { ...T, summary: 'Current RMS: turn the WhatsApp sync of a discussion on or off', params: z.object({ id: z.string() }), body: z.object({ sync: z.boolean() }) },
    },
    async (req) => plugin.setSync(req.params.id, req.body.sync),
  )
  // webhook target (no login: the secret is in the URL)
  f.post(`/plugins/${PLUGIN_ID}/hook/:secret`, { schema: { hide: true, params: z.object({ secret: z.string() }) } }, async (req, reply) => {
    if (!plugin.cfg.hookSecret || req.params.secret !== plugin.cfg.hookSecret) return reply.code(404).send()
    void plugin.onHook(req.body).catch((e) => logger.warn({ mod: 'currentrms', err: String(e) }, 'webhook handling failed'))
    return { ok: true }
  })
}

