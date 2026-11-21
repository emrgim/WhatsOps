import crypto from 'node:crypto'
import { downloadMediaMessage, getContentType, normalizeMessageContent, type AnyMessageContent, type WAMessageKey } from '@whiskeysockets/baileys'
import { sql } from 'kysely'
import { now, upsert, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import type { Settings } from '../settings.js'
import { AppError, bareJid, digits, isGroupJid, toJid, userOf } from '../util.js'
import type { WaAccount } from './account.js'
import type { AccountManager } from './manager.js'
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
  async listChats(acc: WaAccount, o: { limit?: number; offset?: number; unreadOnly?: boolean; query?: string; type?: 'all' | 'groups' | 'direct' }) {
    let q = this.h.db.selectFrom('chats').selectAll().where('account_id', '=', acc.id)
    if (o.unreadOnly) q = q.where('unread', '>', 0)
    if (o.type === 'groups') q = q.where('is_group', '=', 1)
    if (o.type === 'direct') q = q.where('is_group', '=', 0)
    if (o.query) q = q.where('name', likeOp(this.h), `%${escLike(o.query)}%`)
    const rows = await q
      .orderBy(sql`coalesce(last_ts, 0)`, 'desc')
      .limit(Math.min(o.limit ?? 30, 200))
      .offset(o.offset ?? 0)
      .execute()
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
      })
    }
    return out
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
