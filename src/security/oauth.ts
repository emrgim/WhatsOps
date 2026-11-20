import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { now, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import type { Settings } from '../settings.js'
import { AdminAuth, SESSION_COOKIE, ctEqual, publicOrigin, randomToken, requestIp, sha256 } from './auth.js'
import { authorizePage, incompleteAuthorizePage } from '../ui/pages.js'
import { reqLang, tr, type Lang } from '../i18n.js'

export const OAUTH_SCOPES = ['read', 'send']
const CODE_TTL = 10 * 60_000
const CIMD_TTL = 5 * 60_000

/** Well-known public clients that may use a fixed client_id (e.g. grok.com custom connector form). */
const STATIC_CLIENTS: Record<string, string> = {
  grok: 'Grok',
  'grok-bot': 'Grok Bot',
  cursor: 'Cursor',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  openai: 'OpenAI',
  hermes: 'Hermes',
  gemini: 'Gemini',
  mcp: 'MCP client',
}

type Client = { clientId: string; name: string; redirectUris: string[] | '*'; authMethod: string; secretHash: string; cimd?: boolean; static?: boolean }

const BAD_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'about:', 'blob:', 'vbscript:', 'ftp:', 'ws:', 'wss:'])

export function redirectUriAllowed(uri: string): boolean {
  if (!uri || uri.length > 2048) return false
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (BAD_SCHEMES.has(u.protocol)) return false
  if (u.protocol === 'https:') return !!u.hostname
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
  // private-use URI schemes for native apps (cursor://, vscode://, claude://, com.example.app:/…)
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol)
}

function loopbackEquivalent(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    const lb = (h: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h)
    return x.protocol === 'http:' && y.protocol === 'http:' && lb(x.hostname) && lb(y.hostname) && x.pathname === y.pathname
  } catch {
    return false
  }
}

function redirectMatches(uri: string, c: Client): boolean {
  if (!redirectUriAllowed(uri)) return false
  if (c.redirectUris === '*') return true
  return c.redirectUris.some((r) => r === uri || loopbackEquivalent(r, uri)) // RFC 8252 §7.3: any loopback port
}

const b64url = (b: Buffer) => b.toString('base64url')
const challengeOf = (verifier: string) => b64url(crypto.createHash('sha256').update(verifier).digest())
const validVerifier = (v: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(v)
const validChallenge = (v: string) => /^[A-Za-z0-9\-_]{43,128}$/.test(v)

function canonicalResource(v: string | undefined | null): string {
  if (!v) return ''
  try {
    const u = new URL(String(v).trim())
    if (!['http:', 'https:'].includes(u.protocol) || u.hash || u.search) return ''
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

async function hostIsPublic(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  const isPrivate = (ip: string) => {
    if (net.isIPv4(ip)) {
      const [a, b] = ip.split('.').map(Number)
      return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    }
    const l = ip.toLowerCase()
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l === '::'
  }
  if (net.isIP(h)) return !isPrivate(h)
  try {
    const addrs = await dns.lookup(h, { all: true })
    return addrs.length > 0 && addrs.every((a) => !isPrivate(a.address))
  } catch {
    return false
  }
}

export class OAuthServer {
  private cimdCache = new Map<string, { at: number; client: Client | null }>()
  private regHits = new Map<string, { n: number; at: number }>()

  constructor(
    private h: DbHandle,
    private settings: Settings,
    private admin: AdminAuth,
  ) {}

  origin(req: FastifyRequest): string {
    return publicOrigin(req, this.settings.get().publicUrl)
  }

  asMetadata(req: FastifyRequest) {
    const o = this.origin(req)
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: OAUTH_SCOPES,
      subject_types_supported: ['public'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      service_documentation: `${o}/docs`,
    }
  }

  prMetadata(req: FastifyRequest, path: string) {
    const o = this.origin(req)
    return {
      resource: path ? `${o}${path}` : o,
      authorization_servers: [o],
      bearer_methods_supported: ['header'],
      scopes_supported: OAUTH_SCOPES,
      resource_name: 'WhatsOps',
      resource_documentation: `${o}/docs`,
      logo_uri: `${o}/favicon-192.png`,
    }
  }

  wwwAuthenticate(req: FastifyRequest, path: string, error?: string): string {
    const o = this.origin(req)
    const prm = path && path !== '/' ? `${o}/.well-known/oauth-protected-resource${path}` : `${o}/.well-known/oauth-protected-resource`
    const parts = [`Bearer realm="whatsops"`, `resource_metadata="${prm}"`, `scope="${OAUTH_SCOPES.join(' ')}"`]
    if (error) parts.push(`error="${error}"`)
    return parts.join(', ')
  }

  private resourceOk(req: FastifyRequest, resource?: string): boolean {
    if (!resource) return true
    const o = this.origin(req)
    const c = canonicalResource(resource)
    return [canonicalResource(o), canonicalResource(o + '/mcp'), canonicalResource(o + '/v1')].includes(c)
  }

  // --------------------------------------------------------- clients
  async resolveClient(clientId: string): Promise<Client | null> {
    if (!clientId) return null
    if (STATIC_CLIENTS[clientId]) return { clientId, name: STATIC_CLIENTS[clientId], redirectUris: '*', authMethod: 'none', secretHash: '', static: true }
    const r = await this.h.db.selectFrom('oauth_clients').selectAll().where('client_id', '=', clientId).executeTakeFirst()
    if (r) return { clientId, name: r.name, redirectUris: JSON.parse(r.redirect_uris || '[]'), authMethod: r.auth_method || 'none', secretHash: r.secret_hash || '' }
    if (/^https:\/\/[^/]+\/.+/.test(clientId)) return this.loadCimd(clientId)
    return null
  }

  private async loadCimd(url: string): Promise<Client | null> {
    const c = this.cimdCache.get(url)
    if (c && now() - c.at < CIMD_TTL) return c.client
    let client: Client | null = null
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' || u.hash || u.username || !(await hostIsPublic(u.hostname))) throw new Error('not allowed')
      const res = await fetch(u, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (text.length > 65536) throw new Error('too large')
      const meta = JSON.parse(text)
      if (meta.client_id !== url) throw new Error('client_id mismatch')
      const uris = (Array.isArray(meta.redirect_uris) ? meta.redirect_uris : []).map(String).filter(redirectUriAllowed)
      if (!uris.length) throw new Error('no redirect uris')
      client = { clientId: url, name: String(meta.client_name || u.hostname).slice(0, 120), redirectUris: uris, authMethod: 'none', secretHash: '', cimd: true }
    } catch (e) {
      logger.info({ host: url.split('/')[2], err: String(e) }, 'CIMD rejected')
    }
    this.cimdCache.set(url, { at: now(), client })
    return client
  }

  private async authenticateClient(req: FastifyRequest, body: Record<string, string>): Promise<Client | null> {
    let id = body.client_id
    let secret = body.client_secret
    const auth = String(req.headers.authorization ?? '')
    if (auth.startsWith('Basic ')) {
      try {
        const dec = Buffer.from(auth.slice(6), 'base64').toString()
        const i = dec.indexOf(':')
        id = decodeURIComponent(dec.slice(0, i))
        secret = decodeURIComponent(dec.slice(i + 1))
      } catch {
        return null
      }
    }
    const c = await this.resolveClient(id ?? '')
    if (!c) return null
    if (c.authMethod === 'none') return c
    if (!secret || !c.secretHash || !ctEqual(sha256(secret), c.secretHash)) return null
    return c
  }

  // --------------------------------------------------------- tokens
  private async issuePair(clientId: string, scopes: string[], resource: string, family?: string) {
    const s = this.settings.get()
    const fam = family ?? crypto.randomUUID()
    const access = randomToken('wao_')
    const refresh = randomToken('wor_')
    const t = now()
    await this.h.db
      .insertInto('oauth_tokens')
      .values([
        { token_hash: sha256(access), kind: 'access', client_id: clientId, scopes: scopes.join(' '), resource, family: fam, created_at: t, expires_at: t + s.oauthAccessTtl * 1000, last_used: null },
        { token_hash: sha256(refresh), kind: 'refresh', client_id: clientId, scopes: scopes.join(' '), resource, family: fam, created_at: t, expires_at: t + s.oauthRefreshDays * 86400_000, last_used: null },
      ])
      .execute()
    return { access_token: access, token_type: 'Bearer', expires_in: s.oauthAccessTtl, refresh_token: refresh, scope: scopes.join(' ') }
  }

  async verifyAccess(token: string): Promise<{ clientId: string; scopes: string[]; family: string } | null> {
    if (!token?.startsWith('wao_')) return null
    const r = await this.h.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', sha256(token)).where('kind', '=', 'access').executeTakeFirst()
    if (!r || r.expires_at < now()) return null
    if (!r.last_used || now() - r.last_used > 60_000) await this.h.db.updateTable('oauth_tokens').set({ last_used: now() }).where('token_hash', '=', r.token_hash).execute()
    return { clientId: r.client_id, scopes: String(r.scopes || '').split(' ').filter(Boolean), family: r.family }
  }

  async listGrants() {
    const rows = await this.h.db.selectFrom('oauth_tokens').selectAll().where('kind', '=', 'refresh').where('expires_at', '>', now()).orderBy('created_at', 'desc').execute()
    const out = []
    for (const r of rows) {
      const c = await this.resolveClient(r.client_id)
      const lastAccess = await this.h.db.selectFrom('oauth_tokens').select((eb) => eb.fn.max('last_used').as('m')).where('family', '=', r.family).executeTakeFirst()
      out.push({ family: r.family, clientId: r.client_id, clientName: c?.name ?? r.client_id, scopes: r.scopes, createdAt: r.created_at, lastUsed: Number(lastAccess?.m) || null, expiresAt: r.expires_at })
    }
    return out
  }

  async revokeFamily(family: string) {
    await this.h.db.deleteFrom('oauth_tokens').where('family', '=', family).execute()
  }

  async prune() {
    await this.h.db.deleteFrom('oauth_tokens').where('expires_at', '<', now()).execute()
    await this.h.db.deleteFrom('oauth_codes').where('expires_at', '<', now()).execute()
  }

  // --------------------------------------------------------- routes
  register(app: FastifyInstance): void {
    const err = (reply: FastifyReply, status: number, error: string, description: string) =>
      reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description })

    const cors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version').header('access-control-allow-methods', 'GET, POST, OPTIONS')

    const asMeta = async (req: FastifyRequest, reply: FastifyReply) => cors(reply).send(this.asMetadata(req))
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/*', '/.well-known/openid-configuration', '/.well-known/openid-configuration/*', '/mcp/.well-known/oauth-authorization-server', '/mcp/.well-known/openid-configuration']) {
      app.get(p, asMeta)
    }
    app.get('/.well-known/oauth-protected-resource', async (req, reply) => cors(reply).send(this.prMetadata(req, '')))
    app.get('/.well-known/oauth-protected-resource/*', async (req, reply) => {
      const rest = '/' + String((req.params as Record<string, string>)['*'] ?? '').replace(/^\/+/, '')
      return cors(reply).send(this.prMetadata(req, rest === '/' ? '' : rest))
    })
    app.get('/mcp/.well-known/oauth-protected-resource', async (req, reply) => cors(reply).send(this.prMetadata(req, '/mcp')))

    // ---- dynamic client registration (RFC 7591)
    const registerHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      cors(reply)
      const ip = requestIp(req)
      const hit = this.regHits.get(ip) ?? { n: 0, at: now() }
      if (now() - hit.at > 3600_000) {
        hit.n = 0
        hit.at = now()
      }
      hit.n++
      this.regHits.set(ip, hit)
      if (hit.n > 30) return err(reply, 429, 'too_many_requests', 'Too many registrations')
      const body = (req.body ?? {}) as Record<string, unknown>
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
      if (!uris.length || uris.length > 20) return err(reply, 400, 'invalid_redirect_uri', 'redirect_uris is required')
      for (const u of uris) if (!redirectUriAllowed(u)) return err(reply, 400, 'invalid_redirect_uri', `redirect_uri not allowed: ${u}`)
      const method = String(body.token_endpoint_auth_method ?? 'none')
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return err(reply, 400, 'invalid_client_metadata', 'unsupported token_endpoint_auth_method')
      const grants = Array.isArray(body.grant_types) ? body.grant_types.map(String) : ['authorization_code', 'refresh_token']
      const clientId = crypto.randomUUID()
      const secret = method === 'none' ? null : randomToken('wcs_')
      const name = String(body.client_name ?? 'MCP client').slice(0, 120)
      await this.h.db
        .insertInto('oauth_clients')
        .values({ client_id: clientId, secret_hash: secret ? sha256(secret) : '', name, redirect_uris: JSON.stringify(uris), auth_method: method, grant_types: grants.join(' '), created_at: now() })
        .execute()
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          client_id: clientId,
          client_id_issued_at: Math.floor(now() / 1000),
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
          client_name: name,
          redirect_uris: uris,
          grant_types: grants,
          response_types: ['code'],
          token_endpoint_auth_method: method,
          scope: OAUTH_SCOPES.join(' '),
        })
    }

    // ---- authorize
    const authorizeGet = async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as Record<string, string>
      reply.header('cache-control', 'no-store').type('text/html; charset=utf-8')
      const lang = reqLang(req)
      if (!q.client_id && !q.redirect_uri && !q.code_challenge) return reply.code(400).send(incompleteAuthorizePage(lang, this.origin(req)))
      const v = await this.validateAuthorize(req, q, lang)
      if ('error' in v) {
        if (v.redirect) return reply.redirect(this.withParams(v.redirect, { error: v.error, error_description: v.description, ...(q.state ? { state: q.state } : {}), iss: this.origin(req) }))
        return reply.code(400).send(incompleteAuthorizePage(lang, this.origin(req), v.description))
      }
      const loggedIn = await this.admin.checkSession(req.cookies?.[SESSION_COOKIE])
      return reply.send(
        authorizePage(lang, {
          loggedIn,
          clientName: v.client.name,
          redirectHost: new URL(q.redirect_uri).host || q.redirect_uri.split(':')[0],
          scopes: v.scopes,
          action: req.url,
          params: q,
          otpEnabled: this.settings.get().otpEnabled,
          passwordSet: await this.admin.passwordSet(),
        }),
      )
    }

    const authorizePost = async (req: FastifyRequest, reply: FastifyReply) => {
      const q = { ...(req.query as Record<string, string>), ...((req.body ?? {}) as Record<string, string>) }
      reply.header('cache-control', 'no-store')
      const lang = reqLang(req)
      if (!(await this.admin.checkSession(req.cookies?.[SESSION_COOKIE]))) return err(reply, 401, 'access_denied', tr(lang, 'Sign in to the WhatsOps config first'))
      const origin = String(req.headers.origin ?? '')
      if (origin && origin !== 'null' && new URL(origin).host !== String(req.headers['x-forwarded-host'] ?? req.headers.host)) return err(reply, 403, 'access_denied', 'cross-site request')
      const v = await this.validateAuthorize(req, q, lang)
      if ('error' in v) {
        if (v.redirect) return reply.redirect(this.withParams(v.redirect, { error: v.error, error_description: v.description, ...(q.state ? { state: q.state } : {}) }), 303)
        return err(reply, 400, v.error, v.description)
      }
      if (q.decision !== 'approve') {
        return reply.redirect(this.withParams(q.redirect_uri, { error: 'access_denied', error_description: tr(lang, 'The owner denied access'), ...(q.state ? { state: q.state } : {}), iss: this.origin(req) }), 303)
      }
      const code = randomToken('woc_', 24)
      await this.h.db
        .insertInto('oauth_codes')
        .values({
          code_hash: sha256(code),
          client_id: v.client.clientId,
          challenge: q.code_challenge,
          redirect_uri: q.redirect_uri,
          scopes: v.scopes.join(' '),
          resource: canonicalResource(q.resource) || canonicalResource(this.origin(req) + '/mcp'),
          expires_at: now() + CODE_TTL,
        })
        .execute()
      logger.info({ client: v.client.name }, 'oauth code issued')
      return reply.redirect(this.withParams(q.redirect_uri, { code, ...(q.state ? { state: q.state } : {}), iss: this.origin(req) }), 303)
    }

    // ---- token
    const token = async (req: FastifyRequest, reply: FastifyReply) => {
      cors(reply).header('cache-control', 'no-store').header('pragma', 'no-cache')
      const body = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, v == null ? '' : String(v)]))
      const client = await this.authenticateClient(req, body)
      if (!client) return err(reply, 401, 'invalid_client', 'Unknown client or bad credentials')
      if (!this.resourceOk(req, body.resource)) return err(reply, 400, 'invalid_target', 'resource does not match this server')
      if (body.grant_type === 'authorization_code') {
        if (!body.code || !body.code_verifier) return err(reply, 400, 'invalid_request', 'code and code_verifier are required')
        if (!validVerifier(body.code_verifier)) return err(reply, 400, 'invalid_grant', 'PKCE verification failed')
        const hash = sha256(body.code)
        const row = await this.h.db.selectFrom('oauth_codes').selectAll().where('code_hash', '=', hash).executeTakeFirst()
        await this.h.db.deleteFrom('oauth_codes').where('code_hash', '=', hash).execute()
        if (!row || row.expires_at < now() || row.client_id !== client.clientId) return err(reply, 400, 'invalid_grant', 'Authorization code not found or expired')
        if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) return err(reply, 400, 'invalid_grant', 'redirect_uri mismatch')
        if (!ctEqual(challengeOf(body.code_verifier), row.challenge)) return err(reply, 400, 'invalid_grant', 'PKCE verification failed')
        const pair = await this.issuePair(client.clientId, String(row.scopes).split(' ').filter(Boolean), row.resource)
        logger.info({ client: client.name }, 'oauth tokens issued')
        return reply.send(pair)
      }
      if (body.grant_type === 'refresh_token') {
        if (!body.refresh_token) return err(reply, 400, 'invalid_request', 'refresh_token is required')
        const hash = sha256(body.refresh_token)
        const row = await this.h.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', hash).where('kind', '=', 'refresh').executeTakeFirst()
        if (!row || row.expires_at < now() || row.client_id !== client.clientId) return err(reply, 400, 'invalid_grant', 'Refresh token not found or expired')
        let scopes = String(row.scopes).split(' ').filter(Boolean)
        if (body.scope) {
          const narrowed = body.scope.split(' ').filter((s) => scopes.includes(s))
          if (narrowed.length) scopes = narrowed
        }
        // rotate: drop the whole family's old tokens, issue a new pair in the same family
        await this.h.db.deleteFrom('oauth_tokens').where('family', '=', row.family).execute()
        return reply.send(await this.issuePair(client.clientId, scopes, row.resource, row.family))
      }
      return err(reply, 400, 'unsupported_grant_type', `Unsupported grant_type ${body.grant_type ?? ''}`)
    }

    const revoke = async (req: FastifyRequest, reply: FastifyReply) => {
      cors(reply)
      const body = (req.body ?? {}) as Record<string, string>
      const client = await this.authenticateClient(req, body)
      if (!client) return err(reply, 401, 'invalid_client', 'Unknown client')
      const t = String(body.token ?? '')
      if (t) {
        const row = await this.h.db.selectFrom('oauth_tokens').select(['family', 'client_id']).where('token_hash', '=', sha256(t)).executeTakeFirst()
        if (row && row.client_id === client.clientId) await this.revokeFamily(row.family)
      }
      return reply.send({})
    }

    for (const base of ['/oauth', '', '/mcp']) {
      app.post(`${base}/register`, registerHandler)
      app.get(`${base}/authorize`, authorizeGet)
      app.post(`${base}/authorize`, authorizePost)
      app.post(`${base}/token`, token)
      app.post(`${base}/revoke`, revoke)
      for (const p of ['register', 'token', 'revoke']) app.options(`${base}/${p}`, async (_req, reply) => cors(reply).code(204).send())
    }
  }

  private withParams(uri: string, params: Record<string, string>): string {
    const u = new URL(uri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u.toString()
  }

  private async validateAuthorize(
    req: FastifyRequest,
    q: Record<string, string>,
    lang: Lang = 'en',
  ): Promise<{ client: Client; scopes: string[] } | { error: string; description: string; redirect?: string }> {
    const client = await this.resolveClient(q.client_id ?? '')
    if (!client) return { error: 'invalid_client', description: tr(lang, 'Unknown client_id "{0}". Register the client (dynamic registration) or use a known id such as "grok".', [q.client_id ?? '']) }
    if (!q.redirect_uri || !redirectMatches(q.redirect_uri, client)) return { error: 'invalid_request', description: tr(lang, 'redirect_uri missing or not registered for this client') }
    const redirect = q.redirect_uri
    if (q.response_type !== 'code') return { error: 'unsupported_response_type', description: 'response_type must be code', redirect }
    if ((q.code_challenge_method ?? 'S256') !== 'S256' || !validChallenge(q.code_challenge ?? '')) return { error: 'invalid_request', description: 'PKCE S256 code_challenge is required', redirect }
    if (!this.resourceOk(req, q.resource)) return { error: 'invalid_target', description: 'resource does not match this server', redirect }
    const requested = String(q.scope ?? '').split(/[\s+]+/).filter(Boolean)
    let scopes = requested.filter((s) => OAUTH_SCOPES.includes(s))
    if (!scopes.length) scopes = [...OAUTH_SCOPES] // e.g. grok asks for "mcp:tools"
    return { client, scopes }
  }
}
