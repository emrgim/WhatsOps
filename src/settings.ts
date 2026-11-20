import crypto from 'node:crypto'
import { getSetting, setSetting, type DbHandle } from './db/index.js'

export type AppSettings = {
  /** max messages per minute per account (token bucket) */
  ratePerMin: number
  /** minimum gap between two messages to the same chat, ms */
  perChatGapMs: number
  /** '*' = anyone; otherwise comma-separated phone numbers / JIDs that MCP/API may send to */
  sendAllowlist: string
  /** allow sending to numbers that never wrote to us (cold contacts) */
  allowColdContacts: boolean
  /** login code over WhatsApp (sent to the account's own "Message yourself" chat) */
  otpEnabled: boolean
  /** OAuth access-token lifetime (seconds) */
  oauthAccessTtl: number
  /** OAuth refresh-token lifetime (days) */
  oauthRefreshDays: number
  /** public base URL (overrides X-Forwarded-Host detection), e.g. https://whatsops.mrg.im */
  publicUrl: string
  /** max media size for send/download (MB) */
  maxMediaMb: number
  /** server language: 'auto' (OS locale) | 'en' | 'it' — MCP tool texts, errors, login code */
  language: string
  /** web pages: 'light' | 'dark' | 'system' (desktop theme if the computer has one, else the OS light/dark setting) */
  appearance: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  ratePerMin: 20,
  perChatGapMs: 1500,
  sendAllowlist: '*',
  allowColdContacts: true,
  otpEnabled: true,
  oauthAccessTtl: 24 * 3600,
  oauthRefreshDays: 90,
  publicUrl: '',
  maxMediaMb: 64,
  language: 'auto',
  appearance: 'system',
}

export class Settings {
  private cur: AppSettings = { ...DEFAULT_SETTINGS }
  secret = ''

  constructor(private h: DbHandle) {}

  async load(): Promise<void> {
    const raw = await getSetting(this.h, 'app')
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Record<string, unknown>
        // keep only known keys (old versions stored settings that no longer exist)
        this.cur = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULT_SETTINGS)) } as AppSettings
      } catch {
        this.cur = { ...DEFAULT_SETTINGS }
      }
    }
    let s = await getSetting(this.h, 'server_secret')
    if (!s) {
      s = crypto.randomBytes(32).toString('base64url')
      await setSetting(this.h, 'server_secret', s)
    }
    this.secret = s
  }

  get(): AppSettings {
    return this.cur
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...this.cur }
    for (const [k, v] of Object.entries(patch) as [keyof AppSettings, unknown][]) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue
      const def = DEFAULT_SETTINGS[k]
      if (typeof def === 'number') {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) continue
        ;(next as Record<string, unknown>)[k] = n
      } else if (typeof def === 'boolean') {
        ;(next as Record<string, unknown>)[k] = Boolean(v)
      } else {
        ;(next as Record<string, unknown>)[k] = String(v).trim()
      }
    }
    if (next.ratePerMin < 1) next.ratePerMin = 1
    if (next.publicUrl) next.publicUrl = next.publicUrl.replace(/\/+$/, '')
    this.cur = next
    await setSetting(this.h, 'app', JSON.stringify(next))
    return next
  }
}
