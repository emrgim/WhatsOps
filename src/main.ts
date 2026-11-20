import fs from 'node:fs'
import path from 'node:path'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { VERSION, config, currentDbUrl, ensureDataDir } from './config.js'
import { maskDbUrl, migrate, openDb } from './db/index.js'
import { EventBus, WebhookDispatcher } from './events.js'
import { logger } from './log.js'
import { Settings } from './settings.js'
import { AccountManager } from './wa/manager.js'
import { WaService } from './wa/service.js'
import { AdminAuth, ApiKeys } from './security/auth.js'
import { OAuthServer } from './security/oauth.js'
import { registerRoutes } from './api/routes.js'
import { AppError } from './util.js'
import { localizeError, reqLang, setServerLanguage, tr } from './i18n.js'
import { primeTheme } from './theme.js'
import type { App } from './app.js'
import { Reports, recordCrashSync } from './reports.js'
import { Updater } from './update.js'
import { License } from './license.js'
import { CurrentRmsPlugin } from './plugins/currentrms.js'
import { Users } from './users.js'

// a crash is written to disk first (Settings → Feedback offers to send it), then systemd/launchd restarts us
process.on('uncaughtException', (e, origin) => {
  recordCrashSync(e, origin)
  logger.fatal({ err: String((e as Error)?.stack ?? e) }, 'crash: uncaught exception')
  setTimeout(() => process.exit(1), 200)
})

function takeLock(): () => void {
  const lock = path.join(config.dataDir, 'service.lock')
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return () => {
        try {
          if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock)
        } catch {
          /* ignore */
        }
      }
    } catch {
      const pid = Number(fs.readFileSync(lock, 'utf8') || 0)
      let alive = false
      try {
        if (pid) {
          process.kill(pid, 0)
          alive = true
        }
      } catch {
        alive = false
      }
      if (alive && pid !== process.pid) {
        logger.fatal({ pid }, 'another instance holds the lock (one WhatsApp socket per device!) — exiting')
        process.exit(3)
      }
      fs.unlinkSync(lock)
    }
  }
  throw new Error('could not take lock')
}

async function main() {
  ensureDataDir()
  const release = takeLock()
  const dbUrl = currentDbUrl()
  logger.info({ version: VERSION, db: maskDbUrl(dbUrl) }, 'starting mcp-mrg-whatsops')
  const h = await openDb(dbUrl)
  await migrate(h)
  const settings = new Settings(h)
  await settings.load()
  setServerLanguage(settings.get().language)
  if (config.publicUrl && !settings.get().publicUrl) await settings.update({ publicUrl: config.publicUrl })
  await primeTheme().catch(() => {})
  const bus = new EventBus()
  const accounts = new AccountManager({ h, bus, settings })
  const svc = new WaService(h, accounts, settings)
  const admin = new AdminAuth(h)
  const apiKeys = new ApiKeys(h)
  const oauth = new OAuthServer(h, settings, admin)
  const webhooks = new WebhookDispatcher(h, bus)
  await webhooks.start()
  const reports = new Reports(h, settings, () => ({
    Database: h.dialect,
    Numbers: String(accounts.list().length),
    Language: settings.get().language,
    Install: fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.git')) ? 'git' : 'other',
  }))
  await reports.start()
  const license = new License(h, () => reports.code)
  await license.start()

  const fastify = Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: true, bodyLimit: 100 * 1024 * 1024 }) as unknown as FastifyInstance
  fastify.setValidatorCompiler(validatorCompiler)
  fastify.setSerializerCompiler(serializerCompiler)
  await fastify.register(cookie)
  await fastify.register(formbody)
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'WhatsApp API (mcp-mrg-whatsops)',
        version: VERSION,
        description:
          'REST API over the same Baileys sockets used by the MCP server. Auth: `Authorization: Bearer wam_…` (API key from the config page) or an OAuth access token. Every data route accepts `account` (id or phone) to pick a number; default account otherwise. MCP endpoint: `POST /mcp` (Streamable HTTP).',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  })
  await fastify.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } })
  fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger())

  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: localizeError(err, reqLang(req)) } })
    if (hasZodFastifySchemaValidationErrors(err)) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    const e = err as { statusCode?: number; code?: string; message?: string }
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } })
    logger.error({ url: req.url, err: String((err as Error)?.stack ?? err) }, 'request failed')
    return reply.code(500).send({ error: { code: 'INTERNAL', message: tr(reqLang(req), 'Internal error') } })
  })
  fastify.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: tr(reqLang(req), '{0} {1} not found', [req.method, req.url.split('?')[0]]) } }))

  let shuttingDown = false
  const shutdown = async (code: number, reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ reason }, 'shutting down')
    const t = setTimeout(() => process.exit(code), 10_000)
    t.unref()
    try {
      await accounts.stopAll()
      await fastify.close()
      await h.close()
    } catch (e) {
      logger.warn({ err: String(e) }, 'shutdown error')
    }
    release()
    process.exit(code)
  }

  const updater = new Updater(h, settings, (reason) => setTimeout(() => void shutdown(0, `restart: ${reason}`), 400).unref())
  const app: App = {
    h,
    settings,
    bus,
    accounts,
    svc,
    admin,
    apiKeys,
    oauth,
    webhooks,
    reports,
    updater,
    license,
    users: new Users(h),
    plugins: {} as App['plugins'],
    // systemd (Restart=always) brings us back with the new configuration
    restart: (reason) => setTimeout(() => void shutdown(0, `restart: ${reason}`), 400).unref(),
  }

  // activity log (Settings → Log): every change through the API / MCP tool call, never bodies
  fastify.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const url = req.routeOptions?.url ?? req.url.split('?')[0]
    const ms = Math.round(reply.elapsedTime)
    if (url === '/mcp') {
      const body = req.body as { method?: string; params?: { name?: string } } | { method?: string; params?: { name?: string } }[] | undefined
      const tools = (Array.isArray(body) ? body : [body]).filter((b) => b?.method === 'tools/call').map((b) => b?.params?.name ?? '?')
      if (tools.length) logger.info({ mod: 'mcp', tools, status: reply.statusCode, ms }, `tool ${tools.join(', ')}`)
      return
    }
    if (!/^\/(v1|auth|oauth)\//.test(url)) return
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info'
    logger[level]({ mod: 'api', status: reply.statusCode, ms }, `${req.method} ${url}`)
  })

  // never let a proxy/CDN (Cloudflare) cache an error page
  fastify.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode >= 400) reply.header('cache-control', 'no-store')
    return payload
  })

  app.plugins.currentrms = new CurrentRmsPlugin(app)
  oauth.register(fastify)
  registerRoutes(fastify, app)

  await fastify.listen({ host: config.host, port: config.port })
  logger.info({ host: config.host, port: config.port }, 'listening')

  await accounts.loadAll()
  updater.start()
  await app.plugins.currentrms.start()

  setInterval(() => {
    void oauth.prune().catch(() => undefined)
    void webhooks.prune().catch(() => undefined)
  }, 3600_000).unref()

  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'))
  process.on('unhandledRejection', (e) => logger.error({ err: String((e as Error)?.stack ?? e) }, 'unhandled rejection'))
}

main().catch((e) => {
  recordCrashSync(e, 'startup')
  logger.fatal({ err: String((e as Error)?.stack ?? e) }, 'startup failed')
  process.exit(1)
})
