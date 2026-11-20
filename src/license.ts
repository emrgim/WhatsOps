/**
 * Licenses through Polar (polar.sh) — built in, NOT enabled: WhatsOps is free for now.
 *
 * Turned on only when a Polar organization is set (WA_POLAR_ORG_ID, or POLAR_ORG_ID below in a
 * release). Then Settings → License appears: the user pastes the key bought on Polar, the server
 * activates it on Polar under this installation code (WO-XXXX-XXXX), checks it again once a day and
 * keeps working offline for a grace period. Nothing is gated yet: `isLicensed()` is there for the
 * features that will need it.
 *
 * Polar customer-portal endpoints need no API key (the license key is the credential):
 *   POST /v1/customer-portal/license-keys/activate   { key, organization_id, label }
 *   POST /v1/customer-portal/license-keys/validate   { key, organization_id, activation_id }
 *   POST /v1/customer-portal/license-keys/deactivate { key, organization_id, activation_id }
 */
import { VERSION } from './config.js'
import { getSetting, setSetting, type DbHandle } from './db/index.js'
import { logger } from './log.js'
import { AppError } from './util.js'

/** Polar organization id of WhatsOps. Empty = licenses off (the app is free). */
const POLAR_ORG_ID = ''
const ORG = process.env.WA_POLAR_ORG_ID || POLAR_ORG_ID
const API = (process.env.WA_POLAR_API || (process.env.WA_POLAR_SANDBOX === '1' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh')).replace(/\/+$/, '')
const CHECK_EVERY = 24 * 3600_000
const GRACE = 14 * 24 * 3600_000

type Stored = { key: string; activationId: string | null; status: string; expiresAt: string | null; customer: string | null; checkedAt: number; okAt: number }

const mask = (k: string) => (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••')

export class License {
  private cur: Stored | null = null

  constructor(
    private h: DbHandle,
    private installCode: () => string,
  ) {}

  get enabled(): boolean {
    return !!ORG
  }

  async start(): Promise<void> {
    if (!this.enabled) return
    try {
      this.cur = JSON.parse((await getSetting(this.h, 'license')) || 'null') as Stored | null
    } catch {
      this.cur = null
    }
    const tick = () => {
      if (this.cur && Date.now() - this.cur.checkedAt > CHECK_EVERY) void this.validate().catch(() => undefined)
    }
    setTimeout(tick, 60_000).unref()
    setInterval(tick, 3600_000).unref()
  }

  /** True when licenses are off (free app) or a valid license is active (with offline grace). */
  isLicensed(): boolean {
    if (!this.enabled) return true
    return !!this.cur && this.cur.status === 'granted' && Date.now() - this.cur.okAt < GRACE && (!this.cur.expiresAt || Date.parse(this.cur.expiresAt) > Date.now())
  }

  status() {
    if (!this.enabled) return { enabled: false, plan: 'free' as const }
    const c = this.cur
    return {
      enabled: true,
      plan: this.isLicensed() ? ('licensed' as const) : ('unlicensed' as const),
      key: c ? mask(c.key) : null,
      status: c?.status ?? null,
      expiresAt: c?.expiresAt ?? null,
      customer: c?.customer ?? null,
      checkedAt: c?.checkedAt ?? null,
      installation: this.installCode(),
    }
  }

  private async polar<T>(p: string, body: Record<string, unknown>): Promise<{ status: number; json: T }> {
    let r: Response
    try {
      r = await fetch(`${API}/v1/customer-portal/license-keys/${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `WhatsOps/${VERSION}` },
        body: JSON.stringify({ organization_id: ORG, ...body }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new AppError('LICENSE_UNREACHABLE', 'The license service cannot be reached right now, try again later', 503)
    }
    return { status: r.status, json: (r.status === 204 ? {} : await r.json().catch(() => ({}))) as T }
  }

  private async save(): Promise<void> {
    await setSetting(this.h, 'license', this.cur ? JSON.stringify(this.cur) : '')
  }

  async activate(key: string): Promise<ReturnType<License['status']>> {
    if (!this.enabled) throw new AppError('LICENSE_OFF', 'Licenses are not enabled: WhatsOps is free', 409)
    key = key.trim()
    if (key.length < 8) throw new AppError('LICENSE_INVALID', 'This license key is not valid', 400)
    type Act = { id?: string; license_key?: { status?: string; expires_at?: string | null; customer?: { email?: string } }; detail?: unknown }
    const a = await this.polar<Act>('activate', { key, label: this.installCode(), meta: { app: 'WhatsOps', version: VERSION } })
    let activationId: string | null = null
    if (a.status === 200 && a.json.id) activationId = a.json.id
    else if (a.status === 403 || a.status === 422) {
      // keys without device activations: validating is enough
      activationId = null
    } else if (a.status === 404) throw new AppError('LICENSE_INVALID', 'This license key is not valid', 400)
    this.cur = { key, activationId, status: 'unknown', expiresAt: null, customer: null, checkedAt: 0, okAt: 0 }
    await this.validate()
    if (this.cur?.status !== 'granted') {
      this.cur = null
      await this.save()
      throw new AppError('LICENSE_INVALID', 'This license key is not valid', 400)
    }
    logger.info({ mod: 'license', key: mask(key) }, 'license activated')
    return this.status()
  }

  async validate(): Promise<void> {
    if (!this.enabled || !this.cur) return
    type Val = { status?: string; expires_at?: string | null; customer?: { email?: string } }
    const v = await this.polar<Val>('validate', { key: this.cur.key, ...(this.cur.activationId ? { activation_id: this.cur.activationId } : {}) })
    this.cur.checkedAt = Date.now()
    if (v.status === 200) {
      this.cur.status = v.json.status ?? 'unknown'
      this.cur.expiresAt = v.json.expires_at ?? null
      this.cur.customer = v.json.customer?.email ?? this.cur.customer
      if (this.cur.status === 'granted') this.cur.okAt = Date.now()
    } else if (v.status === 404) this.cur.status = 'invalid'
    await this.save()
  }

  async deactivate(): Promise<ReturnType<License['status']>> {
    if (!this.enabled) throw new AppError('LICENSE_OFF', 'Licenses are not enabled: WhatsOps is free', 409)
    if (this.cur?.activationId) await this.polar('deactivate', { key: this.cur.key, activation_id: this.cur.activationId }).catch(() => undefined)
    this.cur = null
    await this.save()
    logger.info({ mod: 'license' }, 'license removed from this installation')
    return this.status()
  }
}
