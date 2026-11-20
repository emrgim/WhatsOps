import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = '1.5.1'

function env(name: string, def = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? def : v
}

function defaultDataDir(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/mcp-mrg-whatsops')
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mcp-mrg-whatsops')
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'mcp-mrg-whatsops')
}

const dataDir = path.resolve(env('WA_DATA_DIR', defaultDataDir()))

export const config = {
  host: env('WA_HOST', '127.0.0.1'),
  port: Number(env('WA_PORT', '8810')),
  dataDir,
  publicUrl: env('WA_PUBLIC_URL', '').replace(/\/+$/, ''),
  logLevel: env('WA_LOG_LEVEL', 'info'),
  /** Explicit DB URL from env wins over bootstrap.json (useful for tests). */
  dbUrlEnv: env('WA_DB_URL', ''),
  bootstrapFile: path.join(dataDir, 'bootstrap.json'),
  mediaDir: path.join(dataDir, 'media'),
  backupsDir: path.join(dataDir, 'backups'),
  defaultSqlite: path.join(dataDir, 'wa.db'),
}

export function ensureDataDir(): void {
  for (const d of [config.dataDir, config.mediaDir, config.backupsDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  }
  try { fs.chmodSync(config.dataDir, 0o700) } catch { /* ignore */ }
}

export type Bootstrap = { dbUrl: string; previous?: { dbUrl: string; at: number }[] }

export function readBootstrap(): Bootstrap {
  try {
    const raw = JSON.parse(fs.readFileSync(config.bootstrapFile, 'utf8'))
    if (raw && typeof raw.dbUrl === 'string' && raw.dbUrl) return raw
  } catch { /* first run */ }
  return { dbUrl: `sqlite://${config.defaultSqlite}` }
}

export function writeBootstrap(b: Bootstrap): void {
  ensureDataDir()
  const tmp = config.bootstrapFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, config.bootstrapFile)
}

export function currentDbUrl(): string {
  return config.dbUrlEnv || readBootstrap().dbUrl
}
