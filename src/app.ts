import type { FastifyRequest } from 'fastify'
import type { DbHandle } from './db/index.js'
import type { EventBus, WebhookDispatcher } from './events.js'
import type { Settings } from './settings.js'
import type { AccountManager } from './wa/manager.js'
import type { WaService } from './wa/service.js'
import type { WaAccount } from './wa/account.js'
import { AdminAuth, ApiKeys, SESSION_COOKIE, type Principal } from './security/auth.js'
import type { OAuthServer } from './security/oauth.js'
import type { Reports } from './reports.js'
import type { Updater } from './update.js'
import type { License } from './license.js'
import { AppError } from './util.js'

export type App = {
  h: DbHandle
  settings: Settings
  bus: EventBus
  accounts: AccountManager
  svc: WaService
  admin: AdminAuth
  apiKeys: ApiKeys
  oauth: OAuthServer
  webhooks: WebhookDispatcher
  reports: Reports
  updater: Updater
  license: License
  restart: (reason: string) => void
}

export function bearerFrom(req: FastifyRequest): string | undefined {
  const auth = String(req.headers.authorization ?? '')
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  const x = req.headers['x-api-key']
  if (typeof x === 'string' && x) return x.trim()
  const q = req.query as Record<string, unknown> | undefined
  const t = q?.token ?? q?.key ?? q?.api_key
  return typeof t === 'string' && t ? t.trim() : undefined
}

/** Resolve the caller: admin session cookie, API key (wam_), or OAuth access token (wao_). */
export async function authenticate(app: App, req: FastifyRequest, allowCookie = true): Promise<Principal | null> {
  const tok = bearerFrom(req)
  if (tok) {
    if (tok.startsWith('wam_')) {
      const k = await app.apiKeys.verify(tok)
      if (!k) return null
      return { kind: 'apikey', id: k.id, label: k.name, scopes: new Set(k.scopes.split(' ')), accounts: k.accounts === '*' || !k.accounts ? '*' : k.accounts.split(',') }
    }
    if (tok.startsWith('wao_')) {
      const t = await app.oauth.verifyAccess(tok)
      if (!t) return null
      return { kind: 'oauth', id: t.family, label: t.clientId, scopes: new Set(t.scopes), accounts: '*' }
    }
    return null
  }
  if (allowCookie) {
    const c = req.cookies?.[SESSION_COOKIE]
    if (c && (await app.admin.checkSession(c))) {
      // CSRF: cookie-authenticated writes must come from our own origin
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = String(req.headers.origin ?? req.headers.referer ?? '')
        const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
        try {
          if (!origin || new URL(origin).host !== host) return null
        } catch {
          return null
        }
      }
      return { kind: 'admin', id: 'admin', label: 'admin', scopes: new Set(['read', 'send', 'admin']), accounts: '*' }
    }
  }
  return null
}

export function requireScope(p: Principal, scope: 'read' | 'send' | 'admin'): void {
  if (p.scopes.has('admin') || p.scopes.has(scope)) return
  throw new AppError('FORBIDDEN', 'This credential lacks the "{0}" scope', 403, [scope])
}

export function accountFor(app: App, p: Principal, id?: string | null): WaAccount {
  const acc = app.accounts.get(id ?? undefined)
  if (p.accounts !== '*' && !p.accounts.includes(acc.id)) throw new AppError('FORBIDDEN', 'This credential cannot use account "{0}"', 403, [acc.id])
  return acc
}

export function visibleAccounts(app: App, p: Principal): WaAccount[] {
  return app.accounts.list().filter((a) => p.accounts === '*' || p.accounts.includes(a.id))
}
