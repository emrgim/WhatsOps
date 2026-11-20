import crypto from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { now, getSetting, setSetting, upsert, type DbHandle } from '../db/index.js'
import { AppError } from '../util.js'

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
export const randomToken = (prefix: string, bytes = 32) => prefix + crypto.randomBytes(bytes).toString('base64url')

export function ctEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16)
  const N = 16384
  const key = crypto.scryptSync(pw, salt, 32, { N, r: 8, p: 1 })
  return `scrypt$${N}$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = String(stored).split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const key = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), 32, { N: Number(n), r: Number(r), p: Number(p) })
  return ctEqual(key.toString('base64url'), hash)
}

export const SESSION_COOKIE = 'wa_sess'
const SESSION_TTL = 30 * 86400_000

/** Admin (config page) authentication: session cookie, magic link, WhatsApp one-time code, password. */
export class AdminAuth {
  private failures = new Map<string, { n: number; until: number }>()

  constructor(private h: DbHandle) {}

  // ----------------------------------------------------- sessions
  /** userId null = the owner (full access); otherwise a WhatsOps user with their own permissions. */
  async createSession(label: string, userId: string | null = null): Promise<string> {
    const token = randomToken('was_')
    await this.h.db.insertInto('admin_sessions').values({ id_hash: sha256(token), label: label.slice(0, 250), created_at: now(), expires_at: now() + SESSION_TTL, last_seen: now(), user_id: userId }).execute()
    return token
  }

  async session(token: string | undefined): Promise<{ userId: string | null } | null> {
    if (!token || !token.startsWith('was_')) return null
    const r = await this.h.db.selectFrom('admin_sessions').selectAll().where('id_hash', '=', sha256(token)).executeTakeFirst()
    if (!r || r.expires_at < now()) return null
    if (now() - (r.last_seen ?? 0) > 3600_000) {
      await this.h.db.updateTable('admin_sessions').set({ last_seen: now(), expires_at: now() + SESSION_TTL }).where('id_hash', '=', r.id_hash).execute()
    }
    return { userId: (r as { user_id?: string | null }).user_id ?? null }
  }

  /** True only for the owner's sessions (users never pass: OAuth consent, admin pages). */
  async checkSession(token: string | undefined): Promise<boolean> {
    const s = await this.session(token)
    return !!s && !s.userId
  }

  async deleteSession(token: string | undefined): Promise<void> {
    if (!token) return
    await this.h.db.deleteFrom('admin_sessions').where('id_hash', '=', sha256(token)).execute()
  }

  async listSessions() {
    return this.h.db.selectFrom('admin_sessions').select(['id_hash', 'label', 'created_at', 'last_seen', 'expires_at', 'user_id']).where('expires_at', '>', now()).orderBy('last_seen', 'desc').execute()
  }

  async revokeSession(idHash: string) {
    await this.h.db.deleteFrom('admin_sessions').where('id_hash', '=', idHash).execute()
  }

  setCookie(reply: FastifyReply, token: string, secure: boolean) {
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL / 1000 })
  }

  // ----------------------------------------------------- brute force guard
  private guard(key: string) {
    const f = this.failures.get(key)
    if (f && f.until > now()) throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed attempts, try again in a few minutes', 429)
  }
  private fail(key: string) {
    const f = this.failures.get(key) ?? { n: 0, until: 0 }
    f.n++
    if (f.n >= 5) {
      f.until = now() + 10 * 60_000
      f.n = 0
    }
    this.failures.set(key, f)
  }

  // ----------------------------------------------------- magic link / OTP
  /** `otp`/`link` sign in the owner; `otpu`/`linku` sign in one user (the value is bound to the user id). */
  async createLoginToken(kind: 'link' | 'otp' | 'linku' | 'otpu', ttlMs: number, userId?: string): Promise<string> {
    const value = kind === 'otp' || kind === 'otpu' ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0') : randomToken('wal_', 24)
    const bound = userId ? `${userId}:${value}` : value
    await this.h.db.insertInto('login_tokens').values({ hash: sha256(`${kind}:${bound}`), kind, created_at: now(), expires_at: now() + ttlMs, used: 0 }).execute()
    await this.h.db.deleteFrom('login_tokens').where('expires_at', '<', now() - 86400_000).execute()
    return value
  }

  async consumeLoginToken(kind: 'link' | 'otp' | 'linku' | 'otpu', value: string, ip: string): Promise<boolean> {
    const gk = `${kind}:${ip}`
    this.guard(gk)
    this.guard(`${kind}:*`)
    const hash = sha256(`${kind}:${String(value).trim()}`)
    const r = await this.h.db.selectFrom('login_tokens').selectAll().where('hash', '=', hash).executeTakeFirst()
    if (!r || r.used || r.expires_at < now()) {
      this.fail(gk)
      if (kind === 'otp' || kind === 'otpu') this.fail(`${kind}:*`)
      return false
    }
    const res = await this.h.db.updateTable('login_tokens').set({ used: 1 }).where('hash', '=', hash).where('used', '=', 0).executeTakeFirst()
    return Number(res.numUpdatedRows) === 1
  }

  // ----------------------------------------------------- password
  async passwordSet(): Promise<boolean> {
    return !!(await getSetting(this.h, 'admin_password'))
  }

  async setPassword(pw: string): Promise<void> {
    if (!pw || pw.length < 10) throw new AppError('WEAK_PASSWORD', 'Password must be at least 10 characters', 400)
    await setSetting(this.h, 'admin_password', hashPassword(pw))
  }

  async clearPassword(): Promise<void> {
    await this.h.db.deleteFrom('settings').where('k', '=', 'admin_password').execute()
  }

  async checkPassword(pw: string, ip: string): Promise<boolean> {
    this.guard(`pw:${ip}`)
    const stored = await getSetting(this.h, 'admin_password')
    if (!stored || !verifyPassword(pw, stored)) {
      this.fail(`pw:${ip}`)
      return false
    }
    return true
  }
}

// ----------------------------------------------------- API keys
export const SCOPES = ['read', 'send', 'admin'] as const
export type Scope = (typeof SCOPES)[number]

export type ApiKeyRow = { id: string; name: string; prefix: string; hash: string; scopes: string; accounts: string; created_at: number; last_used: number | null; revoked: number }

export class ApiKeys {
  constructor(private h: DbHandle) {}

  async create(name: string, scopes: string[], accounts: string[] | '*'): Promise<{ id: string; key: string }> {
    const sc = scopes.filter((s) => (SCOPES as readonly string[]).includes(s))
    if (!sc.length) throw new AppError('INVALID_SCOPES', 'At least one scope (read, send, admin) is required', 400)
    const key = randomToken('wam_')
    const id = crypto.randomUUID()
    await this.h.db
      .insertInto('api_keys')
      .values({ id, name: name.slice(0, 200) || 'key', prefix: key.slice(0, 12), hash: sha256(key), scopes: sc.join(' '), accounts: accounts === '*' ? '*' : accounts.join(','), created_at: now(), last_used: null, revoked: 0 })
      .execute()
    return { id, key }
  }

  async verify(key: string): Promise<ApiKeyRow | null> {
    if (!key?.startsWith('wam_')) return null
    const r = (await this.h.db.selectFrom('api_keys').selectAll().where('hash', '=', sha256(key)).executeTakeFirst()) as ApiKeyRow | undefined
    if (!r || r.revoked) return null
    if (!r.last_used || now() - r.last_used > 60_000) await this.h.db.updateTable('api_keys').set({ last_used: now() }).where('id', '=', r.id).execute()
    return r
  }

  async list() {
    return this.h.db.selectFrom('api_keys').select(['id', 'name', 'prefix', 'scopes', 'accounts', 'created_at', 'last_used', 'revoked']).orderBy('created_at', 'desc').execute()
  }

  async revoke(id: string) {
    await this.h.db.updateTable('api_keys').set({ revoked: 1 }).where('id', '=', id).execute()
  }

  async remove(id: string) {
    await this.h.db.deleteFrom('api_keys').where('id', '=', id).execute()
  }
}

// ----------------------------------------------------- principal
export type Principal = {
  kind: 'admin' | 'apikey' | 'oauth' | 'user'
  id: string
  label: string
  /** a signed-in user has no scope at all: only what their permissions grant (see users.ts) */
  scopes: Set<string>
  accounts: '*' | string[]
  user?: import('../users.js').User
}

export function requestIp(req: FastifyRequest): string {
  return String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim()
}

export function publicOrigin(req: FastifyRequest, configured: string): string {
  if (configured) return configured.replace(/\/+$/, '')
  const proto = String(req.headers['x-forwarded-proto'] ?? (req.protocol || 'http')).split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim()
  return `${proto}://${host}`
}

export { upsert }
