import {
  BufferJSON,
  getContentType,
  normalizeMessageContent,
  proto,
  toNumber,
  type Chat,
  type ChatUpdate,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
} from '@whiskeysockets/baileys'
import { now, upsertMany, type DbHandle } from '../db/index.js'
import { bareJid, isGroupJid, isLidJid, isPnJid, userOf } from '../util.js'
import { logger } from '../log.js'

const SKIP_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'messageContextInfo', 'keepInChatMessage', 'encReactionMessage'])
const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'documentWithCaptionMessage', 'ptvMessage'])

export type MessageRow = {
  account_id: string
  chat_jid: string
  id: string
  from_me: number
  sender: string | null
  ts: number
  type: string
  text: string | null
  status: number | null
  raw: string
}

export function messageText(content: proto.IMessage | null | undefined): string | null {
  if (!content) return null
  const c = content
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    (c.documentMessage?.fileName ? `[document] ${c.documentMessage.fileName}` : null) ||
    (c.audioMessage ? (c.audioMessage.ptt ? '[voice note]' : '[audio]') : null) ||
    (c.stickerMessage ? '[sticker]' : null) ||
    (c.imageMessage ? '[image]' : null) ||
    (c.videoMessage ? '[video]' : null) ||
    (c.contactMessage ? `[contact] ${c.contactMessage.displayName ?? ''}` : null) ||
    (c.contactsArrayMessage ? `[contacts] ${c.contactsArrayMessage.displayName ?? ''}` : null) ||
    (c.locationMessage ? `[location] ${[c.locationMessage.name, c.locationMessage.address, `${c.locationMessage.degreesLatitude},${c.locationMessage.degreesLongitude}`].filter(Boolean).join(' · ')}` : null) ||
    (c.liveLocationMessage ? '[live location]' : null) ||
    (c.pollCreationMessage || c.pollCreationMessageV3
      ? `[poll] ${(c.pollCreationMessage || c.pollCreationMessageV3)?.name ?? ''}: ${((c.pollCreationMessage || c.pollCreationMessageV3)?.options ?? []).map((o) => o.optionName).join(' / ')}`
      : null) ||
    c.buttonsResponseMessage?.selectedDisplayText ||
    c.listResponseMessage?.title ||
    c.templateButtonReplyMessage?.selectedDisplayText ||
    c.editedMessage?.message?.protocolMessage?.editedMessage?.conversation ||
    null
  )
}

export function serializeMessage(m: WAMessage): string {
  return JSON.stringify(m, BufferJSON.replacer)
}

/** Parse a stored message, whether it was written by us (BufferJSON) or by a plain JSON.stringify (protobuf toJSON, base64 bytes). */
export function parseMessage(raw: string): WAMessage {
  const obj = JSON.parse(raw, BufferJSON.reviver)
  const key = obj.key
  const msg = proto.WebMessageInfo.fromObject(obj) as WAMessage
  // keep v7 key extras (remoteJidAlt etc.) that protobuf drops
  if (key) msg.key = { ...msg.key, ...key }
  return msg
}

export class WaStore {
  private lidCache = new Map<string, string>() // lid -> pn
  private pnCache = new Map<string, string>() // pn -> lid

  constructor(
    private h: DbHandle,
    private accountId: string,
  ) {}

  // ---------------------------------------------------------------- LID map
  async loadLidMap(): Promise<void> {
    const rows = await this.h.db.selectFrom('lid_map').select(['lid', 'pn']).where('account_id', '=', this.accountId).execute()
    for (const r of rows) {
      this.lidCache.set(r.lid, r.pn)
      this.pnCache.set(r.pn, r.lid)
    }
  }

  /**
   * Seed the LID map from the session's own `lid-mapping` keys. A session imported from another
   * program carries thousands of them while `lid_map` starts empty, so receipts and messages keyed
   * by LID would not find their phone-number chat.
   */
  async seedLidMapFromAuth(): Promise<number> {
    const rows = await this.h.db.selectFrom('auth_keys').select(['id', 'data']).where('account_id', '=', this.accountId).where('type', '=', 'lid-mapping').execute()
    const pairs: { lid: string; pn: string }[] = []
    for (const r of rows) {
      if (!r.id.endsWith('_reverse') || !r.data) continue
      let pnUser: unknown
      try {
        pnUser = JSON.parse(r.data)
      } catch {
        continue
      }
      if (typeof pnUser !== 'string' || !/^\d+$/.test(pnUser)) continue
      pairs.push({ lid: `${r.id.slice(0, -'_reverse'.length)}@lid`, pn: `${pnUser}@s.whatsapp.net` })
    }
    return (await this.addLidMappings(pairs)).length
  }

  /**
   * Move chats, messages and contacts stored under a LID to the phone-number JID once the mapping
   * is known, so one person is one chat and later receipts (keyed by LID) update the right rows.
   */
  async mergeLidAliases(only?: string[]): Promise<{ chats: number; messages: number; contacts: number }> {
    const acc = this.accountId
    const out = { chats: 0, messages: 0, contacts: 0 }
    const db = this.h.db
    const want = only?.map((l) => bareJid(l)).filter((l) => isLidJid(l))
    if (want && !want.length) return out
    // whole-table scan at startup, targeted lookups when new mappings arrive
    const scan = async (table: 'chats' | 'messages' | 'contacts', col: 'jid' | 'chat_jid' | 'sender'): Promise<Set<string>> => {
      const found = new Set<string>()
      const parts = want ? Array.from({ length: Math.ceil(want.length / 500) }, (_, i) => want.slice(i * 500, i * 500 + 500)) : [null]
      for (const part of parts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q = (db as any).selectFrom(table).select(col).distinct().where('account_id', '=', acc)
        q = part ? q.where(col, 'in', part) : q.where(col, 'like', '%@lid')
        for (const r of (await q.execute()) as Record<string, string | null>[]) if (r[col]) found.add(r[col] as string)
      }
      return found
    }
    const lidChats = await scan('chats', 'jid')
    const lidMsgChats = await scan('messages', 'chat_jid')
    const lidSenders = await scan('messages', 'sender')
    const lidContacts = await scan('contacts', 'jid')
    const candidates = want ?? [...new Set([...lidChats, ...lidMsgChats, ...lidSenders, ...lidContacts])]
    for (const lid of candidates) {
      const pn = this.lidCache.get(lid)
      if (!pn || !(lidChats.has(lid) || lidMsgChats.has(lid) || lidSenders.has(lid) || lidContacts.has(lid))) continue
      await db.transaction().execute(async (tx) => {
        if (lidMsgChats.has(lid)) {
          const lidIds = (await tx.selectFrom('messages').select('id').where('account_id', '=', acc).where('chat_jid', '=', lid).execute()).map((r) => r.id)
          const dup = new Set<string>()
          for (let i = 0; i < lidIds.length; i += 500) {
            const part = lidIds.slice(i, i + 500)
            for (const r of await tx.selectFrom('messages').select('id').where('account_id', '=', acc).where('chat_jid', '=', pn).where('id', 'in', part).execute()) dup.add(r.id)
          }
          const dupIds = [...dup]
          for (let i = 0; i < dupIds.length; i += 500) {
            await tx.deleteFrom('messages').where('account_id', '=', acc).where('chat_jid', '=', lid).where('id', 'in', dupIds.slice(i, i + 500)).execute()
          }
          const moved = await tx.updateTable('messages').set({ chat_jid: pn }).where('account_id', '=', acc).where('chat_jid', '=', lid).executeTakeFirst()
          out.messages += Number(moved.numUpdatedRows)
        }
        if (lidSenders.has(lid)) await tx.updateTable('messages').set({ sender: pn }).where('account_id', '=', acc).where('sender', '=', lid).execute()
        if (lidChats.has(lid)) {
          const l = await tx.selectFrom('chats').selectAll().where('account_id', '=', acc).where('jid', '=', lid).executeTakeFirst()
          const p = await tx.selectFrom('chats').selectAll().where('account_id', '=', acc).where('jid', '=', pn).executeTakeFirst()
          if (l && p) {
            await tx
              .updateTable('chats')
              .set({ name: p.name ?? l.name, last_ts: Math.max(Number(p.last_ts) || 0, Number(l.last_ts) || 0) || null })
              .where('account_id', '=', acc)
              .where('jid', '=', pn)
              .execute()
            await tx.deleteFrom('chats').where('account_id', '=', acc).where('jid', '=', lid).execute()
          } else if (l) {
            await tx.updateTable('chats').set({ jid: pn }).where('account_id', '=', acc).where('jid', '=', lid).execute()
          }
          out.chats++
        }
        if (lidContacts.has(lid)) {
          const l = await tx.selectFrom('contacts').selectAll().where('account_id', '=', acc).where('jid', '=', lid).executeTakeFirst()
          const p = await tx.selectFrom('contacts').selectAll().where('account_id', '=', acc).where('jid', '=', pn).executeTakeFirst()
          if (l && p) {
            await tx
              .updateTable('contacts')
              .set({ lid, name: p.name ?? l.name, notify: p.notify ?? l.notify, verified_name: p.verified_name ?? l.verified_name })
              .where('account_id', '=', acc)
              .where('jid', '=', pn)
              .execute()
            await tx.deleteFrom('contacts').where('account_id', '=', acc).where('jid', '=', lid).execute()
          } else if (l) {
            await tx.updateTable('contacts').set({ jid: pn, pn, lid }).where('account_id', '=', acc).where('jid', '=', lid).execute()
          }
          out.contacts++
        }
      })
    }
    return out
  }

  async addLidMappings(pairs: { lid: string; pn: string }[]): Promise<string[]> {
    const rows: Record<string, unknown>[] = []
    for (const p of pairs) {
      const lid = bareJid(p.lid)
      const pn = bareJid(p.pn)
      if (!lid || !pn || !isLidJid(lid) || !isPnJid(pn)) continue
      if (this.lidCache.get(lid) === pn) continue
      this.lidCache.set(lid, pn)
      this.pnCache.set(pn, lid)
      rows.push({ account_id: this.accountId, lid, pn })
    }
    if (rows.length) {
      // a PN might have been mapped to another LID before: keep one row per lid
      await upsertMany(this.h, 'lid_map', rows, ['account_id', 'lid'], ['pn'])
    }
    return rows.map((r) => r.lid as string)
  }

  pnForLid(lid: string): string | undefined {
    return this.lidCache.get(bareJid(lid))
  }

  lidForPn(pn: string): string | undefined {
    return this.pnCache.get(bareJid(pn))
  }

  /** Canonical chat id: PN for 1:1 chats when we know it, else as given. */
  canonical(jid: string | null | undefined, alt?: string | null): string {
    const j = bareJid(jid ?? '')
    if (!j) return ''
    if (isLidJid(j)) {
      const a = bareJid(alt ?? '')
      if (a && isPnJid(a)) return a
      return this.lidCache.get(j) ?? j
    }
    return j
  }

  /** Every JID a 1:1 chat may be stored under. */
  aliases(jid: string): string[] {
    const j = bareJid(jid)
    const out = new Set([j])
    if (isPnJid(j)) {
      const l = this.pnCache.get(j)
      if (l) out.add(l)
    } else if (isLidJid(j)) {
      const p = this.lidCache.get(j)
      if (p) out.add(p)
    }
    return [...out]
  }

  // ---------------------------------------------------------------- messages
  toRow(m: WAMessage): MessageRow | null {
    const key = m.key as WAMessageKey
    if (!key?.remoteJid || !key.id) return null
    if (key.remoteJid === 'status@broadcast') return null
    const content = normalizeMessageContent(m.message)
    let type = content ? getContentType(content) ?? 'unknown' : m.messageStubType ? 'stub' : 'unknown'
    if (type === 'unknown' && !m.messageStubType) return null
    if (SKIP_TYPES.has(type)) return null
    if (type === 'stub') type = `stub:${m.messageStubType}`
    const chat = this.canonical(key.remoteJid, key.remoteJidAlt)
    let sender: string | null
    if (key.fromMe) sender = 'me'
    else if (isGroupJid(chat)) sender = this.canonical(key.participant, key.participantAlt) || null
    else sender = chat
    return {
      account_id: this.accountId,
      chat_jid: chat,
      id: key.id,
      from_me: key.fromMe ? 1 : 0,
      sender,
      ts: toNumber(m.messageTimestamp as number) || Math.floor(now() / 1000),
      type,
      text: messageText(content),
      status: typeof m.status === 'number' ? m.status : null,
      raw: serializeMessage(m),
    }
  }

  async upsertMessages(msgs: WAMessage[]): Promise<MessageRow[]> {
    const rows: MessageRow[] = []
    const names: Record<string, unknown>[] = []
    const lastTs = new Map<string, number>()
    for (const m of msgs) {
      let r: MessageRow | null = null
      try {
        r = this.toRow(m)
      } catch (e) {
        logger.debug({ err: String(e) }, 'message row failed')
      }
      if (!r) continue
      rows.push(r)
      lastTs.set(r.chat_jid, Math.max(lastTs.get(r.chat_jid) ?? 0, r.ts))
      if (!r.from_me && m.pushName && r.sender && r.sender !== 'me') {
        names.push({ account_id: this.accountId, jid: r.sender, notify: m.pushName })
      }
    }
    if (rows.length) await upsertMany(this.h, 'messages', rows, ['account_id', 'chat_jid', 'id'])
    if (names.length) {
      const dedup = new Map(names.map((n) => [n.jid as string, n]))
      await upsertMany(this.h, 'contacts', [...dedup.values()], ['account_id', 'jid'], ['notify'])
    }
    for (const [jid, ts] of lastTs) await this.touchChat(jid, ts)
    return rows
  }

  async applyMessageUpdates(updates: WAMessageUpdate[]): Promise<void> {
    for (const u of updates) {
      const key = u.key as WAMessageKey
      if (!key?.id || !key.remoteJid) continue
      const chat = this.canonical(key.remoteJid, key.remoteJidAlt)
      const existing = await this.loadRow(chat, key.id)
      if (!existing) continue
      const set: Record<string, unknown> = {}
      if (typeof u.update.status === 'number') set.status = u.update.status
      if (u.update.message) {
        const msg = parseMessage(existing.raw)
        const edited = normalizeMessageContent(u.update.message)
        const inner = edited?.editedMessage?.message?.protocolMessage?.editedMessage ?? edited?.protocolMessage?.editedMessage ?? edited
        if (inner) {
          const t = messageText(inner)
          if (t) set.text = t
          msg.message = { ...(msg.message ?? {}), ...inner }
          set.raw = serializeMessage(msg)
        }
      }
      if (u.update.messageStubType === proto.WebMessageInfo.StubType.REVOKE || (u.update.message === null && u.update.key)) {
        set.text = '[deleted]'
        set.type = 'revoked'
      }
      if (Object.keys(set).length) {
        await this.h.db.updateTable('messages').set(set).where('account_id', '=', this.accountId).where('chat_jid', '=', chat).where('id', '=', key.id).execute()
      }
    }
  }

  async deleteMessages(keys: WAMessageKey[]): Promise<void> {
    for (const k of keys) {
      if (!k.id || !k.remoteJid) continue
      const chat = this.canonical(k.remoteJid, k.remoteJidAlt)
      await this.h.db.updateTable('messages').set({ text: '[deleted]', type: 'revoked' }).where('account_id', '=', this.accountId).where('chat_jid', '=', chat).where('id', '=', k.id).execute()
    }
  }

  async loadRow(chat: string, id: string): Promise<MessageRow | undefined> {
    const aliases = this.aliases(chat)
    return (await this.h.db
      .selectFrom('messages')
      .selectAll()
      .where('account_id', '=', this.accountId)
      .where('chat_jid', 'in', aliases)
      .where('id', '=', id)
      .executeTakeFirst()) as MessageRow | undefined
  }

  async loadById(id: string): Promise<MessageRow | undefined> {
    return (await this.h.db.selectFrom('messages').selectAll().where('account_id', '=', this.accountId).where('id', '=', id).executeTakeFirst()) as
      | MessageRow
      | undefined
  }

  async loadMessage(chat: string | undefined, id: string): Promise<WAMessage | undefined> {
    const row = chat ? await this.loadRow(chat, id) : await this.loadById(id)
    return row ? parseMessage(row.raw) : undefined
  }

  /** Baileys getMessage hook: needed for retries / poll decryption. */
  async getMessageContent(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id) return undefined
    const row = key.remoteJid ? await this.loadRow(this.canonical(key.remoteJid, key.remoteJidAlt), key.id) : await this.loadById(key.id)
    if (!row) return undefined
    try {
      return parseMessage(row.raw).message ?? undefined
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------- chats
  private chatRow(c: Partial<Chat> & { id?: string | null }): Record<string, unknown> | null {
    if (!c.id) return null
    const jid = this.canonical(c.id, (c as { pnJid?: string }).pnJid)
    if (!jid || jid === 'status@broadcast') return null
    const { messages: _m, ...rest } = c as Chat & { messages?: unknown }
    void _m
    const ts = toNumber((c.conversationTimestamp ?? c.lastMessageRecvTimestamp ?? 0) as number) || null
    return {
      account_id: this.accountId,
      jid,
      name: c.name ?? (c as { subject?: string }).subject ?? null,
      is_group: isGroupJid(jid) ? 1 : 0,
      unread: typeof c.unreadCount === 'number' ? c.unreadCount : null,
      last_ts: ts,
      archived: c.archived ? 1 : 0,
      pinned: c.pinned ? 1 : 0,
      data: JSON.stringify(rest, BufferJSON.replacer).slice(0, 20000),
    }
  }

  async upsertChats(chats: Partial<Chat>[]): Promise<void> {
    const rows = chats.map((c) => this.chatRow(c)).filter(Boolean) as Record<string, unknown>[]
    const dedup = new Map(rows.map((r) => [r.jid as string, r]))
    for (const r of dedup.values()) {
      const existing = await this.h.db.selectFrom('chats').select(['name', 'last_ts']).where('account_id', '=', this.accountId).where('jid', '=', r.jid as string).executeTakeFirst()
      if (existing) {
        if (!r.name) r.name = existing.name
        if (!r.last_ts || (existing.last_ts && existing.last_ts > (r.last_ts as number))) r.last_ts = existing.last_ts
      }
    }
    await upsertMany(this.h, 'chats', [...dedup.values()], ['account_id', 'jid'])
  }

  async updateChats(updates: ChatUpdate[]): Promise<void> {
    for (const u of updates) {
      if (!u.id) continue
      const jid = this.canonical(u.id)
      const set: Record<string, unknown> = {}
      if (typeof u.unreadCount === 'number') set.unread = u.unreadCount
      if (u.name) set.name = u.name
      if (typeof u.archived === 'boolean') set.archived = u.archived ? 1 : 0
      if (u.pinned !== undefined) set.pinned = u.pinned ? 1 : 0
      const ts = toNumber((u.conversationTimestamp ?? 0) as number)
      if (ts) set.last_ts = ts
      if (!Object.keys(set).length) continue
      const res = await this.h.db.updateTable('chats').set(set).where('account_id', '=', this.accountId).where('jid', '=', jid).executeTakeFirst()
      if (!Number(res.numUpdatedRows)) await this.upsertChats([u as Partial<Chat>])
    }
  }

  async deleteChats(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.h.db.deleteFrom('chats').where('account_id', '=', this.accountId).where('jid', '=', this.canonical(id)).execute()
    }
  }

  async touchChat(jid: string, ts: number): Promise<void> {
    const res = await this.h.db
      .updateTable('chats')
      .set({ last_ts: ts })
      .where('account_id', '=', this.accountId)
      .where('jid', '=', jid)
      .where((eb) => eb.or([eb('last_ts', 'is', null), eb('last_ts', '<', ts)]))
      .executeTakeFirst()
    if (Number(res.numUpdatedRows)) return
    const exists = await this.h.db.selectFrom('chats').select('jid').where('account_id', '=', this.accountId).where('jid', '=', jid).executeTakeFirst()
    if (!exists) {
      await upsertMany(
        this.h,
        'chats',
        [{ account_id: this.accountId, jid, name: null, is_group: isGroupJid(jid) ? 1 : 0, unread: null, last_ts: ts, archived: 0, pinned: 0, data: '{}' }],
        ['account_id', 'jid'],
        [],
      )
    }
  }

  // ---------------------------------------------------------------- contacts
  async upsertContacts(contacts: Partial<Contact>[]): Promise<void> {
    const rows: Record<string, unknown>[] = []
    const maps: { lid: string; pn: string }[] = []
    for (const c of contacts) {
      if (!c.id) continue
      const id = bareJid(c.id)
      const lid = c.lid ? bareJid(c.lid) : isLidJid(id) ? id : this.pnCache.get(id) ?? null
      const pn = c.phoneNumber ? bareJid(c.phoneNumber) : isPnJid(id) ? id : this.lidCache.get(id) ?? null
      if (lid && pn) maps.push({ lid, pn })
      const jid = pn ?? id
      rows.push({
        account_id: this.accountId,
        jid,
        pn,
        lid,
        name: c.name ?? null,
        notify: c.notify ?? null,
        verified_name: c.verifiedName ?? null,
        data: JSON.stringify({ username: c.username, status: c.status }),
      })
    }
    if (maps.length) {
      const added = await this.addLidMappings(maps)
      if (added.length) await this.mergeLidAliases(added)
    }
    // merge so a partial update does not wipe a saved name
    const dedup = new Map<string, Record<string, unknown>>()
    for (const r of rows) dedup.set(r.jid as string, { ...(dedup.get(r.jid as string) ?? {}), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) })
    const final: Record<string, unknown>[] = []
    for (const r of dedup.values()) {
      const ex = await this.h.db.selectFrom('contacts').selectAll().where('account_id', '=', this.accountId).where('jid', '=', r.jid as string).executeTakeFirst()
      final.push({ account_id: this.accountId, jid: r.jid, pn: r.pn ?? ex?.pn ?? null, lid: r.lid ?? ex?.lid ?? null, name: r.name ?? ex?.name ?? null, notify: r.notify ?? ex?.notify ?? null, verified_name: r.verified_name ?? ex?.verified_name ?? null, data: r.data ?? ex?.data ?? null })
    }
    if (final.length) await upsertMany(this.h, 'contacts', final, ['account_id', 'jid'])
  }

  // ---------------------------------------------------------------- groups
  async upsertGroups(groups: Partial<GroupMetadata>[]): Promise<void> {
    const rows = groups
      .filter((g) => g.id)
      .map((g) => ({ account_id: this.accountId, jid: g.id!, subject: g.subject ?? null, data: JSON.stringify(g), updated_at: now() }))
    const merged: Record<string, unknown>[] = []
    for (const r of rows) {
      const ex = await this.h.db.selectFrom('wa_groups').select(['subject', 'data']).where('account_id', '=', this.accountId).where('jid', '=', r.jid).executeTakeFirst()
      if (ex) {
        const prev = JSON.parse(ex.data || '{}')
        const next = { ...prev, ...JSON.parse(r.data) }
        merged.push({ ...r, subject: r.subject ?? ex.subject, data: JSON.stringify(next) })
      } else merged.push(r)
    }
    if (merged.length) await upsertMany(this.h, 'wa_groups', merged, ['account_id', 'jid'])
    const chats = rows.filter((r) => r.subject).map((r) => ({ id: r.jid, name: r.subject as string }))
    if (chats.length) {
      for (const c of chats) {
        const res = await this.h.db.updateTable('chats').set({ name: c.name }).where('account_id', '=', this.accountId).where('jid', '=', c.id).executeTakeFirst()
        if (!Number(res.numUpdatedRows)) await this.upsertChats([c])
      }
    }
  }

  async groupMeta(jid: string): Promise<GroupMetadata | undefined> {
    const r = await this.h.db.selectFrom('wa_groups').select('data').where('account_id', '=', this.accountId).where('jid', '=', jid).executeTakeFirst()
    return r?.data ? (JSON.parse(r.data) as GroupMetadata) : undefined
  }

  // ---------------------------------------------------------------- names
  async nameOf(jid: string): Promise<string | null> {
    if (!jid || jid === 'me') return null
    const j = bareJid(jid)
    if (isGroupJid(j)) {
      const g = await this.h.db.selectFrom('chats').select('name').where('account_id', '=', this.accountId).where('jid', '=', j).executeTakeFirst()
      return g?.name ?? null
    }
    const aliases = this.aliases(j)
    const c = await this.h.db
      .selectFrom('contacts')
      .select(['name', 'notify', 'verified_name'])
      .where('account_id', '=', this.accountId)
      .where((eb) => eb.or([eb('jid', 'in', aliases), eb('lid', 'in', aliases), eb('pn', 'in', aliases)]))
      .executeTakeFirst()
    if (c) return c.name || c.notify || c.verified_name || null
    const ch = await this.h.db.selectFrom('chats').select('name').where('account_id', '=', this.accountId).where('jid', 'in', aliases).executeTakeFirst()
    return ch?.name ?? null
  }

  phoneOf(jid: string): string | null {
    const j = bareJid(jid)
    if (isPnJid(j)) return '+' + userOf(j)
    if (isLidJid(j)) {
      const pn = this.lidCache.get(j)
      return pn ? '+' + userOf(pn) : null
    }
    return null
  }
}

export const isMediaType = (t: string) => MEDIA_TYPES.has(t)
