import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BackupService, listFolders, makeFolder, packBackup, readManifest, unpackBackup } from '../src/backup.js'
import { getSetting, migrate, openDb, setSetting, type DbHandle } from '../src/db/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-backup-'))
const folder = path.join(tmp, 'backups')
let h: DbHandle
let svc: BackupService
const calls = { stop: 0, restart: [] as string[] }

const msg = (id: string, text: string) => ({ account_id: '393331234567', chat_jid: '393330000000@s.whatsapp.net', id, from_me: 0, sender: null, ts: 1763700000, type: 'conversation', text, status: 2, raw: '{}' })
const texts = async () => ((await h.db.selectFrom('messages').select(['id', 'text']).orderBy('id').execute()) as { id: string; text: string }[]).map((r) => `${r.id}:${r.text}`)

beforeAll(async () => {
  h = await openDb(`sqlite://${path.join(tmp, 'live.db')}`)
  await migrate(h)
  await h.db.insertInto('accounts').values({ id: '393331234567', label: 'Mario', phone: '393331234567', enabled: 1, is_default: 1, created_at: 1, updated_at: 1 }).execute()
  await h.db.insertInto('messages').values([msg('A', 'ciao'), msg('B', 'arrivo alle otto')]).execute()
  await h.db.insertInto('auth_creds').values({ account_id: '393331234567', data: '{"creds":"session"}', updated_at: 1 }).execute()
  await setSetting(h, 'app', '{"appearance":"dark"}')
  await h.db.insertInto('admin_sessions').values({ id_hash: 'me-now', label: 'signed in now', created_at: 1, expires_at: Date.now() + 1e9, last_seen: 1 }).execute()
  svc = new BackupService(h, { stopAccounts: async () => void calls.stop++, restart: (r) => void calls.restart.push(r), supervised: () => true }, tmp)
  await svc.start()
  svc.stop()
})
afterAll(async () => {
  await h.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('backup', () => {
  it('settings: folder made and checked, schedule, how many to keep', async () => {
    await svc.update({ folder: folder, every: 'day', keep: 2 })
    const c = svc.publicConfig()
    expect(c).toMatchObject({ every: 'day', keep: 2, folder, passwordSet: false })
    expect(fs.existsSync(folder)).toBe(true)
    await expect(svc.update({ folder: 'relative/path' })).rejects.toMatchObject({ code: 'BACKUP_FOLDER' })
    await expect(svc.update({ password: '123' })).rejects.toMatchObject({ code: 'BACKUP_PASSWORD_SHORT' })
    expect(JSON.stringify(c)).not.toContain('password":"')
  })

  it('back up now → a file in the folder, then restore brings everything back', async () => {
    const r = await svc.backupNow('manual')
    expect(path.dirname(r.file)).toBe(folder)
    const m = readManifest(r.file)!.manifest
    expect(m).toMatchObject({ app: 'whatsops', kind: 'manual', encrypted: false, database: 'sqlite', counts: { accounts: 1, messages: 2 } })
    expect(svc.publicConfig().files.map((f) => f.name)).toEqual([path.basename(r.file)])

    // things change after the backup
    await h.db.deleteFrom('messages').where('id', '=', 'A').execute()
    await h.db.insertInto('messages').values(msg('C', 'nuovo')).execute()
    await setSetting(h, 'app', '{"appearance":"light"}')
    await h.db.insertInto('admin_sessions').values({ id_hash: 'me-later', label: 'later', created_at: 2, expires_at: Date.now() + 1e9, last_seen: 2 }).execute()
    expect(await texts()).toEqual(['B:arrivo alle otto', 'C:nuovo'])

    const res = await svc.restore(r.file, '')
    expect(await texts()).toEqual(['A:ciao', 'B:arrivo alle otto'])
    expect(await getSetting(h, 'app')).toBe('{"appearance":"dark"}')
    expect((await h.db.selectFrom('auth_creds').selectAll().execute()).length).toBe(1)
    // who is signed in now stays signed in; the backup settings of this server stay
    expect((await h.db.selectFrom('admin_sessions').select('id_hash').execute()).map((x) => x.id_hash).sort()).toEqual(['me-later', 'me-now'])
    expect(JSON.parse((await getSetting(h, 'backup'))!)).toMatchObject({ folder, every: 'day', keep: 2 })
    // a copy of the data before the restore, then a restart with the restored numbers
    expect(res.safetyCopy).toMatch(/^whatsops-before-restore-\d{8}-\d{6}(-\d+)?\.whatsops$/)
    expect(fs.existsSync(path.join(folder, res.safetyCopy))).toBe(true)
    expect(calls.stop).toBe(1)
    expect(calls.restart).toEqual(['backup restored'])
    expect(res.restarting).toBe(true)
  })

  it('password: file encrypted, wrong password refused, the saved one is used when none is given', async () => {
    await svc.update({ password: 'segreto-123' })
    expect(svc.publicConfig().passwordSet).toBe(true)
    const r = await svc.backupNow('manual')
    const m = readManifest(r.file)!.manifest
    expect(m.encrypted).toBe(true)
    // the content cannot be read without the password
    const raw = fs.readFileSync(r.file)
    expect(raw.includes(Buffer.from('SQLite format 3'))).toBe(false)
    expect(raw.includes(Buffer.from('arrivo alle otto'))).toBe(false)
    const out = path.join(tmp, 'x.db')
    await expect(unpackBackup(r.file, out, 'sbagliata')).rejects.toMatchObject({ code: 'BACKUP_PASSWORD_WRONG' })
    await expect(unpackBackup(r.file, out, '')).rejects.toMatchObject({ code: 'BACKUP_PASSWORD' })
    expect(fs.existsSync(out)).toBe(false)
    await unpackBackup(r.file, out, 'segreto-123')
    expect(fs.readFileSync(out).subarray(0, 15).toString()).toBe('SQLite format 3')
    await svc.restore(r.file, '') // saved password
    await svc.update({ removePassword: true })
    await expect(svc.restore(r.file, '')).rejects.toMatchObject({ code: 'BACKUP_PASSWORD' })
    await expect(svc.restore(r.file, 'sbagliata')).rejects.toMatchObject({ code: 'BACKUP_PASSWORD_WRONG' })
    expect(await texts()).toEqual(['A:ciao', 'B:arrivo alle otto'])
  })

  it('keeps only the last N backups (the copies made before a restore stay)', async () => {
    for (let i = 0; i < 4; i++) await svc.backupNow('auto')
    // several in the same second: every file keeps a proper name (listed and rotated)
    expect(fs.readdirSync(folder).filter((n) => !n.startsWith('.')).every((n) => /^whatsops-(backup|before-restore)-\d{8}-\d{6}(-\d+)?\.whatsops$/.test(n))).toBe(true)
    const files = svc.publicConfig().files
    expect(files.filter((f) => f.name.startsWith('whatsops-backup-')).length).toBe(2)
    expect(files.some((f) => f.name.startsWith('whatsops-before-restore-'))).toBe(true)
  })

  it('schedule: due after the interval, not before', async () => {
    const before = svc.list().length
    await svc.tick() // just made one
    expect(svc.list().length).toBe(before)
    await setSetting(h, 'backup_state', JSON.stringify({ lastAt: Date.now() - 25 * 3600_000 }))
    await svc.start()
    svc.stop()
    await svc.tick()
    expect(svc.publicConfig().state.lastAt).toBeGreaterThan(Date.now() - 60_000)
    await svc.update({ every: 'off' })
    expect(svc.nextAt()).toBeNull()
  })

  it('upload: restore from the file the browser sends', async () => {
    const r = await svc.backupNow('manual')
    await h.db.deleteFrom('messages').execute()
    await svc.restoreUpload(Readable.from([fs.readFileSync(r.file)]), '')
    expect(await texts()).toEqual(['A:ciao', 'B:arrivo alle otto'])
  })

  it('refuses files that are not backups, and damaged ones', async () => {
    const junk = path.join(tmp, 'junk.whatsops')
    fs.writeFileSync(junk, 'hello')
    await expect(svc.restore(junk, '')).rejects.toMatchObject({ code: 'BACKUP_NOT_OURS' })
    const r = await svc.backupNow('manual')
    const cut = path.join(tmp, 'cut.whatsops')
    const b = fs.readFileSync(r.file)
    fs.writeFileSync(cut, b.subarray(0, b.length - 500))
    await expect(svc.restore(cut, '')).rejects.toMatchObject({ code: 'BACKUP_DAMAGED' })
    expect(await texts()).toEqual(['A:ciao', 'B:arrivo alle otto'])
    expect(() => svc.fileInFolder('../live.db')).toThrow()
  })

  it('older and newer backups: missing tables come empty, unknown columns are ignored', async () => {
    const old = path.join(tmp, 'old.db')
    const o = await openDb(`sqlite://${old}`)
    await o.db.schema.createTable('settings').addColumn('k', 'varchar(191)').addColumn('v', 'text').execute()
    await o.db.schema.createTable('accounts').addColumn('id', 'varchar(64)').addColumn('label', 'varchar(255)').addColumn('future_col', 'text').execute()
    await o.db.insertInto('accounts').values({ id: '39300', label: 'Vecchio', future_col: 'x' }).execute()
    await o.close()
    const file = path.join(folder, 'whatsops-backup-20200101-000000.whatsops')
    await packBackup(old, file, { app: 'whatsops', format: 1, version: '0.0.0', build: 'old', createdAt: 1, kind: 'manual', database: 'sqlite', counts: {} }, '')
    await svc.restore(file, '')
    expect((await h.db.selectFrom('accounts').select(['id', 'label']).execute())).toEqual([{ id: '39300', label: 'Vecchio' }])
    expect(await texts()).toEqual([])
  })
})

describe('folder picker', () => {
  it('lists folders (no hidden ones), goes up, makes a new one', () => {
    const base = path.join(tmp, 'pick')
    fs.mkdirSync(path.join(base, 'Documenti'), { recursive: true })
    fs.mkdirSync(path.join(base, '.nascosta'))
    fs.writeFileSync(path.join(base, 'file.txt'), 'x')
    const l = listFolders(base)
    expect(l.dirs).toEqual(['Documenti'])
    expect(l.parent).toBe(tmp)
    expect(makeFolder(base, 'WhatsOps backup')).toBe(path.join(base, 'WhatsOps backup'))
    expect(listFolders(base).dirs).toEqual(['Documenti', 'WhatsOps backup'])
    expect(() => makeFolder(base, '../fuori')).toThrow()
    expect(() => listFolders(path.join(base, 'non-esiste'))).toThrow()
  })
})
