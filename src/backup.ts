/**
 * Backups (Settings → Backup): one file with everything WhatsOps keeps — numbers and their WhatsApp
 * sessions, messages, contacts, groups, settings, plugins, keys, webhooks, transcripts.
 *
 *  - Download now, or save into a folder of the server, by hand or every hour / day / week (keeping the last N).
 *  - Optional password: AES-256-GCM, key from scrypt. Without the password the file cannot be restored.
 *  - Restore from an uploaded file or from one in the folder: a copy of the current data is saved first,
 *    every table is replaced in one transaction, then WhatsOps restarts with the restored numbers.
 *
 * File (.whatsops):  "WOBAK1\n" · uint32 LE manifest length · manifest JSON (never secret) · payload
 *   payload = gzip(SQLite snapshot)                         (no password)
 *   payload = salt(16) · iv(12) · AES-256-GCM(gzip(SQLite)) · tag(16)   (password)
 * The SQLite snapshot works whatever database WhatsOps uses (SQLite, Postgres, MySQL): restore copies it back.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { sql } from 'kysely'
import { BUILD, config, VERSION } from './config.js'
import { copyAll, getSetting, migrate, openDb, setSetting, TABLES, upsertMany, type DbHandle } from './db/index.js'
import { logger } from './log.js'
import { AppError } from './util.js'

export type BackupEvery = 'off' | 'hour' | 'day' | 'week'
export type BackupConfig = { every: BackupEvery; folder: string; keep: number; password: string }
export type BackupState = { lastAt: number | null; lastFile: string | null; lastSize: number | null; lastError: string | null; lastErrorAt: number | null }
export type BackupKind = 'auto' | 'manual' | 'download' | 'before-restore'
export type Manifest = {
  app: 'whatsops'
  format: 1
  version: string
  build: string
  createdAt: number
  kind: BackupKind
  encrypted: boolean
  database: string
  counts: Record<string, number>
}
export type BackupFile = { name: string; size: number; createdAt: number; kind: BackupKind | null; encrypted: boolean; version: string | null; counts: Record<string, number> | null }

export const EVERY_MS: Record<Exclude<BackupEvery, 'off'>, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }
const CONFIG_KEY = 'backup'
const STATE_KEY = 'backup_state'
const MAGIC = Buffer.from('WOBAK1\n', 'latin1')
const EXT = '.whatsops'
const FILE_RE = /^whatsops-(backup|before-restore)-\d{8}-\d{6}(-\d+)?\.whatsops$/
const DEFAULT: BackupConfig = { every: 'off', folder: '', keep: 10, password: '' }
/** never replaced by a restore: who is signed in now, one-time codes, and the backup settings of this server */
const KEEP_TABLES = new Set(['meta', 'admin_sessions', 'login_tokens'])
const KEEP_SETTINGS = [CONFIG_KEY, STATE_KEY]
/** after a failed automatic backup, wait before trying again */
const RETRY_MS = 15 * 60_000
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))))
}

/** The manifest at the start of a backup file (null: not a WhatsOps backup). */
export function readManifest(file: string): { manifest: Manifest; offset: number } | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(MAGIC.length + 4)
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) return null
    const len = head.readUInt32LE(MAGIC.length)
    if (len <= 0 || len > 1_000_000) return null
    const m = Buffer.alloc(len)
    fs.readSync(fd, m, 0, len, head.length)
    const manifest = JSON.parse(m.toString('utf8')) as Manifest
    if (manifest?.app !== 'whatsops') return null
    return { manifest, offset: head.length + len }
  } catch {
    return null
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}

/** A SQLite file with the whole database → backup file (written as .part, then renamed). */
export async function packBackup(sqliteFile: string, out: string, manifest: Omit<Manifest, 'encrypted'>, password: string): Promise<number> {
  const full: Manifest = { ...manifest, encrypted: !!password }
  const m = Buffer.from(JSON.stringify(full), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(m.length)
  const part = out + '.part'
  fs.writeFileSync(part, Buffer.concat([MAGIC, len, m]), { mode: 0o600 })
  try {
    if (!password) {
      await pipeline(fs.createReadStream(sqliteFile), zlib.createGzip({ level: 6 }), fs.createWriteStream(part, { flags: 'a' }))
    } else {
      const salt = crypto.randomBytes(16)
      const iv = crypto.randomBytes(12)
      fs.appendFileSync(part, Buffer.concat([salt, iv]))
      const cipher = crypto.createCipheriv('aes-256-gcm', await deriveKey(password, salt), iv)
      await pipeline(fs.createReadStream(sqliteFile), zlib.createGzip({ level: 6 }), cipher, fs.createWriteStream(part, { flags: 'a' }))
      fs.appendFileSync(part, cipher.getAuthTag())
    }
    fs.renameSync(part, out)
    return fs.statSync(out).size
  } catch (e) {
    fs.rmSync(part, { force: true })
    throw e
  }
}

/** Backup file → SQLite file (checks the password and the file). */
export async function unpackBackup(file: string, outSqlite: string, password: string): Promise<Manifest> {
  const head = readManifest(file)
  if (!head) throw new AppError('BACKUP_NOT_OURS', 'Not a WhatsOps backup file', 400)
  const { manifest, offset } = head
  const size = fs.statSync(file).size
  try {
    if (!manifest.encrypted) {
      await pipeline(fs.createReadStream(file, { start: offset }), zlib.createGunzip(), fs.createWriteStream(outSqlite, { mode: 0o600 }))
      return manifest
    }
    if (!password) throw new AppError('BACKUP_PASSWORD', 'This backup is protected by a password: write it to restore', 400)
    if (size < offset + 16 + 12 + 16) throw new AppError('BACKUP_DAMAGED', 'The backup file is damaged', 400)
    const fd = fs.openSync(file, 'r')
    const sv = Buffer.alloc(28)
    const tag = Buffer.alloc(16)
    fs.readSync(fd, sv, 0, 28, offset)
    fs.readSync(fd, tag, 0, 16, size - 16)
    fs.closeSync(fd)
    const decipher = crypto.createDecipheriv('aes-256-gcm', await deriveKey(password, sv.subarray(0, 16)), sv.subarray(16))
    decipher.setAuthTag(tag)
    await pipeline(fs.createReadStream(file, { start: offset + 28, end: size - 17 }), decipher, zlib.createGunzip(), fs.createWriteStream(outSqlite, { mode: 0o600 }))
    return manifest
  } catch (e) {
    fs.rmSync(outSqlite, { force: true })
    if (e instanceof AppError) throw e
    // with a password, garbage comes out of a wrong key before the check fails: same answer either way
    if (manifest.encrypted) throw new AppError('BACKUP_PASSWORD_WRONG', 'Wrong password, or the file is damaged', 400)
    throw new AppError('BACKUP_DAMAGED', 'The backup file is damaged', 400)
  }
}

/** Copy every table of the backup into the live database, in one transaction (columns this version knows). */
export async function replaceAll(live: DbHandle, from: DbHandle): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const keep: Record<string, string> = {}
  for (const k of KEEP_SETTINGS) {
    const v = await getSetting(live, k)
    if (v != null) keep[k] = v
  }
  await live.db.transaction().execute(async (trx) => {
    const th: DbHandle = { ...live, db: trx }
    for (const t of TABLES) {
      if (KEEP_TABLES.has(t.name)) continue
      const cols = new Set(t.cols.map((c) => c[0]))
      await th.db.deleteFrom(t.name).execute()
      let offset = 0
      let n = 0
      for (;;) {
        let q = from.db.selectFrom(t.name).selectAll()
        for (const c of t.pk) q = q.orderBy(c)
        const rows = (await q.limit(500).offset(offset).execute()) as Record<string, unknown>[]
        if (!rows.length) break
        const clean = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => cols.has(k))))
        await upsertMany(th, t.name, clean, t.pk)
        n += rows.length
        offset += rows.length
        if (rows.length < 500) break
      }
      counts[t.name] = n
    }
    for (const [k, v] of Object.entries(keep)) await upsertMany(th, 'settings', [{ k, v }], ['k'])
  })
  return counts
}

export class BackupService {
  private cfg: BackupConfig = { ...DEFAULT }
  private st: BackupState = { lastAt: null, lastFile: null, lastSize: null, lastError: null, lastErrorAt: null }
  private timer: ReturnType<typeof setInterval> | null = null
  private busy: 'backup' | 'restore' | null = null

  constructor(
    private h: DbHandle,
    private hooks: { stopAccounts: () => Promise<void>; restart: (reason: string) => void; supervised: () => boolean },
    private tmpRoot = os.tmpdir(),
  ) {}

  async start(): Promise<void> {
    try {
      const saved = JSON.parse((await getSetting(this.h, CONFIG_KEY)) || '{}') as Partial<BackupConfig>
      this.cfg = { ...DEFAULT, ...Object.fromEntries(Object.entries(saved).filter(([k]) => k in DEFAULT)) } as BackupConfig
    } catch {
      this.cfg = { ...DEFAULT }
    }
    try {
      this.st = { ...this.st, ...(JSON.parse((await getSetting(this.h, STATE_KEY)) || '{}') as Partial<BackupState>) }
    } catch {
      /* fresh state */
    }
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The folder in use: the one chosen, else <data>/backups. */
  folder(): string {
    return this.cfg.folder || config.backupsDir
  }

  nextAt(): number | null {
    if (this.cfg.every === 'off') return null
    // never made yet: the first one right away
    const due = this.st.lastAt == null ? Date.now() : this.st.lastAt + EVERY_MS[this.cfg.every]
    const retry = this.st.lastErrorAt && this.st.lastErrorAt > (this.st.lastAt ?? 0) ? this.st.lastErrorAt + RETRY_MS : 0
    return Math.max(due, retry)
  }

  publicConfig() {
    const { password, ...rest } = this.cfg
    return {
      ...rest,
      folder: this.folder(),
      defaultFolder: config.backupsDir,
      passwordSet: !!password,
      state: { ...this.st, nextAt: this.nextAt(), busy: this.busy },
      files: this.list(),
      platform: process.platform,
      home: os.homedir(),
    }
  }

  async update(p: { every?: BackupEvery; folder?: string; keep?: number; password?: string; removePassword?: boolean }): Promise<void> {
    const next = { ...this.cfg }
    if (p.every !== undefined) {
      if (!['off', 'hour', 'day', 'week'].includes(p.every)) throw new AppError('BACKUP_EVERY', 'Choose off, every hour, every day or every week', 400)
      next.every = p.every
    }
    if (p.keep !== undefined) next.keep = Math.max(1, Math.min(1000, Math.round(Number(p.keep) || DEFAULT.keep)))
    if (p.folder !== undefined) {
      const f = String(p.folder).trim()
      if (f && !path.isAbsolute(f)) throw new AppError('BACKUP_FOLDER', 'The folder must be a full path (e.g. {0})', 400, [path.join(os.homedir(), 'WhatsOps backups')])
      if (f) checkWritable(f)
      next.folder = f && path.resolve(f) !== path.resolve(config.backupsDir) ? path.resolve(f) : ''
    }
    if (p.removePassword) next.password = ''
    else if (p.password !== undefined && String(p.password) !== '') {
      if (String(p.password).length < 6) throw new AppError('BACKUP_PASSWORD_SHORT', 'The backup password needs at least 6 characters', 400)
      next.password = String(p.password)
    }
    this.cfg = next
    await setSetting(this.h, CONFIG_KEY, JSON.stringify(next))
  }

  // ---------------------------------------------------------------- make
  /** The whole database as a SQLite file (consistent snapshot). */
  private async snapshot(out: string): Promise<Record<string, number>> {
    if (this.h.dialect === 'sqlite') {
      await sql`VACUUM INTO ${out}`.execute(this.h.db)
    } else {
      const dst = await openDb(`sqlite://${out}`)
      try {
        await migrate(dst)
        await copyAll(this.h, dst)
      } finally {
        await dst.close()
      }
    }
    const snap = await openDb(`sqlite://${out}`)
    try {
      const counts: Record<string, number> = {}
      for (const t of ['accounts', 'chats', 'contacts', 'messages', 'webhooks', 'api_keys']) {
        const r = (await snap.db.selectFrom(t).select(sql<number>`count(*)`.as('n')).executeTakeFirst()) as { n: number } | undefined
        counts[t] = Number(r?.n ?? 0)
      }
      return counts
    } finally {
      await snap.close()
      // WAL side files of the snapshot are not needed
      for (const s of ['-wal', '-shm']) fs.rmSync(out + s, { force: true })
    }
  }

  private tmpDir(): string {
    return fs.mkdtempSync(path.join(this.tmpRoot, 'whatsops-backup-'))
  }

  /** Make a backup file in `dir`. */
  async make(dir: string, kind: BackupKind): Promise<{ file: string; size: number }> {
    if (this.busy) throw new AppError('BACKUP_BUSY', 'A backup or a restore is already running', 409)
    this.busy = 'backup'
    const tmp = this.tmpDir()
    try {
      checkWritable(dir)
      const snap = path.join(tmp, 'wa.db')
      const counts = await this.snapshot(snap)
      // two in the same second: -2, -3… after the time (never in place of it)
      const base = `whatsops-${kind === 'before-restore' ? 'before-restore' : 'backup'}-${stamp()}`
      let name = base + EXT
      for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${EXT}`
      const file = path.join(dir, name)
      const size = await packBackup(snap, file, { app: 'whatsops', format: 1, version: VERSION, build: BUILD, createdAt: Date.now(), kind, database: this.h.dialect, counts }, this.cfg.password)
      logger.info({ mod: 'backup', kind, file: name, mb: +(size / 1e6).toFixed(1), encrypted: !!this.cfg.password }, `backup ${name}`)
      return { file, size }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      this.busy = null
    }
  }

  /** "Back up now" and the schedule: into the folder, then keep only the last N. */
  async backupNow(kind: 'auto' | 'manual' = 'manual'): Promise<{ file: string; size: number }> {
    try {
      const r = await this.make(this.folder(), kind)
      this.st = { ...this.st, lastAt: Date.now(), lastFile: path.basename(r.file), lastSize: r.size, lastError: null, lastErrorAt: null }
      await this.saveState()
      this.prune()
      return r
    } catch (e) {
      if ((e as AppError).code === 'BACKUP_BUSY') throw e
      this.st = { ...this.st, lastError: String((e as Error)?.message ?? e).slice(0, 300), lastErrorAt: Date.now() }
      await this.saveState()
      logger.warn({ mod: 'backup', err: this.st.lastError }, 'backup failed')
      throw e
    }
  }

  /** A fresh backup for the browser to download (temporary file; the caller deletes it). */
  async forDownload(): Promise<{ file: string; size: number; cleanup: () => void }> {
    const dir = this.tmpDir()
    try {
      const r = await this.make(dir, 'download')
      return { ...r, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw e
    }
  }

  async tick(): Promise<void> {
    if (this.cfg.every === 'off' || this.busy) return
    const next = this.nextAt()
    if (next != null && next > Date.now() + 30_000) return
    await this.backupNow('auto').catch(() => undefined)
  }

  private async saveState(): Promise<void> {
    await setSetting(this.h, STATE_KEY, JSON.stringify(this.st)).catch(() => undefined)
  }

  /** Keep the last N automatic / manual backups of the folder (the copies made before a restore stay). */
  prune(): void {
    const dir = this.folder()
    const mine = this.list().filter((f) => f.name.startsWith('whatsops-backup-'))
    for (const f of mine.slice(this.cfg.keep)) {
      try {
        fs.rmSync(path.join(dir, f.name), { force: true })
        logger.info({ mod: 'backup', file: f.name }, 'old backup removed')
      } catch {
        /* next time */
      }
    }
  }

  /** Backups in the folder, newest first. */
  list(): BackupFile[] {
    const dir = this.folder()
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n))
    } catch {
      return []
    }
    const out: BackupFile[] = []
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        const st = fs.statSync(p)
        const m = readManifest(p)?.manifest
        out.push({ name, size: st.size, createdAt: m?.createdAt ?? st.mtimeMs, kind: m?.kind ?? null, encrypted: !!m?.encrypted, version: m?.version ?? null, counts: m?.counts ?? null })
      } catch {
        /* removed meanwhile */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1))
  }

  /** Path of a backup in the folder, by name only (no other path can be asked for). */
  fileInFolder(name: string): string {
    if (!FILE_RE.test(name)) throw new AppError('BACKUP_NOT_FOUND', 'Backup not found', 404)
    const p = path.join(this.folder(), name)
    if (!fs.existsSync(p)) throw new AppError('BACKUP_NOT_FOUND', 'Backup not found', 404)
    return p
  }

  // ---------------------------------------------------------------- restore
  /**
   * Replace all of WhatsOps' data with a backup. A copy of the current data goes into the folder first.
   * Then WhatsOps restarts with the restored numbers (or asks to be restarted when nothing restarts it).
   */
  async restore(file: string, password: string): Promise<{ safetyCopy: string; restarting: boolean; manifest: Manifest; counts: Record<string, number> }> {
    if (this.busy) throw new AppError('BACKUP_BUSY', 'A backup or a restore is already running', 409)
    const tmp = this.tmpDir()
    try {
      const snap = path.join(tmp, 'restore.db')
      // the configured password is tried when none is given
      const manifest = await unpackBackup(file, snap, password || this.cfg.password)
      const from = await openDb(`sqlite://${snap}`)
      try {
        const tables = (await from.db.introspection.getTables()).map((t) => t.name)
        if (!tables.includes('settings') || !tables.includes('accounts')) throw new AppError('BACKUP_NOT_OURS', 'Not a WhatsOps backup file', 400)
        // an older backup gets today's tables and columns
        await migrate(from)
        const safety = await this.make(this.folder(), 'before-restore')
        this.busy = 'restore'
        await this.hooks.stopAccounts()
        const counts = await replaceAll(this.h, from)
        logger.info({ mod: 'backup', from: path.basename(file), made: new Date(manifest.createdAt).toISOString(), version: manifest.version, counts }, 'backup restored')
        const restarting = this.hooks.supervised()
        if (restarting) this.hooks.restart('backup restored')
        return { safetyCopy: path.basename(safety.file), restarting, manifest, counts }
      } finally {
        await from.close()
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      this.busy = null
    }
  }

  /** An uploaded file (request body) → temporary file, then restore. */
  async restoreUpload(body: Readable, password: string, maxBytes = 4 * 1024 ** 3): Promise<Awaited<ReturnType<BackupService['restore']>>> {
    const dir = this.tmpDir()
    const file = path.join(dir, 'upload' + EXT)
    try {
      let n = 0
      const limit = new Transform({
        transform(chunk: Buffer, _e, cb) {
          n += chunk.length
          if (n > maxBytes) return cb(new AppError('BACKUP_TOO_BIG', 'The file is too big', 413))
          cb(null, chunk)
        },
      })
      await pipeline(body, limit, fs.createWriteStream(file, { mode: 0o600 }))
      if (!n) throw new AppError('BACKUP_NOT_OURS', 'Not a WhatsOps backup file', 400)
      return await this.restore(file, password)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** The folder exists (created if needed) and WhatsOps can write in it. */
export function checkWritable(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.whatsops-write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
  } catch (e) {
    throw new AppError('BACKUP_FOLDER_WRITE', 'Cannot write in the folder {0}: {1}', 400, [dir, String((e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? e)])
  }
}

/** Folders of the server for the folder picker (Windows: the drives at the top). */
export function listFolders(p: string | undefined, platform: NodeJS.Platform = process.platform): { path: string; parent: string | null; dirs: string[]; roots: string[] } {
  const roots = platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => fs.existsSync(d)) : ['/']
  const target = p && p.trim() ? path.resolve(p.trim()) : os.homedir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch (e) {
    throw new AppError('BACKUP_FOLDER_MISSING', 'Folder not found: {0}', 404, [target + ` (${(e as NodeJS.ErrnoException)?.code ?? 'error'})`])
  }
  const dirs = entries
    .filter((e) => {
      if (e.name.startsWith('.') || e.name.startsWith('$')) return false
      if (e.isDirectory()) return true
      if (!e.isSymbolicLink()) return false
      try {
        return fs.statSync(path.join(target, e.name)).isDirectory()
      } catch {
        return false
      }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const parent = path.dirname(target)
  return { path: target, parent: parent === target ? null : parent, dirs, roots }
}

/** "New folder" in the folder picker. */
export function makeFolder(parent: string, name: string): string {
  const n = String(name).trim()
  if (!n || n.length > 120 || /[\\/:*?"<>|\u0000]/.test(n) || n === '.' || n === '..') throw new AppError('BACKUP_FOLDER_NAME', 'Not a valid folder name', 400)
  const p = path.join(path.resolve(parent), n)
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch (e) {
    throw new AppError('BACKUP_FOLDER_WRITE', 'Cannot write in the folder {0}: {1}', 400, [parent, String((e as NodeJS.ErrnoException)?.code ?? e)])
  }
  return p
}

/** for tests */
export const _internal = { stamp, FILE_RE, MAGIC }
