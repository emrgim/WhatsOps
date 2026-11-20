#!/usr/bin/env node
import fs from 'node:fs'
import { config, currentDbUrl, ensureDataDir, readBootstrap, writeBootstrap } from './config.js'
import { getSetting, maskDbUrl, migrate, now, openDb, parseDbUrl, pingDb } from './db/index.js'
import { AdminAuth, ApiKeys } from './security/auth.js'

const [cmd, ...rest] = process.argv.slice(2)

function arg(name: string, def?: string): string | undefined {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : def
}

async function withDb<T>(fn: (h: Awaited<ReturnType<typeof openDb>>) => Promise<T>): Promise<T> {
  ensureDataDir()
  const h = await openDb(currentDbUrl())
  try {
    await migrate(h)
    return await fn(h)
  } finally {
    await h.close()
  }
}

async function publicUrl(h: Awaited<ReturnType<typeof openDb>>): Promise<string> {
  const raw = await getSetting(h, 'app')
  let u = ''
  try {
    u = raw ? JSON.parse(raw).publicUrl : ''
  } catch {
    u = ''
  }
  return (u || config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, '')
}

async function run() {
  switch (cmd) {
    case 'serve':
      await import('./main.js')
      return
    case 'stdio':
      await import('./stdio.js')
      return
    case 'login-link': {
      // --local: link to this computer (the app launchers); --out FILE: write it to a file instead of printing it
      await withDb(async (h) => {
        const t = await new AdminAuth(h).createLoginToken('link', Number(arg('minutes', '30')) * 60_000)
        const base = rest.includes('--local') ? `http://127.0.0.1:${config.port}` : await publicUrl(h)
        const url = `${base}/login?t=${t}`
        const out = arg('out')
        if (out) fs.writeFileSync(out, url, { mode: 0o600 })
        else console.log(url)
      })
      return
    }
    case 'key': {
      const name = arg('name', 'cli')!
      const scopes = (arg('scopes', 'read,send') ?? '').split(',').map((s) => s.trim())
      const accounts = arg('accounts', '*')!
      await withDb(async (h) => {
        const k = await new ApiKeys(h).create(name, scopes, accounts === '*' ? '*' : accounts.split(','))
        console.log(k.key)
      })
      return
    }
    case 'db': {
      const sub = rest[0]
      if (sub === 'show' || !sub) {
        console.log(JSON.stringify({ current: maskDbUrl(currentDbUrl()), envOverride: !!config.dbUrlEnv, bootstrap: config.bootstrapFile }, null, 2))
        return
      }
      if (sub === 'set') {
        const url = rest[1]
        if (!url) throw new Error('usage: db set <url>')
        parseDbUrl(url)
        const h = await openDb(url)
        await pingDb(h)
        await migrate(h)
        await h.close()
        const b = readBootstrap()
        writeBootstrap({ dbUrl: url, previous: [...(b.previous ?? []), { dbUrl: b.dbUrl, at: now() }].slice(-5) })
        console.log(`database set to ${maskDbUrl(url)} — restart the service`)
        return
      }
      break
    }
    case 'status': {
      const r = await fetch(`http://${config.host}:${config.port}/healthz`).catch(() => null)
      console.log(r ? JSON.stringify(await r.json(), null, 2) : 'service not reachable')
      return
    }
  }
  console.log(`mcp-mrg-whatsops CLI
  serve                                     run the server (REST + MCP + config page)
  stdio                                     stdio MCP proxy (env WA_MCP_URL, WA_API_KEY, WA_LANG)
  login-link [--minutes 30]                 one-time admin login URL
  key --name N --scopes read,send[,admin] [--accounts id1,id2]   create an API key (printed once)
  db show | db set <sqlite:///path|postgres://…|mysql://…>
  status`)
}

run().catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})
