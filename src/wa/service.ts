import crypto from 'node:crypto'
import { downloadMediaMessage, getContentType, isWABusinessPlatform, jidNormalizedUser, normalizeMessageContent, type AnyMessageContent, type WAMessageKey } from '@whiskeysockets/baileys'
import { sql } from 'kysely'
import { now, upsert, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import type { Settings } from '../settings.js'
import { AppError, bareJid, digits, isGroupJid, toJid, userOf } from '../util.js'
import type { WaAccount } from './account.js'
import type { AccountManager } from './manager.js'
import { labelLinks, listLabels, pickLabel, type Label } from './labels.js'
import { loadStatuses, saveStatus, STATUS_LIFE_MS } from './statuses.js'
import { parseMessage, type MessageRow } from './store.js'

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

function likeOp(h: DbHandle): 'ilike' | 'like' {
  return h.dialect === 'postgres' ? 'ilike' : 'like'
}

function escLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

export class WaService {
  /** voice transcripts (set at start): attached to audio messages, searched with the text */
  voice?: { attach(accountId: string, msgs: { id: string; chat: string; type: string; transcript?: string | null }[]): Promise<void>; search(accountId: string, op: 'like' | 'ilike', pattern: string, limit: number): Promise<{ chat_jid: string; msg_id: string }[]> }

  constructor(
    public h: DbHandle,
    public accounts: AccountManager,
    public settings: Settings,
  ) {}

  // ------------------------------------------------------------ recipients
  /** Accepts phone / JID / LID / group id / exact chat or contact name. */
  async resolveChat(acc: WaAccount, input: string): Promise<string> {
    const s = String(input ?? '').trim()
    if (!s) throw new AppError('INVALID_CHAT', 'chat/recipient is required', 400)
    if (s.includes('@') || /^[+\d][\d\s().-]{5,}$/.test(s) || /^\d{6,}-\d{6,}$/.test(s)) {
      const jid = toJid(s)
      return acc.store.canonical(jid)
    }
    // name lookup
    const matches = await this.findContacts(acc, s, 6)
    const exact = matches.filter((m) => (m.name ?? '').toLowerCase() === s.toLowerCase())
    const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null
    if (pick) return pick.jid
    if (!matches.length) throw new AppError('CHAT_NOT_FOUND', 'No chat or contact named "{0}". Use a phone number in international format.', 404, [s])
    throw new AppError('AMBIGUOUS_CHAT', '"{0}" matches several chats: {1}. Use the phone number or JID.', 409, [s, matches.map((m) => `${m.name ?? '?'} (${m.phone ?? m.jid})`).join('; ')])
  }

  private checkAllowlist(jid: string): void {
    const al = this.settings.get().sendAllowlist.trim()
    if (!al || al === '*') return
    const entries = al.split(/[,\s]+/).filter(Boolean)
    const d = userOf(jid)
    const ok = entries.some((e) => (e.includes('@') ? bareJid(e) === bareJid(jid) : digits(e) === d))
    if (!ok) throw new AppError('NOT_ALLOWED', 'Sending to {0} is blocked by the send allowlist (config page → Settings).', 403, [jid])
  }

  private async checkCold(acc: WaAccount, jid: string): Promise<void> {
    if (this.settings.get().allowColdContacts || isGroupJid(jid)) return
    const aliases = acc.store.aliases(jid)
    const r = await this.h.db.selectFrom('messages').select('id').where('account_id', '=', acc.id).where('chat_jid', 'in', aliases).limit(1).executeTakeFirst()
    if (!r) throw new AppError('COLD_CONTACT', 'No previous conversation with {0}; cold messaging is disabled in settings.', 403, [jid])
  }

  private async prepareRecipient(acc: WaAccount, to: string): Promise<string> {
    let jid = await this.resolveChat(acc, to)
    this.checkAllowlist(jid)
    if (jid.endsWith('@s.whatsapp.net')) jid = await acc.resolveRecipient(jid)
    await this.checkCold(acc, jid)
    return jid
  }

  // ------------------------------------------------------------ idempotency
  private async withIdempotency<T extends { id: string }>(acc: WaAccount, key: string | undefined, chat: string, fn: () => Promise<T>): Promise<T & { duplicate?: boolean }> {
    if (!key) return fn()
    const k = key.slice(0, 180)
    const ex = await this.h.db.selectFrom('outbox').selectAll().where('account_id', '=', acc.id).where('idem_key', '=', k).executeTakeFirst()
    if (ex?.state === 'sent') return { id: ex.msg_id, chat: ex.chat_jid, duplicate: true } as unknown as T & { duplicate: boolean }
    if (ex?.state === 'pending' && now() - ex.updated_at < 120_000) throw new AppError('IN_FLIGHT', 'A send with this idempotency key is still in progress', 409)
    await upsert(this.h, 'outbox', { account_id: acc.id, idem_key: k, chat_jid: chat, state: 'pending', msg_id: null, error: null, created_at: ex?.created_at ?? now(), updated_at: now() }, ['account_id', 'idem_key'])
    try {
      const r = await fn()
      await this.h.db.updateTable('outbox').set({ state: 'sent', msg_id: r.id, updated_at: now() }).where('account_id', '=', acc.id).where('idem_key', '=', k).execute()
      return r
    } catch (e) {
      await this.h.db.updateTable('outbox').set({ state: 'failed', error: String((e as Error).message).slice(0, 500), updated_at: now() }).where('account_id', '=', acc.id).where('idem_key', '=', k).execute()
      throw e
    }
  }

  // ------------------------------------------------------------ reads
  async listChats(acc: WaAccount, o: { limit?: number; offset?: number; unreadOnly?: boolean; query?: string; type?: 'all' | 'groups' | 'direct'; label?: string }) {
    const labels = await listLabels(this.h, acc.id)
    let q = this.h.db.selectFrom('chats').selectAll().where('account_id', '=', acc.id)
    // chats carrying the label (stored under the phone number or the LID), also those with no message in WhatsOps
    let labelled: string[] | null = null
    if (o.label) {
      const l = pickLabel(labels, o.label)
      labelled = [...new Set((await labelLinks(this.h, acc.id, l.id)).filter((k) => !k.messageId).map((k) => acc.store.canonical(k.chat)))]
      if (!labelled.length) return []
      q = q.where('jid', 'in', [...new Set(labelled.flatMap((j) => acc.store.aliases(j)))])
    }
    if (o.unreadOnly) q = q.where('unread', '>', 0)
    if (o.type === 'groups') q = q.where('is_group', '=', 1)
    if (o.type === 'direct') q = q.where('is_group', '=', 0)
    if (o.query) q = q.where('name', likeOp(this.h), `%${escLike(o.query)}%`)
    const limit = Math.min(o.limit ?? 30, 200)
    let base = q.orderBy(sql`coalesce(last_ts, 0)`, 'desc')
    if (!labelled) base = base.limit(limit).offset(o.offset ?? 0) // a label has few chats: paged below, with the missing ones
    const rows = await base.execute()
    const onChat = await this.chatLabels(acc, labels, [...rows.map((r) => r.jid), ...(labelled ?? [])])
    const out = []
    for (const r of rows) {
      const last = await this.h.db
        .selectFrom('messages')
        .select(['id', 'from_me', 'text', 'type', 'ts', 'sender'])
        .where('account_id', '=', acc.id)
        .where('chat_jid', '=', r.jid)
        .orderBy('ts', 'desc')
        .limit(1)
        .executeTakeFirst()
      out.push({
        jid: r.jid,
        name: r.name ?? (await acc.store.nameOf(r.jid)),
        phone: r.is_group ? null : acc.store.phoneOf(r.jid),
        isGroup: !!r.is_group,
        unread: r.unread ?? 0,
        archived: !!r.archived,
        pinned: !!r.pinned,
        lastMessageAt: r.last_ts ? new Date(r.last_ts * 1000).toISOString() : null,
        lastMessage: last ? { id: last.id, fromMe: !!last.from_me, text: last.text, type: last.type } : null,
        labels: onChat.get(r.jid) ?? [],
      })
    }
    if (!labelled) return out
    // labelled on the phone, but without messages here (e.g. chats older than the link)
    const have = new Set(rows.flatMap((r) => acc.store.aliases(r.jid)))
    for (const jid of labelled) {
      if (have.has(jid)) continue
      const group = isGroupJid(jid)
      out.push({ jid, name: await acc.store.nameOf(jid), phone: group ? null : acc.store.phoneOf(jid), isGroup: group, unread: 0, archived: false, pinned: false, lastMessageAt: null, lastMessage: null, labels: onChat.get(jid) ?? [] })
    }
    return out.slice(o.offset ?? 0, (o.offset ?? 0) + limit)
  }

  /** Labels on these chats (not on their messages), by chat. */
  private async chatLabels(acc: WaAccount, labels: Label[], chats: string[]): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>()
    if (!labels.length || !chats.length) return out
    const owner = new Map<string, string>() // alias → chat as listed
    for (const c of chats) for (const j of acc.store.aliases(c)) owner.set(j, c)
    const names = new Map(labels.map((l) => [l.id, l.name]))
    for (const k of await labelLinks(this.h, acc.id, undefined, [...owner.keys()])) {
      const c = owner.get(k.chat)
      if (!c || k.messageId || !names.has(k.labelId)) continue
      const list = out.get(c) ?? []
      if (!list.some((x) => x.id === k.labelId)) list.push({ id: k.labelId, name: names.get(k.labelId)! })
      out.set(c, list)
    }
    return out
  }

  /**
   * Put labels on a chat (or one of its messages) or take them off: the change goes to WhatsApp, so the
   * phone and WhatsApp Web show it too. WhatsApp Business only (regular WhatsApp has chat lists instead).
   */
  async labelChat(acc: WaAccount, i: { chat: string; add?: string[]; remove?: string[]; messageId?: string }) {
    const sock = acc.requireOpen()
    const platform = (sock.authState.creds as { platform?: string }).platform
    if (platform && !isWABusinessPlatform(platform)) throw new AppError('LABELS_BUSINESS_ONLY', 'Labels can be changed only on a WhatsApp Business number', 400)
    if (!i.add?.length && !i.remove?.length) throw new AppError('LABELS_NOTHING', 'Say which labels to add or remove', 400)
    const chat = await this.resolveChat(acc, i.chat)
    const labels = await listLabels(this.h, acc.id)
    const add = (i.add ?? []).map((x) => pickLabel(labels, x))
    const remove = (i.remove ?? []).map((x) => pickLabel(labels, x))
    const msgId = i.messageId?.trim() || null
    const links = await labelLinks(this.h, acc.id, undefined, acc.store.aliases(chat))
    // WhatsApp keeps the labels of a chat under one form of its id (phone number or LID): keep using it
    const form = links[0]?.chat ?? chat
    const here = links.filter((k) => (k.messageId ?? null) === msgId)
    const has = new Set(here.map((k) => k.labelId))
    const added: string[] = []
    const removed: string[] = []
    for (const l of remove) {
      const forms = [...new Set(here.filter((k) => k.labelId === l.id).map((k) => k.chat))]
      for (const f of forms) {
        if (msgId) await sock.removeMessageLabel(f, msgId, l.id)
        else await sock.removeChatLabel(f, l.id)
      }
      if (forms.length) {
        removed.push(l.name)
        has.delete(l.id)
      }
    }
    for (const l of add) {
      if (has.has(l.id)) continue
      if (msgId) await sock.addMessageLabel(form, msgId, l.id)
      else await sock.addChatLabel(form, l.id)
      added.push(l.name)
      has.add(l.id)
    }
    if (added.length || removed.length) logger.info({ account: acc.id, added, removed, message: msgId }, 'labels changed on a chat')
    // the table follows from WhatsApp's own echo of the change (labels.association)
    return { chat, messageId: msgId, added, removed, labels: labels.filter((l) => has.has(l.id)).map((l) => ({ id: l.id, name: l.name })) }
  }

  /** Read every label again from WhatsApp (normally not needed: changes arrive by themselves). */
  async reloadLabels(acc: WaAccount) {
    return acc.readAllLabels()
  }

  /** The labels of the number; with a label (id or name), the chats and messages that carry it. */
  async labels(acc: WaAccount, labelInput?: string) {
    const labels = await listLabels(this.h, acc.id)
    if (!labelInput) return { labels }
    const label = pickLabel(labels, labelInput)
    const chats: { jid: string; name: string | null; phone: string | null; isGroup: boolean }[] = []
    const messages: { chat: string; chatName: string | null; id: string; message: unknown }[] = []
    for (const k of await labelLinks(this.h, acc.id, label.id)) {
      const jid = acc.store.canonical(k.chat)
      const name = await acc.store.nameOf(jid)
      if (!k.messageId) {
        if (!chats.some((c) => c.jid === jid)) chats.push({ jid, name, phone: isGroupJid(jid) ? null : acc.store.phoneOf(jid), isGroup: isGroupJid(jid) })
        continue
      }
      const row = await acc.store.loadRow(jid, k.messageId)
      messages.push({ chat: jid, chatName: name, id: k.messageId, message: row ? await acc.summarize(row) : null })
    }
    return { label, chats, messages }
  }

  async getMessages(acc: WaAccount, chatInput: string, o: { limit?: number; before?: string | number; after?: string | number }) {
    const chat = await this.resolveChat(acc, chatInput)
    const aliases = acc.store.aliases(chat)
    let q = this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('chat_jid', 'in', aliases)
    const toTs = (v: string | number) => (typeof v === 'number' ? (v > 1e12 ? Math.floor(v / 1000) : v) : Math.floor(Date.parse(v) / 1000))
    if (o.before !== undefined && o.before !== '') q = q.where('ts', '<', toTs(o.before))
    if (o.after !== undefined && o.after !== '') q = q.where('ts', '>', toTs(o.after))
    const rows = (await q.orderBy('ts', 'desc').limit(Math.min(o.limit ?? 30, 500)).execute()) as MessageRow[]
    const msgs = []
    for (const r of rows.reverse()) msgs.push(await acc.summarize(r))
    await this.voice?.attach(acc.id, msgs)
    return { chat, chatName: await acc.store.nameOf(chat), messages: msgs }
  }

  async searchMessages(acc: WaAccount, query: string, o: { chat?: string; limit?: number; since?: string }) {
    const limit = Math.min(o.limit ?? 30, 200)
    const pattern = `%${escLike(query)}%`
    const chats = o.chat ? acc.store.aliases(await this.resolveChat(acc, o.chat)) : null
    const since = o.since ? Math.floor(Date.parse(o.since) / 1000) : null
    let q = this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('text', likeOp(this.h), pattern)
    if (chats) q = q.where('chat_jid', 'in', chats)
    if (since) q = q.where('ts', '>=', since)
    const rows = (await q.orderBy('ts', 'desc').limit(limit).execute()) as MessageRow[]
    // what was said in voice messages is searchable too
    const hits = (await this.voice?.search(acc.id, likeOp(this.h), pattern, limit)) ?? []
    for (const hit of hits) {
      if (chats && !chats.includes(hit.chat_jid)) continue
      if (rows.some((r) => r.id === hit.msg_id && r.chat_jid === hit.chat_jid)) continue
      const r = await acc.store.loadRow(hit.chat_jid, hit.msg_id)
      if (r && (!since || r.ts >= since)) rows.push(r)
    }
    rows.sort((a, b) => b.ts - a.ts)
    const out = []
    for (const r of rows.slice(0, limit)) out.push(await acc.summarize(r))
    await this.voice?.attach(acc.id, out)
    return out
  }

  async findContacts(acc: WaAccount, query: string, limit = 20) {
    const s = query.trim()
    const d = digits(s)
    const op = likeOp(this.h)
    const pat = `%${escLike(s)}%`
    let q = this.h.db.selectFrom('contacts').selectAll().where('account_id', '=', acc.id)
    q = q.where((eb) => {
      const ors = [eb('name', op, pat), eb('notify', op, pat), eb('verified_name', op, pat)]
      if (d.length >= 4) ors.push(eb('jid', 'like', `%${d}%`), eb('pn', 'like', `%${d}%`))
      return eb.or(ors)
    })
    const contacts = await q.limit(limit).execute()
    const chats = await this.h.db.selectFrom('chats').select(['jid', 'name', 'is_group']).where('account_id', '=', acc.id).where('name', op, pat).limit(limit).execute()
    const seen = new Map<string, { jid: string; name: string | null; phone: string | null; isGroup: boolean; savedName: string | null; pushName: string | null; lid: string | null }>()
    for (const c of contacts) {
      const jid = c.pn ?? c.jid
      seen.set(jid, { jid, name: c.name || c.notify || c.verified_name, phone: acc.store.phoneOf(jid), isGroup: false, savedName: c.name, pushName: c.notify, lid: c.lid })
    }
    for (const c of chats) {
      if (!seen.has(c.jid)) seen.set(c.jid, { jid: c.jid, name: c.name, phone: c.is_group ? null : acc.store.phoneOf(c.jid), isGroup: !!c.is_group, savedName: null, pushName: null, lid: null })
    }
    return [...seen.values()].slice(0, limit)
  }

  async listGroups(acc: WaAccount, o: { query?: string; refresh?: boolean }) {
    if (o.refresh) await acc.refreshGroups()
    let q = this.h.db.selectFrom('wa_groups').select(['jid', 'subject', 'data']).where('account_id', '=', acc.id)
    if (o.query) q = q.where('subject', likeOp(this.h), `%${escLike(o.query)}%`)
    const rows = await q.orderBy('subject').limit(500).execute()
    return rows.map((r) => {
      const g = JSON.parse(r.data || '{}')
      return { jid: r.jid, subject: r.subject, participants: Array.isArray(g.participants) ? g.participants.length : null, owner: g.owner ?? null, announce: !!g.announce }
    })
  }

  async getGroup(acc: WaAccount, input: string) {
    const jid = await this.resolveChat(acc, input)
    if (!isGroupJid(jid)) throw new AppError('NOT_A_GROUP', '{0} is not a group', 400, [jid])
    const g = (await acc.refreshGroup(jid).catch(() => undefined)) ?? (await acc.store.groupMeta(jid))
    if (!g) throw new AppError('GROUP_NOT_FOUND', 'Group {0} not found', 404, [jid])
    const participants = []
    for (const p of g.participants ?? []) {
      const pj = (p as { phoneNumber?: string }).phoneNumber ?? p.id
      participants.push({ jid: bareJid(p.id), phone: acc.store.phoneOf(pj) ?? (pj.endsWith('@s.whatsapp.net') ? '+' + userOf(pj) : null), name: await acc.store.nameOf(pj), admin: p.admin ?? null })
    }
    return { jid: g.id, subject: g.subject, description: g.desc ?? null, owner: g.owner ?? null, created: g.creation ? new Date(g.creation * 1000).toISOString() : null, announce: !!g.announce, restrict: !!g.restrict, participants }
  }

  // ------------------------------------------------------------ writes
  private async quoted(acc: WaAccount, chat: string, id?: string) {
    if (!id) return undefined
    const m = await acc.store.loadMessage(chat, id)
    if (!m) throw new AppError('MESSAGE_NOT_FOUND', 'Message {0} not found in {1}', 404, [id, chat])
    return m
  }

  async sendText(acc: WaAccount, i: { to: string; text: string; replyTo?: string; mentions?: string[]; idempotencyKey?: string; linkPreview?: boolean }) {
    if (!i.text?.trim()) throw new AppError('EMPTY_TEXT', 'text is required', 400)
    const jid = await this.prepareRecipient(acc, i.to)
    return this.withIdempotency(acc, i.idempotencyKey, jid, async () => {
      const quoted = await this.quoted(acc, jid, i.replyTo)
      const mentions = (i.mentions ?? []).map((m) => toJid(m))
      const msg = await acc.sendRaw(jid, { text: i.text, ...(mentions.length ? { mentions } : {}) } as AnyMessageContent, quoted ? { quoted } : undefined)
      return { id: msg.key.id!, chat: jid, timestamp: new Date().toISOString(), status: 'sent' }
    })
  }

  async fetchMedia(url: string): Promise<{ buf: Buffer; mimetype?: string; fileName?: string }> {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new AppError('INVALID_URL', 'media url is not a valid URL', 400)
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new AppError('INVALID_URL', 'Only http(s) media URLs are allowed', 400)
    const max = this.settings.get().maxMediaMb * 1024 * 1024
    const res = await fetch(u, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
    if (!res.ok) throw new AppError('MEDIA_FETCH_FAILED', 'Fetching media failed: HTTP {0}', 502, [res.status])
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > max) throw new AppError('MEDIA_TOO_LARGE', 'Media larger than {0} MB', 413, [this.settings.get().maxMediaMb])
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw new AppError('MEDIA_TOO_LARGE', 'Media larger than {0} MB', 413, [this.settings.get().maxMediaMb])
    const fileName = decodeURIComponent(u.pathname.split('/').pop() || '') || undefined
    return { buf, mimetype: res.headers.get('content-type')?.split(';')[0] ?? undefined, fileName }
  }

  async sendMedia(
    acc: WaAccount,
    i: { to: string; type: MediaType; url?: string; base64?: string; mimetype?: string; fileName?: string; caption?: string; ptt?: boolean; replyTo?: string; idempotencyKey?: string },
  ) {
    const jid = await this.prepareRecipient(acc, i.to)
    const { buf, mimetype, fileName } = await this.loadMedia(i)
    let content: AnyMessageContent
    switch (i.type) {
      case 'image':
        content = { image: buf, caption: i.caption, ...(mimetype ? { mimetype } : {}) }
        break
      case 'video':
        content = { video: buf, caption: i.caption, ...(mimetype ? { mimetype } : {}) }
        break
      case 'audio':
        content = { audio: buf, mimetype: mimetype ?? (i.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4'), ptt: !!i.ptt }
        break
      case 'sticker':
        content = { sticker: buf }
        break
      case 'document':
      default:
        content = { document: buf, mimetype: mimetype ?? 'application/octet-stream', fileName: fileName ?? 'file', caption: i.caption }
    }
    return this.withIdempotency(acc, i.idempotencyKey, jid, async () => {
      const quoted = await this.quoted(acc, jid, i.replyTo)
      const msg = await acc.sendRaw(jid, content, quoted ? { quoted } : undefined)
      return { id: msg.key.id!, chat: jid, timestamp: new Date().toISOString(), status: 'sent', bytes: buf.length }
    })
  }

  /** The file of a media message: from base64 (or a data: URL) or downloaded from a URL, within the size limit. */
  private async loadMedia(i: { url?: string; base64?: string; mimetype?: string; fileName?: string }): Promise<{ buf: Buffer; mimetype?: string; fileName?: string }> {
    let buf: Buffer
    let mimetype = i.mimetype
    let fileName = i.fileName
    if (i.base64) {
      const b64 = i.base64.replace(/^data:([^;]+);base64,/, (_m, mt) => {
        mimetype = mimetype ?? mt
        return ''
      })
      buf = Buffer.from(b64, 'base64')
      if (buf.length > this.settings.get().maxMediaMb * 1024 * 1024) throw new AppError('MEDIA_TOO_LARGE', 'media too large', 413)
    } else if (i.url) {
      const f = await this.fetchMedia(i.url)
      buf = f.buf
      mimetype = mimetype ?? f.mimetype
      fileName = fileName ?? f.fileName
    } else throw new AppError('NO_MEDIA', 'Provide url or base64', 400)
    if (!buf.length) throw new AppError('NO_MEDIA', 'media is empty', 400)
    return { buf, mimetype, fileName }
  }

  /**
   * Post a status (story) that only the listed people can see: WhatsApp delivers it to them and to my own
   * devices, nobody else. Text, image or video; it disappears after 24 hours like any status.
   */
  async postStatus(
    acc: WaAccount,
    i: { audience: string[]; type: 'text' | 'image' | 'video'; text?: string; url?: string; base64?: string; mimetype?: string; caption?: string },
  ) {
    if (!i.audience?.length) throw new AppError('STATUS_AUDIENCE_REQUIRED', 'Say who may see the status: at least one phone number or contact', 400)
    const audience: string[] = []
    for (const who of i.audience) {
      const jid = await this.prepareRecipient(acc, who)
      if (isGroupJid(jid)) throw new AppError('STATUS_AUDIENCE_GROUP', 'A status is seen by people, not groups: {0}', 400, [who])
      if (!audience.includes(jid)) audience.push(jid)
    }
    let content: AnyMessageContent
    if (i.type === 'text') {
      if (!i.text?.trim()) throw new AppError('EMPTY_TEXT', 'text is required', 400)
      content = { text: i.text }
    } else {
      const { buf, mimetype } = await this.loadMedia(i)
      content = i.type === 'video' ? { video: buf, caption: i.caption, ...(mimetype ? { mimetype } : {}) } : { image: buf, caption: i.caption, ...(mimetype ? { mimetype } : {}) }
    }
    const me = acc.requireOpen().user?.id
    const statusJidList = [...audience, ...(me ? [jidNormalizedUser(me)] : [])]
    const msg = await acc.sendRaw('status@broadcast', content, { broadcast: true, statusJidList })
    const at = Date.now()
    await saveStatus(this.h, acc.id, { id: msg.key.id!, ts: at, type: i.type, text: (i.type === 'text' ? i.text : i.caption) || null, audience, source: 'whatsops' })
    return { id: msg.key.id!, audience, type: i.type, timestamp: new Date(at).toISOString(), status: 'sent' }
  }

  /**
   * My statuses (default: the ones still visible, last 24 hours) with who opened each and, when the
   * audience is known, who did not yet; `people` = who saw how many of them (the whole story).
   */
  async statusViews(acc: WaAccount, q: { statusId?: string; since?: string }) {
    let since: number | undefined
    if (q.since) {
      since = Date.parse(q.since)
      if (!Number.isFinite(since)) throw new AppError('INVALID_INPUT', 'since must be an ISO date', 400)
    }
    const { statuses, views } = await loadStatuses(this.h, acc.id, { id: q.statusId?.trim() || undefined, since })
    if (q.statusId && !statuses.length) throw new AppError('STATUS_NOT_FOUND', 'No status {0} of this number', 404, [q.statusId])
    const st = acc.store
    const person = async (jid: string) => ({ jid, name: await st.nameOf(jid), phone: st.phoneOf(jid) })
    const iso = (ms: number | null | undefined) => (ms ? new Date(Number(ms)).toISOString() : null)
    const people = new Map<string, { jid: string; name: string | null; phone: string | null; saw: number; of: number; last: number }>()
    const out = []
    for (const s of statuses) {
      const audience = s.audience ? (JSON.parse(s.audience) as string[]).map((j) => st.canonical(j)) : null
      // one person can answer under the phone number and under the LID: the first opening counts
      const seen = new Map<string, number>()
      for (const v of views) {
        if (v.status_id !== s.id || !v.viewed_at) continue
        const jid = st.canonical(v.viewer)
        const at = Number(v.viewed_at)
        if (!seen.has(jid) || at < seen.get(jid)!) seen.set(jid, at)
      }
      const viewers = []
      for (const [jid, at] of [...seen].sort((a, b) => a[1] - b[1])) {
        viewers.push({ ...(await person(jid)), viewedAt: iso(at) })
        const p = people.get(jid) ?? { ...(await person(jid)), saw: 0, of: 0, last: 0 }
        p.saw++
        p.last = Math.max(p.last, at)
        people.set(jid, p)
      }
      const notViewed = audience ? await Promise.all([...new Set(audience)].filter((j) => !seen.has(j)).map(person)) : null
      const ts = Number(s.ts ?? 0)
      out.push({
        id: s.id,
        postedAt: iso(ts),
        type: s.type,
        text: s.text && s.text.length > 300 ? `${s.text.slice(0, 300)}…` : s.text,
        postedFrom: s.source,
        active: !!ts && Date.now() - ts < STATUS_LIFE_MS && !Number(s.deleted),
        audience: audience ? new Set(audience).size : null,
        views: viewers.length,
        viewers,
        notViewed,
        _audience: audience,
      })
    }
    // how many of the listed statuses each viewer could see (all, when the audience is unknown)
    for (const p of people.values()) p.of = out.filter((s) => !s._audience || s._audience.includes(p.jid)).length
    return {
      statuses: out.map(({ _audience, ...s }) => s),
      people: [...people.values()]
        .sort((a, b) => b.saw - a.saw || b.last - a.last)
        .map((p) => ({ jid: p.jid, name: p.name, phone: p.phone, saw: p.saw, of: p.of, lastViewedAt: iso(p.last) })),
    }
  }

  async sendLocation(acc: WaAccount, i: { to: string; latitude: number; longitude: number; name?: string; address?: string }) {
    const jid = await this.prepareRecipient(acc, i.to)
    const msg = await acc.sendRaw(jid, { location: { degreesLatitude: i.latitude, degreesLongitude: i.longitude, name: i.name, address: i.address } })
    return { id: msg.key.id!, chat: jid, status: 'sent' }
  }

  private async keyFor(acc: WaAccount, chatInput: string, messageId: string): Promise<{ chat: string; key: WAMessageKey }> {
    const chat = await this.resolveChat(acc, chatInput)
    const row = await acc.store.loadRow(chat, messageId)
    if (!row) throw new AppError('MESSAGE_NOT_FOUND', 'Message {0} not found in {1}', 404, [messageId, chat])
    const m = parseMessage(row.raw)
    return { chat: m.key.remoteJid ?? chat, key: m.key as WAMessageKey }
  }

  async react(acc: WaAccount, i: { chat: string; messageId: string; emoji: string }) {
    const { chat, key } = await this.keyFor(acc, i.chat, i.messageId)
    this.checkAllowlist(chat)
    await acc.sendRaw(chat, { react: { text: i.emoji ?? '', key } })
    return { ok: true, chat, messageId: i.messageId, emoji: i.emoji }
  }

  async markRead(acc: WaAccount, i: { chat: string; messageIds?: string[] }) {
    const sock = acc.requireOpen()
    const chat = await this.resolveChat(acc, i.chat)
    let rows: MessageRow[]
    if (i.messageIds?.length) {
      rows = (await this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('chat_jid', 'in', acc.store.aliases(chat)).where('id', 'in', i.messageIds).execute()) as MessageRow[]
    } else {
      rows = (await this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('chat_jid', 'in', acc.store.aliases(chat)).where('from_me', '=', 0).orderBy('ts', 'desc').limit(20).execute()) as MessageRow[]
    }
    const keys = rows.map((r) => parseMessage(r.raw).key as WAMessageKey)
    if (keys.length) await sock.readMessages(keys)
    await this.h.db.updateTable('chats').set({ unread: 0 }).where('account_id', '=', acc.id).where('jid', '=', chat).execute()
    return { ok: true, chat, read: keys.length }
  }

  async editMessage(acc: WaAccount, i: { chat: string; messageId: string; text: string }) {
    const { chat, key } = await this.keyFor(acc, i.chat, i.messageId)
    if (!key.fromMe) throw new AppError('NOT_OWN_MESSAGE', 'Only messages sent by this account can be edited', 403)
    await acc.sendRaw(chat, { text: i.text, edit: key })
    return { ok: true, chat, messageId: i.messageId }
  }

  async deleteMessage(acc: WaAccount, i: { chat: string; messageId: string }) {
    const { chat, key } = await this.keyFor(acc, i.chat, i.messageId)
    if (!key.fromMe && !isGroupJid(chat)) throw new AppError('NOT_OWN_MESSAGE', 'Only your own messages can be deleted for everyone', 403)
    await acc.sendRaw(chat, { delete: key })
    return { ok: true, chat, messageId: i.messageId }
  }

  /** Set disappearing-messages duration for a chat and/or the account default for new chats. */
  async setDisappearing(acc: WaAccount, i: { chat?: string; seconds: number; accountDefault?: boolean }) {
    const seconds = i.seconds
    if (!Number.isInteger(seconds) || seconds < 0) {
      throw new AppError(
        'INVALID_DURATION',
        'seconds must be a non-negative integer (0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days)',
        400,
      )
    }
    if (!i.chat && !i.accountDefault) {
      throw new AppError('INVALID_INPUT', 'Provide a chat, or set accountDefault to true, or both.', 400)
    }
    const out: { ok: true; seconds: number; accountDefault?: boolean; chat?: string; messageId?: string } = { ok: true, seconds }
    if (i.accountDefault) {
      const sock = acc.requireOpen()
      await sock.updateDefaultDisappearingMode(seconds)
      out.accountDefault = true
    }
    if (i.chat) {
      const jid = await this.resolveChat(acc, i.chat)
      const msg = await acc.sendRaw(jid, { disappearingMessagesInChat: seconds })
      out.chat = jid
      out.messageId = msg.key?.id ?? undefined
    }
    return out
  }

  // ------------------------------------------------------------ media
  async downloadMedia(acc: WaAccount, chatInput: string | undefined, messageId: string): Promise<{ buf: Buffer; mimetype: string; fileName: string }> {
    const chat = chatInput ? await this.resolveChat(acc, chatInput) : undefined
    const m = await acc.store.loadMessage(chat, messageId)
    if (!m) throw new AppError('MESSAGE_NOT_FOUND', 'Message {0} not found', 404, [messageId])
    const content = normalizeMessageContent(m.message)
    const type = content ? getContentType(content) : undefined
    const inner = type ? ((content as Record<string, unknown>)[type] as { mimetype?: string; fileName?: string; fileLength?: number } | undefined) : undefined
    const media = type === 'documentWithCaptionMessage' ? content?.documentWithCaptionMessage?.message?.documentMessage : inner
    if (!media || !type || !/image|video|audio|document|sticker|ptv/i.test(type)) throw new AppError('NO_MEDIA', 'This message has no media', 400)
    const max = this.settings.get().maxMediaMb * 1024 * 1024
    if (Number(media.fileLength ?? 0) > max) throw new AppError('MEDIA_TOO_LARGE', 'media larger than the configured cap', 413)
    const sock = acc.sock
    let buf: Buffer
    try {
      buf = (await downloadMediaMessage(m, 'buffer', {}, { logger: logger as never, reuploadRequest: sock ? sock.updateMediaMessage : async (x) => x })) as Buffer
    } catch (e) {
      throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed: {0}', 502, [String((e as Error).message ?? e)])
    }
    const mimetype = media.mimetype?.split(';')[0] ?? 'application/octet-stream'
    const ext = mimetype.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
    return { buf, mimetype, fileName: media.fileName ?? `${messageId}.${ext}` }
  }

  signMediaToken(account: string, chat: string, id: string, ttlSec = 3600): string {
    const payload = Buffer.from(JSON.stringify({ a: account, c: chat, i: id, e: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url')
    const sig = crypto.createHmac('sha256', this.settings.secret).update(payload).digest('base64url').slice(0, 32)
    return `${payload}.${sig}`
  }

  verifyMediaToken(token: string): { a: string; c: string; i: string } {
    const [payload, sig] = String(token).split('.')
    if (!payload || !sig) throw new AppError('INVALID_TOKEN', 'invalid media link', 403)
    const exp = crypto.createHmac('sha256', this.settings.secret).update(payload).digest('base64url').slice(0, 32)
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) throw new AppError('INVALID_TOKEN', 'invalid media link', 403)
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (d.e < Date.now() / 1000) throw new AppError('EXPIRED', 'media link expired', 410)
    return d
  }

  async stats(acc: WaAccount) {
    const count = async (t: string) => Number((await this.h.db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).where('account_id', '=', acc.id).executeTakeFirst())?.n ?? 0)
    return { messages: await count('messages'), chats: await count('chats'), contacts: await count('contacts'), groups: await count('wa_groups') }
  }
}
