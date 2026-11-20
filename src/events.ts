import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { now, upsert, type DbHandle } from './db/index.js'
import { logger } from './log.js'

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

type Hook = { id: string; url: string; events: string; account_id: string | null; secret: string; active: number }

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

  async reload(): Promise<void> {
    this.hooks = (await this.h.db.selectFrom('webhooks').selectAll().execute()) as Hook[]
  }

  private async deliver(hk: Hook, ev: WaEvent, attempt: number, deliveryId: string): Promise<void> {
    const body = JSON.stringify({ id: ev.id, type: ev.type, account: ev.account, at: new Date(ev.at).toISOString(), data: ev.data })
    const ts = String(Math.floor(Date.now() / 1000))
    let status = 0
    let error: string | null = null
    try {
      const res = await fetch(hk.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'mcp-mrg-whatsops-webhook/1',
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
    const willRetry = !ok && attempt < RETRY_DELAYS.length
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
  }

  async prune(): Promise<void> {
    const cutoff = now() - 7 * 86400_000
    await this.h.db.deleteFrom('webhook_deliveries').where('created_at', '<', cutoff).execute()
  }
}
