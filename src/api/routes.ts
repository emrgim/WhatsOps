import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { VERSION, config, readBootstrap, writeBootstrap } from '../config.js'
import { copyAll, maskDbUrl, migrate, now, openDb, parseDbUrl, pingDb } from '../db/index.js'
import { WEBHOOK_EVENTS, type WaEvent } from '../events.js'
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
  const secure = (req: FastifyRequest) => publicOrigin(req, app.settings.get().publicUrl).startsWith('https://')

  // ------------------------------------------------------------------ public
  f.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true, version: VERSION, connected: app.accounts.list().filter((a) => a.state === 'open').length }))

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
  f.get('/static/app.js', { schema: { hide: true } }, sendFile('app.js', 'application/javascript; charset=utf-8', 60))
  f.get('/static/i18n.js', { schema: { hide: true } }, sendFile('i18n.js', 'application/javascript; charset=utf-8', 60))
  f.get('/static/app.css', { schema: { hide: true } }, sendFile('app.css', 'text/css; charset=utf-8', 60))
  f.get('/static/base.css', { schema: { hide: true } }, sendFile('base.css', 'text/css; charset=utf-8', 300))
  f.get('/static/theme.js', { schema: { hide: true } }, sendFile('theme.js', 'application/javascript; charset=utf-8', 300))
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
    const ok = await app.admin.checkSession(req.cookies?.[SESSION_COOKIE])
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    if (!ok) return reply.send(loginPage(reqLang(req), { otpEnabled: app.settings.get().otpEnabled, passwordSet: await app.admin.passwordSet() }))
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
  f.get('/login', { schema: { hide: true, querystring: z.object({ t: z.string().optional() }) } }, async (req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    if (!req.query.t || !(await app.admin.consumeLoginToken('link', req.query.t, requestIp(req)))) {
      const lang = reqLang(req)
      return reply.code(403).send(messagePage(lang, tr(lang, 'Invalid link'), tr(lang, 'Login link expired or already used. Ask for a new one.')))
    }
    const tok = await app.admin.createSession(`magic link · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`)
    app.admin.setCookie(reply, tok, secure(req))
    return reply.redirect('/', 303)
  })

  f.get('/auth/me', { schema: { hide: true } }, async (req) => ({
    loggedIn: await app.admin.checkSession(req.cookies?.[SESSION_COOKIE]),
    otpEnabled: app.settings.get().otpEnabled,
    passwordSet: await app.admin.passwordSet(),
  }))

  const otpHits: number[] = []
  f.post('/auth/otp/request', { schema: { hide: true, body: z.object({ account: z.string().optional() }).optional() } }, async (req) => {
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

  f.post('/auth/otp/verify', { schema: { hide: true, body: z.object({ code: z.string() }) } }, async (req, reply) => {
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
      schema: { ...tags('Accounts'), summary: 'Add a WhatsApp number', body: z.object({ label: z.string().min(1), id: z.string().optional(), phone: z.string().optional(), syncHistory: z.boolean().optional() }) },
    },
    async (req, reply) => {
      const a = await app.accounts.create(req.body)
      return reply.code(201).send(a.status())
    },
  )

  f.get('/v1/accounts/:id', { preHandler: guard('read'), schema: { ...tags('Accounts'), summary: 'Account status', params: z.object({ id: z.string() }) } }, async (req) => accountFor(app, P(req), req.params.id).status())

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
        querystring: z.object({ account: acct, limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(), unread: z.enum(['true', 'false']).optional(), q: z.string().optional(), type: z.enum(['all', 'groups', 'direct']).optional() }),
      },
    },
    async (req) => app.svc.listChats(accountFor(app, P(req), req.query.account), { limit: req.query.limit, offset: req.query.offset, unreadOnly: req.query.unread === 'true', query: req.query.q, type: req.query.type }),
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

  f.get(
    '/v1/messages/:id/media',
    { preHandler: guard('read'), schema: { ...tags('Messages'), summary: 'Download media of a message (binary)', params: z.object({ id: z.string() }), querystring: z.object({ chat: z.string().optional(), account: acct }) } },
    async (req, reply) => {
      const m = await app.svc.downloadMedia(accountFor(app, P(req), req.query.account), req.query.chat, req.params.id)
      return reply.type(m.mimetype).header('content-disposition', `attachment; filename="${m.fileName.replace(/["\\\r\n]/g, '_')}"`).send(m.buf)
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
      publicUrl: publicOrigin(req, app.settings.get().publicUrl),
      database: { dialect: app.h.dialect, url: maskDbUrl(app.h.url), envOverride: !!config.dbUrlEnv },
      accounts,
      settings: app.settings.get(),
      language: { server: defaultLang(), setting: app.settings.get().language },
      theme: { appearance: app.settings.get().appearance, mode: currentTheme(app.settings.get().appearance).mode, desktop: desktopTheme()?.name ?? null },
      uptimeSec: Math.round(process.uptime()),
    }
  })

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
        }),
      },
    },
    async (req) => {
      const s = await app.settings.update(req.body)
      setServerLanguage(s.language)
      return s
    },
  )

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
  f.get('/v1/admin/webhooks', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'List webhooks' } }, async () => {
    const hooks = await app.h.db.selectFrom('webhooks').selectAll().orderBy('created_at').execute()
    return hooks.map((h) => ({ ...h, secret: h.secret.slice(0, 6) + '…' }))
  })
  f.post(
    '/v1/admin/webhooks',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Webhooks'),
        summary: `Create webhook. Events: * or ${WEBHOOK_EVENTS.join(', ')}. Signature: X-WA-Signature = sha256=HMAC(secret, X-WA-Timestamp + "." + body)`,
        body: z.object({ url: z.url(), events: z.string().default('*'), account: z.string().default('*') }),
      },
    },
    async (req, reply) => {
      const id = crypto.randomUUID()
      const secret = randomToken('whs_', 24)
      await app.h.db.insertInto('webhooks').values({ id, url: req.body.url, events: req.body.events, account_id: req.body.account, secret, active: 1, created_at: now() }).execute()
      await app.webhooks.reload()
      return reply.code(201).send({ id, url: req.body.url, events: req.body.events, account: req.body.account, secret })
    },
  )
  f.patch(
    '/v1/admin/webhooks/:id',
    { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Update webhook', params: z.object({ id: z.string() }), body: z.object({ active: z.boolean().optional(), events: z.string().optional(), url: z.url().optional() }) } },
    async (req) => {
      const set: Record<string, unknown> = {}
      if (req.body.active !== undefined) set.active = req.body.active ? 1 : 0
      if (req.body.events) set.events = req.body.events
      if (req.body.url) set.url = req.body.url
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
  f.post('/v1/admin/webhooks/:id/test', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Send a test event', params: z.object({ id: z.string() }) } }, async (req) => {
    const hook = await app.h.db.selectFrom('webhooks').selectAll().where('id', '=', req.params.id).executeTakeFirst()
    if (!hook) throw new AppError('NOT_FOUND', 'webhook not found', 404)
    app.bus.publish('connection.update', hook.account_id && hook.account_id !== '*' ? hook.account_id : app.accounts.list()[0]?.id ?? 'test', { test: true, state: 'test' })
    return { ok: true }
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
