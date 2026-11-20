import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type WAVersion,
  type GroupMetadata,
  type WAMessage,
} from '@whiskeysockets/baileys'
import NodeCache from 'node-cache'
import QRCode from 'qrcode'
import { now, type DbHandle } from '../db/index.js'
import type { EventBus } from '../events.js'
import { logger } from '../log.js'
import type { Settings } from '../settings.js'
import { AppError, bareJid, digits, sleep, userOf } from '../util.js'
import { useDbAuthState, wipeAuth } from './auth.js'
import { WaStore } from './store.js'

export type AccountRow = {
  id: string
  label: string | null
  phone: string | null
  browser: string | null
  enabled: number
  sync_history: number
  is_default: number
  me_jid: string | null
  me_lid: string | null
  me_name: string | null
  status: string | null
  created_at: number
  updated_at: number
}

export type AccountState =
  | 'stopped'
  | 'not_linked'
  | 'connecting'
  | 'qr'
  | 'pairing_code'
  | 'open'
  | 'reconnecting'
  | 'logged_out'
  | 'replaced'
  | 'pairing_expired'
  | 'error'

export type Ctx = { h: DbHandle; bus: EventBus; settings: Settings }

// ------------------------------------------------------------------ WA version
let cachedVersion: { v: WAVersion; at: number } | null = null
async function waVersion(force = false): Promise<WAVersion | undefined> {
  if (!force && cachedVersion && now() - cachedVersion.at < 6 * 3600_000) return cachedVersion.v
  try {
    const r = await fetchLatestBaileysVersion()
    if (r?.version) {
      cachedVersion = { v: r.version, at: now() }
      return r.version
    }
  } catch (e) {
    logger.warn({ err: String(e) }, 'could not fetch latest WA web version; using Baileys default')
  }
  return cachedVersion?.v
}

const baileysLogger = logger.child({ mod: 'baileys' })
baileysLogger.level = process.env.WA_BAILEYS_LOG ?? 'warn'

// ------------------------------------------------------------------ rate limit
class SendLimiter {
  private tokens: number
  private last = Date.now()
  private chains = new Map<string, Promise<unknown>>()
  constructor(private settings: Settings) {
    this.tokens = settings.get().ratePerMin
  }
  private refill() {
    const rate = this.settings.get().ratePerMin
    const t = Date.now()
    this.tokens = Math.min(rate, this.tokens + ((t - this.last) / 60_000) * rate)
    this.last = t
  }
  private async take() {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const rate = this.settings.get().ratePerMin
      await sleep(Math.ceil(((1 - this.tokens) * 60_000) / rate))
    }
  }
  pending(): number {
    return this.chains.size
  }
  run<T>(chat: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(chat) ?? Promise.resolve()
    const p = prev
      .catch(() => undefined)
      .then(async () => {
        await this.take()
        try {
          return await fn()
        } finally {
          await sleep(this.settings.get().perChatGapMs)
        }
      })
    const tail = p.catch(() => undefined)
    this.chains.set(chat, tail)
    void tail.then(() => {
      if (this.chains.get(chat) === tail) this.chains.delete(chat)
    })
    return p
  }
}

// ------------------------------------------------------------------ account
export class WaAccount {
  sock?: WASocket
  state: AccountState = 'stopped'
  since = now()
  qr?: { value: string; at: number; png: string }
  pairingCode?: { code: string; at: number; phone: string }
  lastDisconnect?: { code: number | undefined; reason: string; at: number }
  history = { progress: 0, messages: 0, syncType: null as number | null, at: 0 }
  readonly store: WaStore
  readonly limiter: SendLimiter
  readonly groupCache = new NodeCache({ stdTTL: 600, useClones: false })
  private msgRetryCache = new NodeCache({ stdTTL: 600, useClones: false })
  private numberCache = new Map<string, { exists: boolean; jid: string; at: number }>()
  private stopping = false
  private retry = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pairing?: { method: 'qr' | 'code'; phone?: string; requested?: boolean }
  private generation = 0

  constructor(
    public row: AccountRow,
    private ctx: Ctx,
  ) {
    this.store = new WaStore(ctx.h, row.id)
    this.limiter = new SendLimiter(ctx.settings)
  }

  get id(): string {
    return this.row.id
  }

  status() {
    return {
      id: this.row.id,
      label: this.row.label,
      state: this.state,
      since: new Date(this.since).toISOString(),
      enabled: !!this.row.enabled,
      default: !!this.row.is_default,
      syncHistory: !!this.row.sync_history,
      me: this.row.me_jid
        ? { jid: bareJid(this.row.me_jid), phone: '+' + userOf(this.row.me_jid), lid: bareJid(this.row.me_lid), name: this.row.me_name }
        : null,
      phone: this.row.phone,
      lastDisconnect: this.lastDisconnect ? { ...this.lastDisconnect, at: new Date(this.lastDisconnect.at).toISOString() } : null,
      pairing: this.state === 'qr' ? { method: 'qr', at: new Date(this.qr?.at ?? 0).toISOString() } : this.state === 'pairing_code' ? { method: 'code', code: this.pairingCode?.code, phone: this.pairingCode?.phone } : null,
      history: this.history.at ? { ...this.history, at: new Date(this.history.at).toISOString() } : null,
      queue: { pendingChats: this.limiter.pending() },
    }
  }

  private setState(s: AccountState, extra: Record<string, unknown> = {}) {
    this.state = s
    this.since = now()
    void this.ctx.h.db.updateTable('accounts').set({ status: s, updated_at: now() }).where('id', '=', this.row.id).execute().catch(() => undefined)
    this.ctx.bus.publish('connection.update', this.row.id, { state: s, ...extra })
  }

  async isPaired(): Promise<boolean> {
    const r = await this.ctx.h.db.selectFrom('auth_creds').select('data').where('account_id', '=', this.row.id).executeTakeFirst()
    if (!r?.data) return false
    try {
      return !!JSON.parse(r.data)?.me?.id
    } catch {
      return false
    }
  }

  /** Start the socket. With `pairing`, (re)link the device by QR or by phone-number pairing code. */
  async start(pairing?: { method: 'qr' | 'code'; phone?: string; fresh?: boolean }): Promise<void> {
    await this.stop(false)
    this.stopping = false
    this.retry = 0
    await this.store.loadLidMap()
    const seeded = await this.store.seedLidMapFromAuth()
    const merged = await this.store.mergeLidAliases()
    if (seeded || merged.chats || merged.messages || merged.contacts) logger.info({ account: this.id, seeded, merged }, 'LID map seeded / LID chats merged')
    if (pairing) {
      if (pairing.method === 'code') {
        const ph = digits(pairing.phone ?? this.row.phone ?? '')
        if (ph.length < 7) throw new AppError('INVALID_PHONE', 'A phone number in international format is required for pairing-code login', 400)
        pairing.phone = ph
        await this.ctx.h.db.updateTable('accounts').set({ phone: ph }).where('id', '=', this.row.id).execute()
        this.row.phone = ph
      }
      if (pairing.fresh || !(await this.isPaired())) await wipeAuth(this.ctx.h, this.row.id)
      this.pairing = { method: pairing.method, phone: pairing.phone }
    } else if (!(await this.isPaired())) {
      this.setState('not_linked')
      return
    }
    await this.connect()
  }

  private browser(): [string, string, string] {
    try {
      const b = JSON.parse(this.row.browser || 'null')
      if (Array.isArray(b) && b.length === 3) return b as [string, string, string]
    } catch {
      /* default */
    }
    return [`WhatsOps ${this.row.id}`.slice(0, 40), 'Desktop', '1.0']
  }

  private async connect(forceVersion = false): Promise<void> {
    const gen = ++this.generation
    this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'connecting')
    const { state, saveCreds } = await useDbAuthState(this.ctx.h, this.row.id)
    const version = await waVersion(forceVersion)
    const sync = !!this.row.sync_history
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      logger: baileysLogger,
      browser: this.browser(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      markOnlineOnConnect: false,
      syncFullHistory: sync,
      // full sync only when wanted; never block the bootstrap types (they carry LID mappings)
      ...(sync ? { shouldSyncHistoryMessage: () => true } : {}),
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: this.msgRetryCache as never,
      getMessage: async (key) => this.store.getMessageContent(key),
      cachedGroupMetadata: async (jid) => this.groupCache.get<GroupMetadata>(jid),
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000,
    })
    this.sock = sock

    sock.ev.process(async (events) => {
      if (gen !== this.generation) return
      try {
        if (events['creds.update']) await saveCreds()

        if (events['connection.update']) await this.onConnection(events['connection.update'], sock, gen)

        if (events['lid-mapping.update']) {
          const added = await this.store.addLidMappings([events['lid-mapping.update']])
          if (added.length) await this.store.mergeLidAliases(added)
        }

        if (events['messaging-history.set']) {
          const { chats, contacts, messages, lidPnMappings, progress, syncType } = events['messaging-history.set']
          if (lidPnMappings?.length) {
            const added = await this.store.addLidMappings(lidPnMappings)
            if (added.length) await this.store.mergeLidAliases(added)
          }
          if (contacts?.length) await this.store.upsertContacts(contacts)
          if (chats?.length) await this.store.upsertChats(chats)
          const rows = messages?.length ? await this.store.upsertMessages(messages) : []
          this.history = { progress: progress ?? this.history.progress, messages: this.history.messages + rows.length, syncType: syncType ?? null, at: now() }
          this.ctx.bus.publish('history.sync', this.row.id, { chats: chats?.length ?? 0, contacts: contacts?.length ?? 0, messages: rows.length, progress, syncType })
        }

        if (events['messages.upsert']) {
          const { messages, type } = events['messages.upsert']
          const rows = await this.store.upsertMessages(messages)
          for (const r of rows) {
            const summary = await this.summarize(r)
            this.ctx.bus.publish(r.from_me ? 'message.sent' : 'message.received', this.row.id, { ...summary, upsertType: type })
          }
        }

        if (events['messages.update']) {
          await this.store.applyMessageUpdates(events['messages.update'])
          for (const u of events['messages.update']) {
            this.ctx.bus.publish('message.update', this.row.id, { id: u.key.id, chat: this.store.canonical(u.key.remoteJid, (u.key as { remoteJidAlt?: string }).remoteJidAlt), status: u.update.status ?? null, edited: !!u.update.message })
          }
        }

        if (events['messages.delete']) {
          const d = events['messages.delete']
          if ('keys' in d) await this.store.deleteMessages(d.keys)
        }

        if (events['chats.upsert']) await this.store.upsertChats(events['chats.upsert'])
        if (events['chats.update']) {
          await this.store.updateChats(events['chats.update'])
          this.ctx.bus.publish('chat.update', this.row.id, events['chats.update'].map((c) => ({ id: c.id, unread: c.unreadCount ?? undefined })))
        }
        if (events['chats.delete']) await this.store.deleteChats(events['chats.delete'])
        if (events['contacts.upsert']) await this.store.upsertContacts(events['contacts.upsert'])
        if (events['contacts.update']) await this.store.upsertContacts(events['contacts.update'])

        if (events['groups.upsert']) {
          for (const g of events['groups.upsert']) this.groupCache.set(g.id, g)
          await this.store.upsertGroups(events['groups.upsert'])
        }
        if (events['groups.update']) {
          for (const g of events['groups.update']) if (g.id) this.groupCache.del(g.id)
          await this.store.upsertGroups(events['groups.update'])
        }
        if (events['group-participants.update']) {
          const { id } = events['group-participants.update']
          this.groupCache.del(id)
          void this.refreshGroup(id)
        }
      } catch (e) {
        logger.error({ account: this.row.id, err: String((e as Error)?.stack ?? e) }, 'event processing failed')
      }
    })
  }

  private async onConnection(u: Partial<import('@whiskeysockets/baileys').ConnectionState>, sock: WASocket, gen: number) {
    if (u.qr) {
      if (this.pairing?.method === 'code') {
        if (!this.pairing.requested && this.pairing.phone) {
          this.pairing.requested = true
          try {
            const code = await sock.requestPairingCode(this.pairing.phone)
            this.pairingCode = { code, at: now(), phone: this.pairing.phone }
            this.setState('pairing_code', { code })
            this.ctx.bus.publish('pairing.code', this.row.id, { code, phone: this.pairing.phone }, true)
          } catch (e) {
            logger.error({ account: this.row.id, err: String(e) }, 'pairing code request failed')
            this.lastDisconnect = { code: undefined, reason: `pairing code failed: ${String((e as Error).message ?? e)}`, at: now() }
            this.setState('error')
          }
        }
      } else if (this.pairing?.method === 'qr' || !(await this.isPaired())) {
        const png = await QRCode.toDataURL(u.qr, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
        this.qr = { value: u.qr, at: now(), png }
        if (this.state !== 'qr') this.setState('qr')
        this.ctx.bus.publish('pairing.qr', this.row.id, { qr: u.qr }, true)
      }
    }
    if (u.connection === 'open') {
      this.retry = 0
      this.pairing = undefined
      this.qr = undefined
      this.pairingCode = undefined
      const me = sock.user
      if (me?.id) {
        this.row.me_jid = me.id
        this.row.me_lid = (me as { lid?: string }).lid ?? null
        this.row.me_name = me.name ?? me.notify ?? this.row.me_name
        if (!this.row.phone) this.row.phone = userOf(me.id)
        await this.ctx.h.db
          .updateTable('accounts')
          .set({ me_jid: this.row.me_jid, me_lid: this.row.me_lid, me_name: this.row.me_name, phone: this.row.phone, updated_at: now() })
          .where('id', '=', this.row.id)
          .execute()
        if (this.row.me_lid) await this.store.addLidMappings([{ lid: this.row.me_lid, pn: me.id }])
      }
      this.setState('open', { me: { jid: bareJid(me?.id), name: me?.name } })
      setTimeout(() => {
        if (gen === this.generation && this.state === 'open') void this.refreshGroups()
      }, 8000).unref()
    }
    if (u.connection === 'close') {
      if (gen !== this.generation) return
      const err = u.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined
      const code = err?.output?.statusCode
      const reason = err?.message ?? 'closed'
      this.lastDisconnect = { code, reason, at: now() }
      this.sock = undefined
      if (this.stopping) {
        this.setState('stopped')
        return
      }
      const paired = await this.isPaired()
      logger.info({ account: this.row.id, code, reason, paired }, 'connection closed')
      if (code === DisconnectReason.loggedOut) {
        await wipeAuth(this.ctx.h, this.row.id)
        this.setState('logged_out', { code, reason })
        return
      }
      if (code === DisconnectReason.connectionReplaced) {
        this.setState('replaced', { code, reason })
        return
      }
      if (code === DisconnectReason.multideviceMismatch) {
        this.setState('error', { code, reason })
        return
      }
      if (code === DisconnectReason.restartRequired) {
        void this.connect()
        return
      }
      if (!paired && this.pairing) {
        // QR / pairing window expired
        if (code === DisconnectReason.timedOut || code === 401) {
          this.pairing = undefined
          this.setState('pairing_expired', { code, reason })
          return
        }
        if (this.retry >= 3) {
          this.pairing = undefined
          this.setState('error', { code, reason: `pairing failed: ${reason}` })
          return
        }
      }
      if (!paired && !this.pairing) {
        this.setState('not_linked')
        return
      }
      this.scheduleReconnect(code === 405)
    }
  }

  private scheduleReconnect(forceVersion: boolean) {
    const delay = Math.min(60_000, 1000 * 2 ** this.retry) + Math.floor(Math.random() * 1000)
    this.retry++
    this.setState('reconnecting', { inMs: delay })
    clearTimeout(this.reconnectTimer)
    const t = setTimeout(() => {
      if (!this.stopping) void this.connect(forceVersion).catch((e) => logger.error({ err: String(e) }, 'reconnect failed'))
    }, delay)
    t.unref?.()
    this.reconnectTimer = t
  }

  async stop(publish = true): Promise<void> {
    this.stopping = true
    clearTimeout(this.reconnectTimer)
    this.generation++
    const s = this.sock
    this.sock = undefined
    if (s) {
      try {
        s.end(undefined)
      } catch {
        /* ignore */
      }
    }
    if (publish) this.setState('stopped')
  }

  async logout(): Promise<void> {
    const s = this.sock
    if (s && this.state === 'open') {
      try {
        await s.logout()
      } catch (e) {
        logger.warn({ err: String(e) }, 'logout call failed')
      }
    }
    await this.stop(false)
    await wipeAuth(this.ctx.h, this.row.id)
    this.setState('logged_out', { reason: 'logged out by admin' })
  }

  requireOpen(): WASocket {
    if (!this.sock || this.state !== 'open') {
      throw new AppError('NOT_CONNECTED', 'WhatsApp account "{0}" is not connected (state: {1})', 409, [this.row.id, this.state])
    }
    return this.sock
  }

  async refreshGroups(): Promise<number> {
    const sock = this.requireOpen()
    const all = await sock.groupFetchAllParticipating()
    const list = Object.values(all)
    for (const g of list) this.groupCache.set(g.id, g)
    await this.store.upsertGroups(list)
    return list.length
  }

  async refreshGroup(jid: string): Promise<GroupMetadata | undefined> {
    if (!this.sock || this.state !== 'open') return this.store.groupMeta(jid)
    const g = await this.sock.groupMetadata(jid)
    this.groupCache.set(jid, g)
    await this.store.upsertGroups([g])
    return g
  }

  /** Resolve and validate a recipient; checks onWhatsApp for phone numbers. */
  async resolveRecipient(jid: string): Promise<string> {
    if (!jid.endsWith('@s.whatsapp.net')) return jid
    const sock = this.requireOpen()
    const n = userOf(jid)
    const cached = this.numberCache.get(n)
    if (cached && now() - cached.at < 24 * 3600_000) {
      if (!cached.exists) throw new AppError('NOT_ON_WHATSAPP', '+{0} is not on WhatsApp', 404, [n])
      return cached.jid
    }
    const res = await sock.onWhatsApp(n)
    const r = res?.[0]
    const exists = !!r?.exists
    this.numberCache.set(n, { exists, jid: r?.jid ? bareJid(r.jid) : jid, at: now() })
    if (!exists) throw new AppError('NOT_ON_WHATSAPP', '+{0} is not on WhatsApp', 404, [n])
    return r?.jid ? bareJid(r.jid) : jid
  }

  async checkNumber(phone: string): Promise<{ phone: string; exists: boolean; jid: string | null; lid: string | null }> {
    const sock = this.requireOpen()
    const n = digits(phone)
    const res = await sock.onWhatsApp(n)
    const r = res?.[0]
    let lid: string | null = null
    if (r?.exists) {
      try {
        lid = (await sock.signalRepository.lidMapping.getLIDForPN(`${n}@s.whatsapp.net`)) ?? null
      } catch {
        lid = null
      }
    }
    this.numberCache.set(n, { exists: !!r?.exists, jid: r?.jid ? bareJid(r.jid) : `${n}@s.whatsapp.net`, at: now() })
    return { phone: '+' + n, exists: !!r?.exists, jid: r?.jid ? bareJid(r.jid) : null, lid: lid ? bareJid(lid) : null }
  }

  async summarize(r: { chat_jid: string; id: string; from_me: number; sender: string | null; ts: number; type: string; text: string | null; status: number | null }) {
    const isGroup = r.chat_jid.endsWith('@g.us')
    return {
      id: r.id,
      chat: r.chat_jid,
      chatName: await this.store.nameOf(r.chat_jid),
      chatPhone: isGroup ? null : this.store.phoneOf(r.chat_jid),
      fromMe: !!r.from_me,
      sender: r.from_me ? 'me' : r.sender,
      senderName: r.from_me ? this.row.me_name ?? 'me' : r.sender ? await this.store.nameOf(r.sender) : null,
      senderPhone: r.from_me ? '+' + userOf(this.row.me_jid) : r.sender ? this.store.phoneOf(r.sender) : null,
      timestamp: new Date(r.ts * 1000).toISOString(),
      ts: r.ts,
      type: r.type,
      text: r.text,
      hasMedia: ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'documentWithCaptionMessage', 'ptvMessage'].includes(r.type),
      status: r.status,
    }
  }

  async sendRaw(jid: string, content: Parameters<WASocket['sendMessage']>[1], opts?: Parameters<WASocket['sendMessage']>[2]): Promise<WAMessage> {
    return this.limiter.run(jid, async () => {
      const sock = this.requireOpen()
      const msg = await sock.sendMessage(jid, content, opts)
      if (!msg) throw new AppError('SEND_FAILED', 'WhatsApp did not return a message', 400)
      await this.store.upsertMessages([msg])
      return msg
    })
  }
}
