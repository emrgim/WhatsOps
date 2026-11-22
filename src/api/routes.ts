import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { BUILD, VERSION, VERSION_LABEL, config, readBootstrap, writeBootstrap } from '../config.js'
import { copyAll, maskDbUrl, migrate, now, openDb, parseDbUrl, pingDb } from '../db/index.js'
import { WEBHOOK_EVENTS, maskHookHeaders, parseHookHeaders, type WaEvent } from '../events.js'
import { LOG_FILE, logger, onLog, recentLogs } from '../log.js'
import { accountFor, authenticate, requireScope, visibleAccounts, type App } from '../app.js'
import { SESSION_COOKIE, publicOrigin, randomToken, requestIp, type Principal } from '../security/auth.js'
import { DEFAULT_SETTINGS } from '../settings.js'
import { loginPage, messagePage } from '../ui/pages.js'
import { AppError, bareJid } from '../util.js'
import { importHistoryDb, importMultiFileSession } from '../wa/import.js'
import { handleMcpRequest } from '../mcp/server.js'
import { defaultLang, reqLang, setServerLanguage, tr } from '../i18n.js'
import { currentTheme, desktopTheme } from '../theme.js'
import { registerCurrentRms } from '../plugins/currentrms.js'
import { registerRentman } from '../plugins/rentman.js'
import { normPerms, phoneDigits, pluginAccess } from '../users.js'
import type { Readable } from 'node:stream'
import { listFolders, makeFolder } from '../backup.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

const acct = z.string().optional().describe('Account id or phone (default account when omitted)')

export function registerRoutes(fastify: FastifyInstance, app: App): void {
  const f = fastify.withTypeProvider<ZodTypeProvider>()

  const guard = (scope: 'read' | 'send' | 'admin') => async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(app, req)
    if (!p) {
      reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
      throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
    }
    requireScope(p, scope)
    req.principal = p
  }
  const P = (req: FastifyRequest) => req.principal as Principal
  /** Any signed-in caller (owner, key, OAuth, user); what they may do is checked by the handler. */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(app, req)
    if (!p) {
      reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
      throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
    }
    req.principal = p
  }
  const secure = (req: FastifyRequest) => publicOrigin(req, app.settings.get().publicUrl).startsWith('https://')

  // ------------------------------------------------------------------ public
  f.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true, version: VERSION, build: BUILD, connected: app.accounts.list().filter((a) => a.state === 'open').length }))

  const sendFile = (name: string, type: string, maxAge = 86400) => async (_req: FastifyRequest, reply: FastifyReply) => {
    const p = path.join(PUBLIC_DIR, name)
    if (!fs.existsSync(p)) return reply.code(404).send()
    return reply.type(type).header('cache-control', `public, max-age=${maxAge}`).send(fs.readFileSync(p))
  }
  f.get('/favicon.svg', { schema: { hide: true } }, sendFile('favicon.svg', 'image/svg+xml'))
  f.get('/favicon.ico', { schema: { hide: true } }, sendFile('favicon.ico', 'image/x-icon'))
  f.get('/favicon-32.png', { schema: { hide: true } }, sendFile('favicon-32.png', 'image/png'))
  f.get('/favicon-192.png', { schema: { hide: true } }, sendFile('favicon-192.png', 'image/png'))
  f.get('/logo.svg', { schema: { hide: true } }, sendFile('favicon.svg', 'image/svg+xml'))
  f.get('/logo-512.png', { schema: { hide: true } }, sendFile('logo-512.png', 'image/png'))
  // same image under a name that becomes the icon name in an Omarchy web app launcher
  f.get('/whatsops.png', { schema: { hide: true } }, sendFile('logo-512.png', 'image/png'))
  f.get('/icon-maskable-192.png', { schema: { hide: true } }, sendFile('icon-maskable-192.png', 'image/png'))
  f.get('/icon-maskable-512.png', { schema: { hide: true } }, sendFile('icon-maskable-512.png', 'image/png'))
  f.get('/apple-touch-icon.png', { schema: { hide: true } }, sendFile('apple-touch-icon.png', 'image/png'))
  // web app (PWA): installable from Chrome / Edge / Chromium, and as an Omarchy web app
  f.get('/manifest.webmanifest', { schema: { hide: true } }, async (req, reply) => {
    const th = currentTheme(app.settings.get().appearance)
    const color = (k: string, d: string) => th.css.match(new RegExp(`--wo-${k}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1] ?? d
    const it = reqLang(req) === 'it'
    return reply
      .type('application/manifest+json; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send({
        id: '/',
        name: 'WhatsOps',
        short_name: 'WhatsOps',
        description: it ? 'I tuoi numeri WhatsApp: MCP, API REST e plugin' : 'Your WhatsApp numbers: MCP, REST API and plugins',
        lang: it ? 'it' : 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // let the app header double as the window title bar on desktop installs,
        // so the browser's own app toolbar is not drawn as a second bar
        display_override: ['window-controls-overlay'],
        background_color: color('background', '#121212'),
        theme_color: color('bar', color('background', '#121212')),
        categories: ['business', 'productivity', 'utilities'],
        icons: [
          { src: '/favicon.svg?v=2', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/favicon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/logo-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-192.png?v=1', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-maskable-512.png?v=1', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: it ? 'Numeri' : 'Numbers', url: '/#numbers' },
          { name: it ? 'Plugin' : 'Plugins', url: '/#connect/plugins' },
          { name: it ? 'Impostazioni' : 'Settings', url: '/#settings/general' },
        ],
      })
  })
  f.get('/static/app.js', { schema: { hide: true } }, sendFile('app.js', 'application/javascript; charset=utf-8', 60))
  f.get('/static/i18n.js', { schema: { hide: true } }, sendFile('i18n.js', 'application/javascript; charset=utf-8', 60))
  f.get('/static/app.css', { schema: { hide: true } }, sendFile('app.css', 'text/css; charset=utf-8', 60))
  f.get('/static/base.css', { schema: { hide: true } }, sendFile('base.css', 'text/css; charset=utf-8', 300))
  f.get('/static/theme.js', { schema: { hide: true } }, sendFile('theme.js', 'application/javascript; charset=utf-8', 300))
  const LOGOS: Record<string, string> = { 'cursor.svg': 'image/svg+xml', 'claude.svg': 'image/svg+xml', 'chatgpt.svg': 'image/svg+xml', 'grok.svg': 'image/svg+xml', 'gemini.svg': 'image/svg+xml', 'mcp.svg': 'image/svg+xml', 'hermes.png': 'image/png', 'grokbot.png': 'image/png', 'currentrms.png': 'image/png', 'rentman.png': 'image/png' }
  f.get('/static/logos/:name', { schema: { hide: true, params: z.object({ name: z.string() }) } }, async (req, reply) => {
    const type = LOGOS[req.params.name]
    if (!type) return reply.code(404).send()
    return reply.type(type).header('cache-control', 'public, max-age=86400').send(fs.readFileSync(path.join(PUBLIC_DIR, 'logos', req.params.name)))
  })
  f.get('/static/fonts/:name', { schema: { hide: true } }, async (req, reply) => {
    const name = (req.params as { name: string }).name
    if (!/^[a-z0-9-]+\.woff2$/.test(name)) return reply.code(404).send()
    const p = path.join(PUBLIC_DIR, 'fonts', name)
    if (!fs.existsSync(p)) return reply.code(404).send()
    return reply.type('font/woff2').header('cache-control', 'public, max-age=31536000, immutable').send(fs.readFileSync(p))
  })
  // Light / Dark / System theme (public: the login page needs it too)
  f.get('/theme.css', { schema: { hide: true } }, async (req, reply) => {
    const th = currentTheme(app.settings.get().appearance)
    const etag = `"${th.hash}"`
    reply.header('etag', etag).header('cache-control', 'no-cache')
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply.type('text/css; charset=utf-8').send(th.css)
  })
  f.get('/theme.json', { schema: { hide: true } }, async (_req, reply) => {
    const th = currentTheme(app.settings.get().appearance)
    return reply.header('cache-control', 'no-store').send({ name: th.name, mode: th.mode, hash: th.hash })
  })

  f.get('/', { schema: { hide: true } }, async (req, reply) => {
    const s = await app.admin.session(req.cookies?.[SESSION_COOKIE])
    const ok = !!s && (!s.userId || !!(await app.users.get(s.userId))?.active)
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    if (!ok) return reply.send(loginPage(reqLang(req), { otpEnabled: app.settings.get().otpEnabled, passwordSet: await app.admin.passwordSet(), userLogin: (await app.users.countActive()) > 0 }))
    return reply.send(fs.readFileSync(path.join(PUBLIC_DIR, 'app.html')))
  })

  // MCP on /mcp and on / (grok.com custom connectors use the bare origin)
  for (const p of ['/mcp', '/mcp/']) {
    f.post(p, { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/mcp'))
    f.get(p, { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/mcp'))
    f.delete(p, { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/mcp'))
  }
  f.post('/', { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/'))
  f.options('/mcp', { schema: { hide: true } }, async (_req, reply) =>
    reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id').header('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS').header('access-control-expose-headers', 'WWW-Authenticate, Mcp-Session-Id').code(204).send(),
  )

  // ------------------------------------------------------------------ admin login
  f.get('/login', { schema: { hide: true, querystring: z.object({ t: z.string().optional(), u: z.string().max(64).optional() }) } }, async (req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    const user = req.query.u ? await app.users.get(req.query.u) : null
    const valid = !!req.query.t && (req.query.u ? !!user?.active && (await app.admin.consumeLoginToken('linku', `${req.query.u}:${req.query.t}`, requestIp(req))) : await app.admin.consumeLoginToken('link', req.query.t, requestIp(req)))
    if (!valid) {
      const lang = reqLang(req)
      return reply.code(403).send(messagePage(lang, tr(lang, 'Invalid link'), tr(lang, 'Login link expired or already used. Ask for a new one.')))
    }
    if (user) await app.users.touch(user.id)
    const tok = await app.admin.createSession(`${user ? user.name + ' · ' : ''}magic link · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`, user?.id ?? null)
    app.admin.setCookie(reply, tok, secure(req))
    return reply.redirect('/', 303)
  })

  f.get('/auth/me', { schema: { hide: true } }, async (req) => {
    const s = await app.admin.session(req.cookies?.[SESSION_COOKIE])
    return { loggedIn: !!s, role: s ? (s.userId ? 'user' : 'owner') : null, otpEnabled: app.settings.get().otpEnabled, passwordSet: await app.admin.passwordSet() }
  })

  const otpHits: number[] = []
  const userOtpHits = new Map<string, number[]>()
  f.post('/auth/otp/request', { schema: { hide: true, body: z.object({ account: z.string().optional(), phone: z.string().max(40).optional() }).optional() } }, async (req) => {
    // a user: the code goes to their own WhatsApp number, from the default number
    if (req.body?.phone) {
      const d = phoneDigits(req.body.phone)
      if (d.length < 8 || d.length > 15) throw new AppError('INVALID_PHONE', 'Write the full number with the country code, e.g. +39 333 123 4567', 400)
      const t = now()
      const hits = (userOtpHits.get(d) ?? []).filter((x) => t - x < 3600_000)
      if (hits.length >= 5) throw new AppError('TOO_MANY_REQUESTS', 'Too many codes requested, wait a few minutes', 429)
      const masked = `+${d.slice(0, 2)}…${d.slice(-3)}`
      const user = await app.users.byPhone(d)
      // same answer whether the number is enabled or not
      if (!user?.active) return { ok: true, sentTo: masked }
      const sender = app.accounts.list().find((a) => a.row.is_default && a.state === 'open') ?? app.accounts.list().find((a) => a.state === 'open')
      if (!sender) throw new AppError('NO_CONNECTED_NUMBER', 'No connected WhatsApp number to send the code to. Use a login link.', 409)
      hits.push(t)
      userOtpHits.set(d, hits)
      const code = await app.admin.createLoginToken('otpu', 5 * 60_000, user.id)
      await sender.sendRaw(`${d}@s.whatsapp.net`, { text: tr(reqLang(req), '@otp_user', [code, user.name]) })
      logger.info({ mod: 'auth', user: user.id }, `login code sent to user ${user.name}`)
      return { ok: true, sentTo: masked }
    }
    if (!app.settings.get().otpEnabled) throw new AppError('DISABLED', 'WhatsApp login codes are disabled', 403)
    const t = now()
    while (otpHits.length && t - otpHits[0] > 10 * 60_000) otpHits.shift()
    if (otpHits.length >= 4) throw new AppError('TOO_MANY_REQUESTS', 'Too many codes requested, wait a few minutes', 429)
    const open = app.accounts.list().filter((a) => a.state === 'open' && a.row.me_jid)
    const target = (req.body?.account ? open.find((a) => a.id === req.body?.account) : undefined) ?? open.find((a) => a.row.is_default) ?? open[0]
    if (!target) throw new AppError('NO_CONNECTED_NUMBER', 'No connected WhatsApp number to send the code to. Use a login link.', 409)
    otpHits.push(t)
    const code = await app.admin.createLoginToken('otp', 5 * 60_000)
    const self = bareJid(target.row.me_jid)
    await target.sendRaw(self, { text: tr(defaultLang(), '@otp', [code]) })
    const phone = '+' + self.split('@')[0]
    return { ok: true, sentTo: `${phone.slice(0, 4)}…${phone.slice(-3)}` }
  })

  f.post('/auth/otp/verify', { schema: { hide: true, body: z.object({ code: z.string(), phone: z.string().max(40).optional() }) } }, async (req, reply) => {
    if (req.body.phone) {
      const user = await app.users.byPhone(req.body.phone)
      const code = req.body.code.replace(/\D/g, '')
      if (!user?.active || !(await app.admin.consumeLoginToken('otpu', `${user.id}:${code}`, requestIp(req)))) throw new AppError('INVALID_CODE', 'Wrong or expired code', 401)
      await app.users.touch(user.id)
      const tok = await app.admin.createSession(`${user.name} · whatsapp code · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`, user.id)
      app.admin.setCookie(reply, tok, secure(req))
      logger.info({ mod: 'auth', user: user.id }, `user ${user.name} signed in`)
      return { ok: true }
    }
    if (!(await app.admin.consumeLoginToken('otp', req.body.code.replace(/\D/g, ''), requestIp(req)))) throw new AppError('INVALID_CODE', 'Wrong or expired code', 401)
    const tok = await app.admin.createSession(`whatsapp code · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`)
    app.admin.setCookie(reply, tok, secure(req))
    return { ok: true }
  })

  f.post('/auth/password', { schema: { hide: true, body: z.object({ password: z.string() }) } }, async (req, reply) => {
    if (!(await app.admin.checkPassword(req.body.password, requestIp(req)))) throw new AppError('INVALID_PASSWORD', 'Wrong password', 401)
    const tok = await app.admin.createSession(`password · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`)
    app.admin.setCookie(reply, tok, secure(req))
    return { ok: true }
  })

  f.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    await app.admin.deleteSession(req.cookies?.[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  // ------------------------------------------------------------------ media links
  f.get('/media/:token', { schema: { hide: true, params: z.object({ token: z.string() }) } }, async (req, reply) => {
    const d = app.svc.verifyMediaToken(req.params.token)
    const acc = app.accounts.get(d.a)
    const m = await app.svc.downloadMedia(acc, d.c || undefined, d.i)
    return reply
      .type(m.mimetype)
      .header('content-disposition', `inline; filename="${m.fileName.replace(/["\\\r\n]/g, '_')}"`)
      .header('cache-control', 'private, max-age=600')
      .send(m.buf)
  })

  // ------------------------------------------------------------------ accounts
  const tags = (t: string) => ({ tags: [t], security: [{ bearer: [] }] })

  f.get('/v1/accounts', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'List WhatsApp numbers' } }, async (req) => visibleAccounts(app, P(req)).map((a) => a.status()))

  f.post(
    '/v1/accounts',
    {
      preHandler: guard('admin'),
      schema: { ...tags('Accounts'), summary: 'Add a WhatsApp number (its id becomes the phone number and its name the WhatsApp profile name once linked)', body: z.object({ label: z.string().optional(), id: z.string().optional(), phone: z.string().optional(), syncHistory: z.boolean().optional() }) },
    },
    async (req, reply) => {
      const a = await app.accounts.create(req.body)
      return reply.code(201).send(a.status())
    },
  )

  f.get('/v1/accounts/:id', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'Account status', params: z.object({ id: z.string() }) } }, async (req) => accountFor(app, P(req), req.params.id).status())

  // ---- profile of the number (name = WhatsOps name, info, photo) — edits change WhatsApp itself
  const imageFrom = async (b: { url?: string; base64?: string }): Promise<Buffer> => {
    if (b.base64) return Buffer.from(b.base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (b.url) return (await app.svc.fetchMedia(b.url)).buf
    throw new AppError('PROFILE_PHOTO', 'Send the photo as url or base64', 400)
  }
  f.get('/v1/accounts/:id/profile', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'WhatsApp profile of the number: name, info, photo', params: z.object({ id: z.string() }) } }, async (req) =>
    accountFor(app, P(req), req.params.id).profile(),
  )
  f.post('/v1/accounts/:id/profile/refresh', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'Read the profile from WhatsApp again now', params: z.object({ id: z.string() }) } }, async (req) => {
    const a = accountFor(app, P(req), req.params.id)
    await a.refreshProfile(true)
    return a.profile()
  })
  f.patch(
    '/v1/accounts/:id/profile',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Accounts'),
        summary: 'Change the WhatsApp profile name and/or info (on WhatsApp itself)',
        params: z.object({ id: z.string() }),
        body: z.object({ name: z.string().max(25).optional(), about: z.string().max(139).optional() }),
      },
    },
    async (req) => accountFor(app, P(req), req.params.id).editProfile(req.body),
  )
  f.get('/v1/accounts/:id/profile/photo', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'Profile photo (image)', params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const p = accountFor(app, P(req), req.params.id).photoData()
    if (!p) throw new AppError('NO_PHOTO', 'This number has no profile photo', 404)
    return reply.header('content-type', p.type).header('cache-control', 'private, max-age=60').send(p.data)
  })
  f.put(
    '/v1/accounts/:id/profile/photo',
    {
      preHandler: guard('send'),
      schema: { ...tags('Accounts'), summary: 'Set the WhatsApp profile photo (image url or base64)', params: z.object({ id: z.string() }), body: z.object({ url: z.string().optional(), base64: z.string().optional() }) },
    },
    async (req) => accountFor(app, P(req), req.params.id).editProfile({ photo: await imageFrom(req.body) }),
  )
  f.delete('/v1/accounts/:id/profile/photo', { preHandler: guard('send'), schema: { ...tags('Accounts'), summary: 'Remove the WhatsApp profile photo', params: z.object({ id: z.string() }) } }, async (req) =>
    accountFor(app, P(req), req.params.id).editProfile({ photo: null }),
  )

  f.get('/v1/accounts/:id/stats', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'Stored data counts', params: z.object({ id: z.string() }) } }, async (req) =>
    app.svc.stats(accountFor(app, P(req), req.params.id)),
  )

  f.patch(
    '/v1/accounts/:id',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Accounts'),
        summary: 'Update account',
        params: z.object({ id: z.string() }),
        body: z.object({ label: z.string().optional(), enabled: z.boolean().optional(), syncHistory: z.boolean().optional(), isDefault: z.boolean().optional() }),
      },
    },
    async (req) => (await app.accounts.update(req.params.id, req.body)).status(),
  )

  f.delete(
    '/v1/accounts/:id',
    { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'Remove account (and its stored data unless purge=false)', params: z.object({ id: z.string() }), querystring: z.object({ purge: z.enum(['true', 'false']).optional() }) } },
    async (req) => {
      await app.accounts.remove(req.params.id, req.query.purge !== 'false')
      return { ok: true }
    },
  )

  f.post(
    '/v1/accounts/:id/login',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Accounts'),
        summary: '(Re)link the number: QR code or pairing code by phone number',
        params: z.object({ id: z.string() }),
        body: z.object({ method: z.enum(['qr', 'code']), phone: z.string().optional(), fresh: z.boolean().optional().describe('Drop the current session first') }),
      },
    },
    async (req) => {
      const a = app.accounts.get(req.params.id)
      await a.start({ method: req.body.method, phone: req.body.phone, fresh: req.body.fresh ?? true })
      // give the socket a moment to produce a QR / pairing code
      for (let i = 0; i < 40 && !['qr', 'pairing_code', 'open', 'error', 'pairing_expired', 'logged_out'].includes(a.state); i++) await new Promise((r) => setTimeout(r, 250))
      return { ...a.status(), qr: a.state === 'qr' ? a.qr?.png : undefined }
    },
  )

  f.get('/v1/accounts/:id/qr', { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'Current pairing QR (PNG data URL) or pairing code', params: z.object({ id: z.string() }) } }, async (req) => {
    const a = app.accounts.get(req.params.id)
    return { state: a.state, qr: a.state === 'qr' ? a.qr?.png ?? null : null, qrText: a.state === 'qr' ? a.qr?.value ?? null : null, code: a.state === 'pairing_code' ? a.pairingCode?.code ?? null : null, at: a.qr?.at ?? a.pairingCode?.at ?? null }
  })

  f.post('/v1/accounts/:id/logout', { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'Log out (unlink device)', params: z.object({ id: z.string() }) } }, async (req) => {
    const a = app.accounts.get(req.params.id)
    await a.logout()
    return a.status()
  })

  f.post('/v1/accounts/:id/restart', { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'Reconnect socket', params: z.object({ id: z.string() }) } }, async (req) => {
    const a = app.accounts.get(req.params.id)
    await a.start()
    return a.status()
  })

  f.post(
    '/v1/accounts/:id/import',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Accounts'),
        summary: 'Import a Baileys multi-file session folder and/or a SQLite history file (server paths)',
        params: z.object({ id: z.string() }),
        body: z.object({ sessionDir: z.string().optional(), historyDb: z.string().optional(), start: z.boolean().optional() }),
      },
    },
    async (req) => {
      const a = app.accounts.get(req.params.id)
      const out: Record<string, unknown> = {}
      if (req.body.sessionDir) {
        await a.stop(false)
        out.session = await importMultiFileSession(app.h, a.id, req.body.sessionDir)
        const row = await app.h.db.selectFrom('accounts').selectAll().where('id', '=', a.id).executeTakeFirst()
        if (row) Object.assign(a.row, row)
      }
      if (req.body.historyDb) out.history = await importHistoryDb(app.h, a.id, req.body.historyDb)
      if (req.body.start !== false && req.body.sessionDir) await a.start()
      return { ...out, status: a.status() }
    },
  )

  // ------------------------------------------------------------------ chats & messages
  f.get(
    '/v1/chats',
    {
      preHandler: guard('read'),
      schema: {
        ...tags('Messages'),
        summary: 'List chats',
        querystring: z.object({ account: acct, limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(), unread: z.enum(['true', 'false']).optional(), q: z.string().optional(), type: z.enum(['all', 'groups', 'direct']).optional(), label: z.string().optional() }),
      },
    },
    async (req) => app.svc.listChats(accountFor(app, P(req), req.query.account), { limit: req.query.limit, offset: req.query.offset, unreadOnly: req.query.unread === 'true', query: req.query.q, type: req.query.type, label: req.query.label }),
  )

  f.get(
    '/v1/labels',
    { preHandler: guard('read'), schema: { ...tags('Messages'), summary: 'Labels of the number, with how many chats and messages carry each', querystring: z.object({ account: acct }) } },
    async (req) => app.svc.labels(accountFor(app, P(req), req.query.account)),
  )

  f.get(
    '/v1/labels/:label',
    { preHandler: guard('read'), schema: { ...tags('Messages'), summary: 'Chats and messages that carry a label (name or id)', params: z.object({ label: z.string() }), querystring: z.object({ account: acct }) } },
    async (req) => app.svc.labels(accountFor(app, P(req), req.query.account), req.params.label),
  )

  f.put(
    '/v1/chats/:chat/labels',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Messages'),
        summary: 'Put labels on a chat (or a message of it) or take them off (WhatsApp Business)',
        params: z.object({ chat: z.string() }),
        body: z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional(), messageId: z.string().optional(), account: acct }),
      },
    },
    async (req) => app.svc.labelChat(accountFor(app, P(req), req.body.account), { chat: req.params.chat, add: req.body.add, remove: req.body.remove, messageId: req.body.messageId }),
  )

  f.post(
    '/v1/labels/reload',
    { preHandler: guard('admin'), schema: { ...tags('Messages'), summary: 'Read every label again from WhatsApp', body: z.object({ account: acct }).optional() } },
    async (req) => app.svc.reloadLabels(accountFor(app, P(req), (req.body as { account?: string } | undefined)?.account)),
  )

  f.get(
    '/v1/chats/:chat/messages',
    {
      preHandler: guard('read'),
      schema: {
        ...tags('Messages'),
        summary: 'Messages of a chat (chronological)',
        params: z.object({ chat: z.string() }),
        querystring: z.object({ account: acct, limit: z.coerce.number().int().min(1).max(500).optional(), before: z.string().optional(), after: z.string().optional() }),
      },
    },
    async (req) => app.svc.getMessages(accountFor(app, P(req), req.query.account), req.params.chat, req.query),
  )

  f.get(
    '/v1/messages/search',
    {
      preHandler: guard('read'),
      schema: { ...tags('Messages'), summary: 'Search messages', querystring: z.object({ q: z.string().min(1), chat: z.string().optional(), since: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional(), account: acct }) },
    },
    async (req) => app.svc.searchMessages(accountFor(app, P(req), req.query.account), req.query.q, req.query),
  )

  f.post(
    '/v1/messages/text',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Send'),
        summary: 'Send a text message',
        body: z.object({ to: z.string(), text: z.string().min(1), replyTo: z.string().optional(), mentions: z.array(z.string()).optional(), idempotencyKey: z.string().optional(), account: acct }),
      },
    },
    async (req) => app.svc.sendText(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/messages/media',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Send'),
        summary: 'Send media (url or base64)',
        body: z.object({
          to: z.string(),
          type: z.enum(['image', 'video', 'audio', 'document', 'sticker']),
          url: z.string().optional(),
          base64: z.string().optional(),
          mimetype: z.string().optional(),
          fileName: z.string().optional(),
          caption: z.string().optional(),
          ptt: z.boolean().optional(),
          replyTo: z.string().optional(),
          idempotencyKey: z.string().optional(),
          account: acct,
        }),
      },
      bodyLimit: 100 * 1024 * 1024,
    },
    async (req) => app.svc.sendMedia(accountFor(app, P(req), req.body.account), req.body),
  )

  f.get(
    '/v1/status',
    {
      preHandler: guard('read'),
      schema: { ...tags('Messages'), summary: 'My statuses (stories): who saw and liked them', querystring: z.object({ since: z.string().optional(), account: acct }) },
    },
    async (req) => app.svc.statusViews(accountFor(app, P(req), req.query.account), { since: req.query.since }),
  )

  f.get(
    '/v1/status/:id',
    { preHandler: guard('read'), schema: { ...tags('Messages'), summary: 'Who saw and liked one of my statuses, and who did not see it yet', params: z.object({ id: z.string() }), querystring: z.object({ account: acct }) } },
    async (req) => app.svc.statusViews(accountFor(app, P(req), req.query.account), { statusId: req.params.id }),
  )

  f.post(
    '/v1/status',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Send'),
        summary: 'Post a status (story) only the listed people can see',
        body: z.object({
          audience: z.array(z.string()).min(1),
          type: z.enum(['text', 'image', 'video']),
          text: z.string().optional(),
          url: z.string().optional(),
          base64: z.string().optional(),
          mimetype: z.string().optional(),
          caption: z.string().optional(),
          account: acct,
        }),
      },
      bodyLimit: 100 * 1024 * 1024,
    },
    async (req) => app.svc.postStatus(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/messages/location',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Send a location', body: z.object({ to: z.string(), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional(), account: acct }) } },
    async (req) => app.svc.sendLocation(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/messages/react',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'React to a message', body: z.object({ chat: z.string(), messageId: z.string(), emoji: z.string(), account: acct }) } },
    async (req) => app.svc.react(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/messages/read',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Mark chat/messages read', body: z.object({ chat: z.string(), messageIds: z.array(z.string()).optional(), account: acct }) } },
    async (req) => app.svc.markRead(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/messages/edit',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Edit own message', body: z.object({ chat: z.string(), messageId: z.string(), text: z.string().min(1), account: acct }) } },
    async (req) => app.svc.editMessage(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/messages/delete',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Delete message for everyone', body: z.object({ chat: z.string(), messageId: z.string(), account: acct }) } },
    async (req) => app.svc.deleteMessage(accountFor(app, P(req), req.body.account), req.body),
  )

  f.post(
    '/v1/chats/disappearing',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Send'),
        summary: 'Set disappearing messages for a chat and/or the account default',
        body: z.object({ chat: z.string().optional(), seconds: z.number().int().min(0), accountDefault: z.boolean().optional(), account: acct }),
      },
    },
    async (req) => app.svc.setDisappearing(accountFor(app, P(req), req.body.account), req.body),
  )

  f.get(
    '/v1/messages/:id/media',
    { preHandler: guard('read'), schema: { ...tags('Messages'), summary: 'Download media of a message (binary)', params: z.object({ id: z.string() }), querystring: z.object({ chat: z.string().optional(), account: acct }) } },
    async (req, reply) => {
      const m = await app.svc.downloadMedia(accountFor(app, P(req), req.query.account), req.query.chat, req.params.id)
      return reply.type(m.mimetype).header('content-disposition', `attachment; filename="${m.fileName.replace(/["\\\r\n]/g, '_')}"`).send(m.buf)
    },
  )

  f.post(
    '/v1/messages/:id/transcribe',
    {
      preHandler: guard('read'),
      schema: {
        ...tags('Messages'),
        summary: 'What was said in a voice or audio message (transcript, kept once made)',
        params: z.object({ id: z.string() }),
        body: z.object({ chat: z.string().optional(), force: z.boolean().optional(), account: acct }).default({}),
      },
    },
    async (req) => {
      const t = await app.voice.transcribe(accountFor(app, P(req), req.body.account), req.body.chat, req.params.id, { force: req.body.force })
      return { messageId: t.id, chat: t.chat, transcript: t.text, language: t.language, seconds: t.seconds, engine: t.engine, cached: t.cached }
    },
  )

  f.get('/v1/contacts', { preHandler: guard('read'), schema: { ...tags('Contacts'), summary: 'Find contacts/chats by name or number', querystring: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).optional(), account: acct }) } }, async (req) =>
    app.svc.findContacts(accountFor(app, P(req), req.query.account), req.query.q, req.query.limit ?? 20),
  )

  f.get('/v1/contacts/check', { preHandler: guard('read'), schema: { ...tags('Contacts'), summary: 'Is this number on WhatsApp?', querystring: z.object({ phone: z.string(), account: acct }) } }, async (req) =>
    accountFor(app, P(req), req.query.account).checkNumber(req.query.phone),
  )

  f.get('/v1/groups', { preHandler: guard('read'), schema: { ...tags('Groups'), summary: 'List groups', querystring: z.object({ q: z.string().optional(), refresh: z.enum(['true', 'false']).optional(), account: acct }) } }, async (req) =>
    app.svc.listGroups(accountFor(app, P(req), req.query.account), { query: req.query.q, refresh: req.query.refresh === 'true' }),
  )

  f.get('/v1/groups/:jid', { preHandler: guard('read'), schema: { ...tags('Groups'), summary: 'Group details', params: z.object({ jid: z.string() }), querystring: z.object({ account: acct }) } }, async (req) =>
    app.svc.getGroup(accountFor(app, P(req), req.query.account), req.params.jid),
  )

  // ------------------------------------------------------------------ events (SSE)
  f.get(
    '/v1/events',
    { preHandler: guard('read'), schema: { ...tags('Events'), summary: 'Server-Sent Events stream', querystring: z.object({ account: z.string().optional(), types: z.string().optional() }) } },
    async (req, reply) => {
      const p = P(req)
      const types = req.query.types ? new Set(req.query.types.split(',')) : null
      const allowed = new Set(visibleAccounts(app, p).map((a) => a.id))
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      reply.raw.write(`: connected ${new Date().toISOString()}\n\n`)
      const onEv = (ev: WaEvent) => {
        if (ev.adminOnly && !p.scopes.has('admin')) return
        if (!allowed.has(ev.account) && !(p.accounts === '*')) return
        if (req.query.account && ev.account !== req.query.account) return
        if (types && !types.has(ev.type)) return
        reply.raw.write(`event: ${ev.type}\nid: ${ev.id}\ndata: ${JSON.stringify({ account: ev.account, at: ev.at, data: ev.data })}\n\n`)
      }
      app.bus.on('event', onEv)
      const hb = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000)
      req.raw.on('close', () => {
        clearInterval(hb)
        app.bus.off('event', onEv)
      })
    },
  )

  // ------------------------------------------------------------------ admin
  // ---- service log (Settings → Log)
  const LEVELS: Record<string, number> = { all: 0, debug: 20, info: 30, warn: 40, error: 50 }
  f.get(
    '/v1/admin/logs',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Recent service log', querystring: z.object({ level: z.enum(['all', 'debug', 'info', 'warn', 'error']).optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(3000).optional() }) } },
    async (req) => ({ entries: recentLogs({ minLevel: LEVELS[req.query.level ?? 'all'], q: req.query.q, limit: req.query.limit ?? 500 }) }),
  )
  f.get('/v1/admin/logs/stream', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Live service log (Server-Sent Events)' } }, async (req, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`)
    const off = onLog((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`))
    const hb = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000)
    req.raw.on('close', () => {
      clearInterval(hb)
      off()
    })
  })
  f.get('/v1/admin/logs/download', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Download the service log file (JSON lines)' } }, async (_req, reply) => {
    const body = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE) : Buffer.from('')
    return reply
      .type('application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="whatsops-${new Date().toISOString().slice(0, 10)}.log"`)
      .header('cache-control', 'no-store')
      .send(body)
  })

  f.get('/v1/admin/overview', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Server overview' } }, async (req) => {
    const accounts = []
    for (const a of app.accounts.list()) accounts.push({ ...a.status(), stats: await app.svc.stats(a).catch(() => null) })
    return {
      version: VERSION,
      build: BUILD,
      versionLabel: VERSION_LABEL,
      publicUrl: publicOrigin(req, app.settings.get().publicUrl),
      database: { dialect: app.h.dialect, url: maskDbUrl(app.h.url), envOverride: !!config.dbUrlEnv },
      accounts,
      settings: app.settings.get(),
      language: { server: defaultLang(), setting: app.settings.get().language },
      theme: { appearance: app.settings.get().appearance, mode: currentTheme(app.settings.get().appearance).mode, desktop: desktopTheme()?.name ?? null },
      uptimeSec: Math.round(process.uptime()),
      installation: app.reports.code,
      license: { enabled: app.license.enabled },
    }
  })

  // ---- who am I (the page shows only what the caller may use)
  f.get('/v1/me', { preHandler: signedIn, schema: { ...tags('Admin'), summary: 'The signed-in caller: owner or user, with the user\'s permissions' } }, async (req) => {
    const p = P(req)
    if (p.kind === 'user' && p.user) return { role: 'user', id: p.user.id, name: p.user.name, phone: p.user.phone ? `+${p.user.phone.slice(0, 2)}…${p.user.phone.slice(-3)}` : null, perms: p.user.perms }
    return { role: p.scopes.has('admin') ? 'owner' : p.kind, id: p.id, name: p.label, perms: null }
  })

  // ---- plugins
  const PLUGINS = [
    { id: 'currentrms', name: 'Current RMS', logo: 'currentrms.png' },
    { id: 'rentman', name: 'Rentman', logo: 'rentman.png' },
  ] as const
  f.get('/v1/plugins', { preHandler: signedIn, schema: { ...tags('Plugins'), summary: 'Installed plugins (a user sees only the ones enabled for them)' } }, async (req) => {
    const p = P(req)
    if (p.kind !== 'user') requireScope(p, 'read')
    return PLUGINS.filter((x) => p.kind !== 'user' || pluginAccess(p.user, x.id)).map((x) => ({
      ...x,
      configured: app.plugins[x.id].configured(),
      ...(p.kind === 'user' ? { perms: pluginAccess(p.user, x.id) } : {}),
    }))
  })

  // ---- users (owner only): who signs in besides the owner and what they see
  const userBody = z.object({
    name: z.string().min(1).max(120).optional(),
    phone: z.string().max(40).nullable().optional(),
    active: z.boolean().optional(),
    perms: z.object({ plugins: z.record(z.string(), z.object({ access: z.boolean(), scope: z.enum(['owned', 'all']).optional(), manage: z.boolean().optional() })) }).optional(),
  })
  const userOut = (u: Awaited<ReturnType<typeof app.users.get>>) => u && { id: u.id, name: u.name, phone: u.phone, active: u.active, perms: u.perms, source: u.source, createdAt: new Date(u.createdAt).toISOString(), lastLogin: u.lastLogin ? new Date(u.lastLogin).toISOString() : null }
  f.get('/v1/admin/users', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Users and their permissions' } }, async () => (await app.users.list()).map(userOut))
  f.post('/v1/admin/users', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Add a user (signs in with a code on their own WhatsApp number)', body: userBody.extend({ name: z.string().min(1).max(120) }) } }, async (req) => {
    const u = await app.users.create({ name: req.body.name, phone: req.body.phone ?? null, perms: normPerms(req.body.perms), active: req.body.active })
    logger.info({ mod: 'users', user: u.id }, `user ${u.name} added`)
    return userOut(u)
  })
  f.put('/v1/admin/users/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Change a user: name, number, active, permissions', params: z.object({ id: z.string() }), body: userBody } }, async (req) => {
    const u = await app.users.update(req.params.id, req.body)
    logger.info({ mod: 'users', user: u.id }, `user ${u.name} changed`)
    return userOut(u)
  })
  f.delete('/v1/admin/users/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Remove a user (signed out at once)', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.users.remove(req.params.id)
    logger.info({ mod: 'users', user: req.params.id }, 'user removed')
    return { ok: true }
  })
  f.post('/v1/admin/users/:id/login-link', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'One-time sign-in link for a user (30 minutes)', params: z.object({ id: z.string() }) } }, async (req) => {
    const u = await app.users.get(req.params.id)
    if (!u) throw new AppError('NO_USER', 'User {0} not found', 404, [req.params.id])
    if (!u.active) throw new AppError('USER_INACTIVE', 'The user is switched off', 409)
    const t = await app.admin.createLoginToken('linku', 30 * 60_000, u.id)
    return { url: `${publicOrigin(req, app.settings.get().publicUrl)}/login?u=${encodeURIComponent(u.id)}&t=${t}`, expiresInMin: 30 }
  })
  registerCurrentRms(fastify, app, app.plugins.currentrms, guard, tags)
  registerRentman(fastify, app, app.plugins.rentman, tags)

  // ---- license (Polar) — off while WhatsOps is free
  f.get('/v1/admin/license', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'License state (off while WhatsOps is free)' } }, async () => app.license.status())
  f.post('/v1/admin/license', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Activate a license key bought on Polar', body: z.object({ key: z.string().max(200) }) } }, async (req) =>
    app.license.activate(req.body.key),
  )
  f.delete('/v1/admin/license', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Remove the license from this installation' } }, async () => app.license.deactivate())

  // ---- voice messages → text
  f.get('/v1/admin/voice', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Voice messages: transcription engine and its state' } }, async () => app.voice.publicConfig())
  f.put(
    '/v1/admin/voice',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Voice messages: choose the transcription engine (off, faster-whisper on the server, command, online service) and which voice messages to transcribe (auto: all as they arrive, or only on request)',
        body: z.object({
          engine: z.enum(['off', 'local', 'command', 'api']).optional(),
          model: z.string().max(80).optional(),
          command: z.string().max(1000).optional(),
          provider: z.enum(['xai', 'openai', 'groq', 'custom']).optional(),
          apiUrl: z.string().max(300).optional(),
          apiKey: z.string().max(500).optional(),
          apiModel: z.string().max(120).optional(),
          language: z.string().max(8).optional(),
          auto: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      await app.voice.update(req.body)
      return app.voice.publicConfig()
    },
  )
  f.post(
    '/v1/admin/voice/install',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Voice messages: install faster-whisper in WhatsOps\' own folder (Linux, macOS, Windows; no Python needed), then use it with the given model. Runs in the background: follow local.install in GET /v1/admin/voice',
        body: z.object({ model: z.string().max(80).optional() }).default({}),
      },
    },
    async (req) => {
      app.voice.installLocal(req.body?.model)
      return app.voice.publicConfig()
    },
  )
  // ---- backup (Settings → Backup)
  const sendBackupFile = (reply: import('fastify').FastifyReply, file: string, cleanup?: () => void) => {
    const st = fs.createReadStream(file)
    if (cleanup) st.on('close', cleanup)
    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="${path.basename(file)}"`)
      .header('content-length', String(fs.statSync(file).size))
      .header('cache-control', 'no-store')
      .send(st)
  }
  const backupPassword = (v: unknown) => {
    try {
      return decodeURIComponent(String(v ?? ''))
    } catch {
      return String(v ?? '')
    }
  }
  f.get('/v1/admin/backup', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: settings, last / next automatic backup, backups in the folder' } }, async () => app.backup.publicConfig())
  f.put(
    '/v1/admin/backup',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Backup: how often (off, hour, day, week), folder of the server, how many to keep, optional password',
        body: z.object({
          every: z.enum(['off', 'hour', 'day', 'week']).optional(),
          folder: z.string().max(1000).optional(),
          keep: z.number().int().min(1).max(1000).optional(),
          password: z.string().max(200).optional(),
          removePassword: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      await app.backup.update(req.body)
      return app.backup.publicConfig()
    },
  )
  f.post('/v1/admin/backup/now', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: make one now in the folder' } }, async () => {
    const r = await app.backup.backupNow('manual')
    return { file: path.basename(r.file), size: r.size, ...app.backup.publicConfig() }
  })
  f.get('/v1/admin/backup/download', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: download a fresh backup file (.whatsops)' } }, async (_req, reply) => {
    const r = await app.backup.forDownload()
    return sendBackupFile(reply, r.file, r.cleanup)
  })
  f.get(
    '/v1/admin/backup/files/:name',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: download a backup of the folder', params: z.object({ name: z.string().max(200) }) } },
    async (req, reply) => sendBackupFile(reply, app.backup.fileInFolder(req.params.name)),
  )
  f.post(
    '/v1/admin/backup/files/:name/restore',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Backup: restore a backup of the folder (a copy of the current data is saved first; WhatsOps restarts)',
        params: z.object({ name: z.string().max(200) }),
        body: z.object({ password: z.string().max(200).optional() }).default({}),
      },
    },
    async (req) => app.backup.restore(app.backup.fileInFolder(req.params.name), req.body?.password ?? ''),
  )
  f.get(
    '/v1/admin/backup/folders',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: folders of the server, to choose where backups go', querystring: z.object({ path: z.string().max(1000).optional() }) } },
    async (req) => listFolders(req.query.path),
  )
  f.post(
    '/v1/admin/backup/folders',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: new folder', body: z.object({ parent: z.string().max(1000), name: z.string().max(200) }) } },
    async (req) => listFolders(makeFolder(req.body.parent, req.body.name)),
  )
  // the backup file itself is the body (application/octet-stream), the password in x-backup-password (URI-encoded)
  f.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
    sub.post(
      '/v1/admin/backup/restore',
      { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: restore from an uploaded file (body = the .whatsops file; a copy of the current data is saved first; WhatsOps restarts)' } },
      async (req) => app.backup.restoreUpload(req.body as Readable, backupPassword(req.headers['x-backup-password'])),
    )
  })
  f.post('/v1/admin/voice/test', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Voice messages: try the engine on the latest voice message' } }, async () => app.voice.test())

  f.get('/v1/admin/settings', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Get settings' } }, async () => app.settings.get())
  f.put(
    '/v1/admin/settings',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Update settings',
        body: z.object({
          ratePerMin: z.number().optional(),
          perChatGapMs: z.number().optional(),
          sendAllowlist: z.string().optional(),
          allowColdContacts: z.boolean().optional(),
          otpEnabled: z.boolean().optional(),
          oauthAccessTtl: z.number().optional(),
          oauthRefreshDays: z.number().optional(),
          publicUrl: z.string().optional(),
          maxMediaMb: z.number().optional(),
          language: z.enum(['auto', 'en', 'it']).optional(),
          appearance: z.enum(['light', 'dark', 'system']).optional(),
          crashReports: z.enum(['ask', 'auto', 'off']).optional(),
          autoUpdate: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const s = await app.settings.update(req.body)
      setServerLanguage(s.language)
      // switched to "send automatically": send what is pending now, so the page shows it as sent
      if (req.body.crashReports === 'auto') await Promise.race([app.reports.autoSend().catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))])
      return s
    },
  )

  // ---- feedback, crash & malfunction reports (GitHub issues)
  f.get('/v1/admin/feedback', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Feedback: installation code, pending crash/malfunction reports, sent reports' } }, async () => app.reports.status())
  f.post(
    '/v1/admin/feedback',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Send feedback (opens a public GitHub issue signed with this installation code)',
        body: z.object({ kind: z.enum(['bug', 'idea', 'other']), title: z.string().max(300), message: z.string().max(10000), diagnostics: z.boolean().optional() }),
      },
    },
    async (req) => app.reports.sendFeedback(req.body, 'web'),
  )
  f.post('/v1/admin/reports/:id/send', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Send a pending crash/malfunction report', params: z.object({ id: z.string() }) } }, async (req) =>
    app.reports.sendReport(req.params.id, 'manual'),
  )
  f.delete('/v1/admin/reports/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Discard a pending report', params: z.object({ id: z.string() }) } }, async (req) => {
    if (!app.reports.discard(req.params.id)) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404)
    return { ok: true }
  })

  // ---- updates from the GitHub repository
  f.get('/v1/admin/update', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Version, latest release on GitHub, auto-update state' } }, async () => app.updater.status())
  f.post('/v1/admin/update/check', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Check GitHub for a new release now' } }, async () => {
    try {
      await app.updater.check()
    } catch {
      throw new AppError('REPORT_UNREACHABLE', 'GitHub cannot be reached right now, try again later', 503)
    }
    return app.updater.status()
  })
  f.post('/v1/admin/update/apply', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Install the latest release now (the service restarts by itself)' } }, async () => {
    const p = app.updater.apply('manual')
    p.catch(() => undefined)
    // quick refusals (no git, up to date, local changes) come back right away; the install itself runs on
    await Promise.race([p, new Promise((r) => setTimeout(r, 3000))])
    return app.updater.status()
  })

  // ---- database location
  f.get('/v1/admin/database', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Current database' } }, async () => {
    const b = readBootstrap()
    return {
      dialect: app.h.dialect,
      url: maskDbUrl(app.h.url),
      envOverride: !!config.dbUrlEnv,
      defaultSqlite: `sqlite://${config.defaultSqlite}`,
      previous: (b.previous ?? []).map((p) => ({ url: maskDbUrl(p.dbUrl), at: new Date(p.at).toISOString() })),
    }
  })

  f.post('/v1/admin/database/test', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Test a database URL', body: z.object({ url: z.string().min(3) }) } }, async (req) => {
    const t0 = Date.now()
    const { dialect } = parseDbUrl(req.body.url)
    const h = await openDb(req.body.url)
    try {
      await pingDb(h)
      let accounts: number | null = null
      try {
        const r = await h.db.selectFrom('accounts').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst()
        accounts = Number(r?.n ?? 0)
      } catch {
        accounts = null
      }
      return { ok: true, dialect, latencyMs: Date.now() - t0, existingAccounts: accounts }
    } catch (e) {
      throw new AppError('DB_UNREACHABLE', 'Connection failed: {0}', 400, [String((e as Error).message ?? e)])
    } finally {
      await h.close().catch(() => undefined)
    }
  })

  f.post(
    '/v1/admin/database/switch',
    {
      preHandler: guard('admin'),
      schema: { ...tags('Admin'), summary: 'Move to another database (optionally copying all data) and restart', body: z.object({ url: z.string().min(3), copyData: z.boolean().default(true) }) },
    },
    async (req) => {
      if (config.dbUrlEnv) throw new AppError('ENV_OVERRIDE', 'WA_DB_URL is set in the service environment; remove it to manage the database from here', 409)
      const target = await openDb(req.body.url)
      let counts: Record<string, number> | null = null
      try {
        await pingDb(target)
        await migrate(target)
        if (req.body.copyData) {
          await app.accounts.stopAll()
          counts = await copyAll(app.h, target, (t, n) => logger.info({ table: t, n }, 'copying'))
        }
      } catch (e) {
        await target.close().catch(() => undefined)
        if (req.body.copyData) for (const a of app.accounts.list()) if (a.row.enabled) void a.start().catch(() => undefined)
        throw new AppError('DB_SWITCH_FAILED', 'Switch aborted, still on the current database: {0}', 400, [String((e as Error).message ?? e)])
      }
      await target.close()
      const b = readBootstrap()
      writeBootstrap({ dbUrl: req.body.url, previous: [...(b.previous ?? []), { dbUrl: b.dbUrl, at: now() }].slice(-5) })
      app.restart('database switched')
      return { ok: true, copied: counts, restarting: true }
    },
  )

  // ---- api keys
  f.get('/v1/admin/api-keys', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'List API keys' } }, async () => app.apiKeys.list())
  f.post(
    '/v1/admin/api-keys',
    {
      preHandler: guard('admin'),
      schema: { ...tags('Admin'), summary: 'Create API key (shown once)', body: z.object({ name: z.string().min(1), scopes: z.array(z.enum(['read', 'send', 'admin'])).min(1), accounts: z.union([z.literal('*'), z.array(z.string())]).default('*') }) },
    },
    async (req, reply) => reply.code(201).send(await app.apiKeys.create(req.body.name, req.body.scopes, req.body.accounts)),
  )
  f.delete('/v1/admin/api-keys/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Revoke API key', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.apiKeys.revoke(req.params.id)
    return { ok: true }
  })

  // ---- webhooks
  const HOOK_HEADERS = z.union([z.string().max(8000), z.record(z.string(), z.string())])
  f.get('/v1/admin/webhooks', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'List webhooks' } }, async () => {
    const hooks = await app.h.db.selectFrom('webhooks').selectAll().orderBy('created_at').execute()
    return hooks.map((h) => ({ ...h, secret: h.secret.slice(0, 6) + '…', headers: maskHookHeaders(h.headers as string | null) }))
  })
  f.post(
    '/v1/admin/webhooks',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Webhooks'),
        summary: `Create webhook. Events: * or ${WEBHOOK_EVENTS.join(', ')}. Signature: X-WA-Signature = sha256=HMAC(secret, X-WA-Timestamp + "." + body). headers: the receiver's key or header lines (e.g. Authorization: Bearer <key>)`,
        body: z.object({ url: z.url(), events: z.string().default('*'), account: z.string().default('*'), headers: HOOK_HEADERS.optional() }),
      },
    },
    async (req, reply) => {
      const id = crypto.randomUUID()
      const secret = randomToken('whs_', 24)
      const headers = parseHookHeaders(req.body.headers)
      await app.h.db
        .insertInto('webhooks')
        .values({ id, url: req.body.url, events: req.body.events, account_id: req.body.account, secret, active: 1, created_at: now(), headers: Object.keys(headers).length ? JSON.stringify(headers) : null })
        .execute()
      await app.webhooks.reload()
      return reply.code(201).send({ id, url: req.body.url, events: req.body.events, account: req.body.account, secret, headers: maskHookHeaders(JSON.stringify(headers)) })
    },
  )
  f.patch(
    '/v1/admin/webhooks/:id',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Webhooks'),
        summary: 'Update webhook (headers: "" removes the extra headers)',
        params: z.object({ id: z.string() }),
        body: z.object({ active: z.boolean().optional(), events: z.string().optional(), url: z.url().optional(), headers: HOOK_HEADERS.optional() }),
      },
    },
    async (req) => {
      const set: Record<string, unknown> = {}
      if (req.body.active !== undefined) set.active = req.body.active ? 1 : 0
      if (req.body.events) set.events = req.body.events
      if (req.body.url) set.url = req.body.url
      if (req.body.headers !== undefined) {
        const headers = parseHookHeaders(req.body.headers)
        set.headers = Object.keys(headers).length ? JSON.stringify(headers) : null
      }
      if (Object.keys(set).length) await app.h.db.updateTable('webhooks').set(set).where('id', '=', req.params.id).execute()
      await app.webhooks.reload()
      return { ok: true }
    },
  )
  f.delete('/v1/admin/webhooks/:id', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Delete webhook', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.h.db.deleteFrom('webhooks').where('id', '=', req.params.id).execute()
    await app.webhooks.reload()
    return { ok: true }
  })
  f.get('/v1/admin/webhooks/deliveries', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Recent deliveries' } }, async () =>
    app.h.db.selectFrom('webhook_deliveries').selectAll().orderBy('created_at', 'desc').limit(100).execute(),
  )
  f.post('/v1/admin/webhooks/:id/test', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Send a test event to this webhook only', params: z.object({ id: z.string() }) } }, async (req) => {
    // to this webhook only, whatever its events; the answer of the receiver comes back
    return app.webhooks.deliverTest(req.params.id, app.accounts.list()[0]?.id ?? 'test')
  })

  // ---- OAuth grants & admin sessions
  f.get('/v1/admin/oauth', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Connected OAuth apps' } }, async () => ({
    grants: await app.oauth.listGrants(),
    clients: await app.h.db.selectFrom('oauth_clients').select(['client_id', 'name', 'redirect_uris', 'auth_method', 'created_at']).orderBy('created_at', 'desc').limit(100).execute(),
  }))
  f.delete('/v1/admin/oauth/grants/:family', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Revoke an OAuth grant', params: z.object({ family: z.string() }) } }, async (req) => {
    await app.oauth.revokeFamily(req.params.family)
    return { ok: true }
  })
  f.get('/v1/admin/sessions', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Admin browser sessions' } }, async () => app.admin.listSessions())
  f.delete('/v1/admin/sessions/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Revoke admin session', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.admin.revokeSession(req.params.id)
    return { ok: true }
  })
  f.post('/v1/admin/login-link', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Create a one-time login link (30 min)' } }, async (req) => {
    const t = await app.admin.createLoginToken('link', 30 * 60_000)
    return { url: `${publicOrigin(req, app.settings.get().publicUrl)}/login?t=${t}`, expiresInMin: 30 }
  })
  f.put('/v1/admin/password', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Set admin password', body: z.object({ password: z.string().min(10) }) } }, async (req) => {
    await app.admin.setPassword(req.body.password)
    return { ok: true }
  })
  f.delete('/v1/admin/password', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Disable password login' } }, async () => {
    await app.admin.clearPassword()
    return { ok: true }
  })
  f.post('/v1/admin/restart', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Restart the service' } }, async () => {
    app.restart('admin request')
    return { ok: true, restarting: true }
  })
  f.get('/v1/admin/defaults', { preHandler: guard('admin'), schema: { hide: true } }, async () => DEFAULT_SETTINGS)
}
