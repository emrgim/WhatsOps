import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { now, upsert, type DbHandle } from './db/index.js'
import { logger } from './log.js'
import { AppError } from './util.js'

export type WaEvent = {
  id: string
  type: string
  account: string
  at: number
  data: unknown
  /** events only shown to admins (QR / pairing codes) */
  adminOnly?: boolean
}

export class EventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(200)
  }
  publish(type: string, account: string, data: unknown, adminOnly = false): void {
    const ev: WaEvent = { id: crypto.randomUUID(), type, account, at: now(), data, adminOnly }
    this.emit('event', ev)
  }
}

export const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'message.update', 'connection.update', 'history.sync', 'chat.update', 'profile.update'] as const

const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000]

type Hook = { id: string; url: string; events: string; account_id: string | null; secret: string; active: number; headers?: string | null }

// headers WhatsOps sets itself: a webhook cannot replace them
const OWN_HEADERS = new Set(['content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'x-wa-event', 'x-wa-account', 'x-wa-delivery', 'x-wa-timestamp', 'x-wa-signature'])
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/

/**
 * Extra request headers of a webhook, written the way receivers show them:
 * a key alone (`crsr_…` → `Authorization: Bearer crsr_…`), `Bearer <key>`, or header lines `Name: value`
 * (e.g. the whole `Authorization: Bearer <key>` line Cursor / Grok Bot automations copy). An object works too.
 */
export function parseHookHeaders(input: string | Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (n: string, v: string) => {
    const name = n.trim()
    const value = v.trim()
    if (!HEADER_NAME.test(name)) throw new AppError('BAD_HEADER', 'Not a valid header name: {0}', 400, [name.slice(0, 40)])
    if (OWN_HEADERS.has(name.toLowerCase())) throw new AppError('BAD_HEADER', 'WhatsOps sets the header {0} itself', 400, [name])
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new AppError('BAD_HEADER', 'The value of the header {0} is empty or not valid', 400, [name])
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k]
    out[name] = value
  }
  if (input == null) return out
  let src: string | Record<string, string> = input
  if (typeof src === 'string' && src.trim().startsWith('{')) {
    try {
      src = JSON.parse(src) as Record<string, string>
    } catch {
      throw new AppError('BAD_HEADER', 'Paste the key, or the header as "Name: value" (one per line)', 400)
    }
  }
  if (typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) add(k, String(v))
    if (Object.keys(out).length > 10) throw new AppError('BAD_HEADER', 'At most 10 extra headers', 400)
    return out
  }
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.+)$/)
    const scheme = line.match(/^(bearer|basic|token)\s+(\S+)$/i)
    if (scheme) add('Authorization', `${scheme[1][0].toUpperCase()}${scheme[1].slice(1).toLowerCase()} ${scheme[2]}`)
    else if (h) add(h[1], h[2])
    else if (/^\S+$/.test(line)) add('Authorization', `Bearer ${line}`)
    else throw new AppError('BAD_HEADER', 'Paste the key, or the header as "Name: value" (one per line)', 400)
  }
  if (Object.keys(out).length > 10) throw new AppError('BAD_HEADER', 'At most 10 extra headers', 400)
  return out
}

/** Header values are secrets: shown as `Bearer crsr_95d8…`. */
export function maskHookHeaders(stored: string | null | undefined): Record<string, string> {
  let h: Record<string, string> = {}
  try {
    h = stored ? (JSON.parse(stored) as Record<string, string>) : {}
  } catch {
    /* nothing */
  }
  const mask = (v: string) => {
    const m = v.match(/^(\S+)\s+(\S.*)$/)
    const [pre, tok] = m ? [`${m[1]} `, m[2]] : ['', v]
    return pre + (tok.length > 12 ? `${tok.slice(0, 8)}…` : '…')
  }
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, mask(String(v))]))
}

/** One line in plain words: agents (Cursor / Grok Bot automations read `context`) see at once what happened. */
export function describeEvent(ev: Pick<WaEvent, 'type' | 'account' | 'data'>): string {
  const d = (ev.data ?? {}) as { chatName?: string | null; chatPhone?: string | null; senderName?: string | null; senderPhone?: string | null; text?: string | null; type?: string; hasMedia?: boolean; chat?: string; state?: string }
  const on = `+${String(ev.account).replace(/^\+/, '')}`
  if (ev.type === 'message.received' || ev.type === 'message.sent') {
    const who = [d.senderName, d.senderPhone].filter(Boolean).join(' ') || 'unknown'
    const inGroup = d.chat?.endsWith('@g.us') ? ` in the group "${d.chatName ?? d.chat}"` : ''
    const to = ev.type === 'message.sent' ? ` to ${[d.chatName, d.chatPhone].filter(Boolean).join(' ') || d.chat}` : ''
    const body = d.text ? `: ${d.text.length > 1500 ? `${d.text.slice(0, 1500)}…` : d.text}` : d.hasMedia ? ` (${d.type ?? 'media'} without text)` : ''
    return ev.type === 'message.received' ? `WhatsApp message received on ${on} from ${who}${inGroup}${body}` : `WhatsApp message sent from ${on}${to}${inGroup}${body}`
  }
  if (ev.type === 'webhook.test') return `Test event from WhatsOps (${on}): the webhook works.`
  if (ev.type === 'connection.update') return `WhatsApp number ${on}: connection ${d.state ?? 'changed'}`
  return `WhatsOps event ${ev.type} on ${on}`
}

export function signPayload(secret: string, ts: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

/** Delivers bus events to registered webhooks (HMAC-SHA256 signed, retried with backoff). */
export class WebhookDispatcher {
  private hooks: Hook[] = []

  constructor(
    private h: DbHandle,
    private bus: EventBus,
  ) {}

  async start(): Promise<void> {
    await this.reload()
    this.bus.on('event', (ev: WaEvent) => {
      if (ev.adminOnly) return
      for (const hk of this.hooks) {
        if (!hk.active) continue
        if (hk.account_id && hk.account_id !== '*' && hk.account_id !== ev.account) continue
        const evs = (hk.events || '*').split(',').map((s) => s.trim())
        if (!evs.includes('*') && !evs.includes(ev.type)) continue
        void this.deliver(hk, ev, 0, crypto.randomUUID())
      }
    })
  }

  /** Send a test event to this webhook only (whatever its events), once, and say how it went. */
  async deliverTest(id: string, account: string): Promise<{ ok: boolean; status: number; error: string | null }> {
    await this.reload()
    const hk = this.hooks.find((h) => h.id === id)
    if (!hk) throw new AppError('NOT_FOUND', 'webhook not found', 404)
    const ev: WaEvent = { id: crypto.randomUUID(), type: 'webhook.test', account: hk.account_id && hk.account_id !== '*' ? hk.account_id : account, at: now(), data: { test: true } }
    return this.deliver(hk, ev, 0, crypto.randomUUID(), false)
  }

  async reload(): Promise<void> {
    this.hooks = (await this.h.db.selectFrom('webhooks').selectAll().execute()) as Hook[]
  }

  private async deliver(hk: Hook, ev: WaEvent, attempt: number, deliveryId: string, retry = true): Promise<{ ok: boolean; status: number; error: string | null }> {
    const body = JSON.stringify({ id: ev.id, type: ev.type, account: ev.account, at: new Date(ev.at).toISOString(), context: describeEvent(ev), data: ev.data })
    const ts = String(Math.floor(Date.now() / 1000))
    let status = 0
    let error: string | null = null
    let extra: Record<string, string> = {}
    try {
      extra = hk.headers ? (JSON.parse(hk.headers) as Record<string, string>) : {}
    } catch {
      /* stored by us: always JSON */
    }
    try {
      const res = await fetch(hk.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'mcp-mrg-whatsops-webhook/1',
          ...extra,
          'x-wa-event': ev.type,
          'x-wa-account': ev.account,
          'x-wa-delivery': deliveryId,
          'x-wa-timestamp': ts,
          'x-wa-signature': signPayload(hk.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (e) {
      error = String((e as Error).message ?? e).slice(0, 300)
    }
    const ok = !error
    const willRetry = retry && !ok && attempt < RETRY_DELAYS.length
    try {
      await upsert(
        this.h,
        'webhook_deliveries',
        {
          id: deliveryId,
          webhook_id: hk.id,
          event: ev.type,
          state: ok ? 'delivered' : willRetry ? 'retrying' : 'failed',
          attempts: attempt + 1,
          last_status: status,
          last_error: error,
          created_at: ev.at,
          updated_at: now(),
        },
        ['id'],
      )
    } catch (e) {
      logger.warn({ err: String(e) }, 'webhook log failed')
    }
    if (willRetry) {
      const t = setTimeout(() => void this.deliver(hk, ev, attempt + 1, deliveryId), RETRY_DELAYS[attempt])
      t.unref()
    }
    return { ok, status, error }
  }

  async prune(): Promise<void> {
    const cutoff = now() - 7 * 86400_000
    await this.h.db.deleteFrom('webhook_deliveries').where('created_at', '<', cutoff).execute()
  }
}
