import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import pg from 'pg'
import mysql from 'mysql2'
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql, type RawBuilder } from 'kysely'
import { logger } from '../log.js'

// pg returns int8 as string by default; our bigint columns are epoch ms / seconds.
pg.types.setTypeParser(20, (v: string) => Number(v))

export type DialectName = 'sqlite' | 'postgres' | 'mysql'
// Tables are dynamic across three dialects; we keep row typing at the call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = Kysely<any>

export type DbHandle = {
  db: DB
  dialect: DialectName
  url: string
  close: () => Promise<void>
}

export function parseDbUrl(url: string): { dialect: DialectName; target: string } {
  const u = url.trim()
  if (/^postgres(ql)?:\/\//i.test(u)) return { dialect: 'postgres', target: u }
  if (/^(mysql|mariadb):\/\//i.test(u)) return { dialect: 'mysql', target: u.replace(/^mariadb:/i, 'mysql:') }
  if (/^sqlite:\/\//i.test(u)) return { dialect: 'sqlite', target: u.replace(/^sqlite:\/\//i, '') }
  if (u.startsWith('/') || u.endsWith('.db') || u.endsWith('.sqlite')) return { dialect: 'sqlite', target: u }
  throw new Error('Unsupported database URL. Use sqlite:///path/file.db, postgres://… or mysql://…')
}

/** Hide credentials when showing a DB URL to a human. */
export function maskDbUrl(url: string): string {
  try {
    const { dialect, target } = parseDbUrl(url)
    if (dialect === 'sqlite') return `sqlite://${target}`
    const p = new URL(target)
    if (p.password) p.password = '***'
    return p.toString()
  } catch {
    return '(invalid)'
  }
}

export async function openDb(url: string): Promise<DbHandle> {
  const { dialect, target } = parseDbUrl(url)
  if (dialect === 'sqlite') {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const sq = new Database(target)
    sq.pragma('journal_mode = WAL')
    sq.pragma('busy_timeout = 5000')
    sq.pragma('synchronous = NORMAL')
    try { fs.chmodSync(target, 0o600) } catch { /* ignore */ }
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sq }) })
    return { db, dialect, url, close: () => db.destroy() }
  }
  if (dialect === 'postgres') {
    const pool = new pg.Pool({ connectionString: target, max: 10, connectionTimeoutMillis: 8000 })
    const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
    return { db, dialect, url, close: () => db.destroy() }
  }
  const pool = mysql.createPool({
    uri: target,
    connectionLimit: 10,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectTimeout: 8000,
  })
  const db = new Kysely<any>({ dialect: new MysqlDialect({ pool }) })
  return { db, dialect, url, close: () => db.destroy() }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

type ColType = 'id' | 'key' | 'short' | 'name' | 'long' | 'int' | 'big' | 'url'

function colType(d: DialectName, t: ColType): string | RawBuilder<unknown> {
  switch (t) {
    case 'id': return 'varchar(64)'
    case 'key': return 'varchar(191)'
    case 'short': return 'varchar(32)'
    case 'name': return 'varchar(255)'
    case 'url': return d === 'mysql' ? sql`text` : 'text'
    case 'long': return d === 'mysql' ? sql`longtext` : 'text'
    case 'int': return 'integer'
    case 'big': return 'bigint'
  }
}

type TableDef = {
  name: string
  cols: [string, ColType, ('notnull' | 'unique')?][]
  pk: string[]
  indexes?: [string, string[]][]
}

export const TABLES: TableDef[] = [
  { name: 'meta', cols: [['k', 'key', 'notnull'], ['v', 'long']], pk: ['k'] },
  { name: 'settings', cols: [['k', 'key', 'notnull'], ['v', 'long']], pk: ['k'] },
  {
    name: 'accounts',
    cols: [
      ['id', 'id', 'notnull'], ['label', 'name'], ['phone', 'short'], ['browser', 'name'],
      ['enabled', 'int'], ['sync_history', 'int'], ['is_default', 'int'],
      ['me_jid', 'key'], ['me_lid', 'key'], ['me_name', 'name'], ['status', 'short'],
      ['created_at', 'big'], ['updated_at', 'big'],
    ],
    pk: ['id'],
  },
  // plugin Current RMS: discussions ⇄ WhatsApp groups
  {
    name: 'crms_discussions',
    cols: [
      ['id', 'id', 'notnull'], ['subject', 'name'], ['object_type', 'short'], ['object_id', 'id'], ['object_name', 'name'], ['participants', 'long'],
      ['reply_count', 'int'], ['last_comment_id', 'big'], ['last_at', 'big'], ['sync', 'int'], ['state', 'short'], ['group_jid', 'key'], ['error', 'long'],
      ['synced_comment_id', 'big'], ['created_at', 'big'], ['owner_member_id', 'id'], ['admins', 'long'], ['auto_at', 'big'], ['rms_created_at', 'big'],
    ],
    pk: ['id'],
  },
  // WhatsOps users besides the owner (granular permissions, sign-in with a code on their own WhatsApp)
  {
    name: 'users',
    cols: [
      ['id', 'id', 'notnull'], ['name', 'name'], ['phone', 'short'], ['perms', 'long'], ['active', 'int'], ['source', 'key'],
      ['created_at', 'big'], ['last_login', 'big'],
    ],
    pk: ['id'],
  },
  // Current RMS users and the WhatsApp number they registered with their personal invite link
  {
    name: 'crms_users',
    cols: [
      ['member_id', 'id', 'notnull'], ['name', 'name'], ['email', 'name'], ['phone', 'short'], ['verified_at', 'big'],
      ['invite_hash', 'key'], ['invite_expires', 'big'], ['code_hash', 'key'], ['code_phone', 'short'], ['code_expires', 'big'],
      ['code_tries', 'int'], ['sends', 'long'], ['created_at', 'big'],
    ],
    pk: ['member_id'],
  },
  // plugin Rentman: projects (list, statuses, last snapshot) and their WhatsApp groups
  {
    name: 'rm_projects',
    cols: [
      ['id', 'id', 'notnull'], ['name', 'name'], ['number', 'short'], ['creator', 'id'], ['start_at', 'big'], ['end_at', 'big'], ['location', 'name'],
      ['statuses', 'long'], ['rms_created', 'big'], ['seen_at', 'big'], ['sync', 'int'], ['state', 'short'], ['error', 'long'], ['mode', 'short'],
      ['auto_at', 'big'], ['off_hand', 'int'], ['snap', 'long'], ['community_jid', 'key'], ['synced_at', 'big'], ['created_at', 'big'],
    ],
    pk: ['id'],
  },
  {
    name: 'rm_groups',
    cols: [
      ['key', 'key', 'notnull'], ['project_id', 'id'], ['kind', 'short'], ['ref_id', 'id'], ['name', 'name'], ['group_jid', 'key'], ['state', 'short'],
      ['error', 'long'], ['members', 'long'], ['failed', 'long'], ['admins', 'long'], ['card', 'long'], ['created_at', 'big'], ['updated_at', 'big'],
    ],
    pk: ['key'],
  },
  // a record (opportunity, product…): its Community and its own group (level 1 of "what to sync")
  {
    name: 'crms_objects',
    cols: [
      ['key', 'key', 'notnull'], ['community_jid', 'key'], ['name', 'name'], ['created_at', 'big'], ['object_type', 'short'], ['object_id', 'id'],
      ['group_jid', 'key'], ['sync', 'int'], ['state', 'short'], ['error', 'long'], ['owner_member_id', 'id'], ['admins', 'long'], ['participants', 'long'],
      ['auto_at', 'big'], ['rms_created_at', 'big'],
    ],
    pk: ['key'],
  },
  {
    name: 'crms_map',
    cols: [['discussion_id', 'id', 'notnull'], ['comment_id', 'id', 'notnull'], ['wa_id', 'id', 'notnull'], ['dir', 'short'], ['at', 'big']],
    pk: ['discussion_id', 'comment_id', 'wa_id'],
  },
  {
    name: 'profiles',
    cols: [['account_id', 'id', 'notnull'], ['about', 'long'], ['photo', 'long'], ['photo_type', 'short'], ['updated_at', 'big']],
    pk: ['account_id'],
  },
  { name: 'auth_creds', cols: [['account_id', 'id', 'notnull'], ['data', 'long'], ['updated_at', 'big']], pk: ['account_id'] },
  {
    name: 'auth_keys',
    cols: [['account_id', 'id', 'notnull'], ['type', 'id', 'notnull'], ['id', 'key', 'notnull'], ['data', 'long']],
    pk: ['account_id', 'type', 'id'],
  },
  {
    name: 'chats',
    cols: [
      ['account_id', 'id', 'notnull'], ['jid', 'key', 'notnull'], ['name', 'name'], ['is_group', 'int'],
      ['unread', 'int'], ['last_ts', 'big'], ['archived', 'int'], ['pinned', 'int'], ['data', 'long'],
    ],
    pk: ['account_id', 'jid'],
    indexes: [['chats_last_ts', ['account_id', 'last_ts']]],
  },
  {
    name: 'contacts',
    cols: [
      ['account_id', 'id', 'notnull'], ['jid', 'key', 'notnull'], ['pn', 'key'], ['lid', 'key'],
      ['name', 'name'], ['notify', 'name'], ['verified_name', 'name'], ['data', 'long'],
    ],
    pk: ['account_id', 'jid'],
  },
  {
    name: 'lid_map',
    cols: [['account_id', 'id', 'notnull'], ['lid', 'key', 'notnull'], ['pn', 'key', 'notnull']],
    pk: ['account_id', 'lid'],
    indexes: [['lid_map_pn', ['account_id', 'pn']]],
  },
  {
    name: 'wa_groups',
    cols: [['account_id', 'id', 'notnull'], ['jid', 'key', 'notnull'], ['subject', 'name'], ['data', 'long'], ['updated_at', 'big']],
    pk: ['account_id', 'jid'],
  },
  {
    name: 'messages',
    cols: [
      ['account_id', 'id', 'notnull'], ['chat_jid', 'key', 'notnull'], ['id', 'key', 'notnull'], ['from_me', 'int'],
      ['sender', 'key'], ['ts', 'big'], ['type', 'id'], ['text', 'long'], ['status', 'int'], ['raw', 'long'],
    ],
    pk: ['account_id', 'chat_jid', 'id'],
    indexes: [['messages_chat_ts', ['account_id', 'chat_jid', 'ts']], ['messages_ts', ['account_id', 'ts']], ['messages_id', ['account_id', 'id']]],
  },
  {
    name: 'outbox',
    cols: [
      ['account_id', 'id', 'notnull'], ['idem_key', 'key', 'notnull'], ['chat_jid', 'key'], ['state', 'short'],
      ['msg_id', 'key'], ['error', 'url'], ['created_at', 'big'], ['updated_at', 'big'],
    ],
    pk: ['account_id', 'idem_key'],
  },
  {
    name: 'api_keys',
    cols: [
      ['id', 'id', 'notnull'], ['name', 'name'], ['prefix', 'short'], ['hash', 'key', 'unique'], ['scopes', 'name'],
      ['accounts', 'url'], ['created_at', 'big'], ['last_used', 'big'], ['revoked', 'int'],
    ],
    pk: ['id'],
  },
  {
    name: 'webhooks',
    cols: [
      ['id', 'id', 'notnull'], ['url', 'url'], ['events', 'url'], ['account_id', 'id'], ['secret', 'name'],
      ['active', 'int'], ['created_at', 'big'], ['headers', 'url'],
    ],
    pk: ['id'],
  },
  {
    name: 'webhook_deliveries',
    cols: [
      ['id', 'id', 'notnull'], ['webhook_id', 'id'], ['event', 'id'], ['state', 'short'], ['attempts', 'int'],
      ['last_status', 'int'], ['last_error', 'url'], ['created_at', 'big'], ['updated_at', 'big'],
    ],
    pk: ['id'],
    indexes: [['webhook_deliveries_created', ['created_at']]],
  },
  {
    name: 'admin_sessions',
    cols: [['id_hash', 'key', 'notnull'], ['label', 'name'], ['created_at', 'big'], ['expires_at', 'big'], ['last_seen', 'big'], ['user_id', 'id']],
    pk: ['id_hash'],
  },
  {
    name: 'login_tokens',
    cols: [['hash', 'key', 'notnull'], ['kind', 'short'], ['created_at', 'big'], ['expires_at', 'big'], ['used', 'int']],
    pk: ['hash'],
  },
  {
    name: 'oauth_clients',
    cols: [
      ['client_id', 'key', 'notnull'], ['secret_hash', 'key'], ['name', 'name'], ['redirect_uris', 'long'],
      ['auth_method', 'short'], ['grant_types', 'name'], ['created_at', 'big'],
    ],
    pk: ['client_id'],
  },
  {
    name: 'oauth_codes',
    cols: [
      ['code_hash', 'key', 'notnull'], ['client_id', 'key'], ['challenge', 'name'], ['redirect_uri', 'url'],
      ['scopes', 'name'], ['resource', 'url'], ['expires_at', 'big'],
    ],
    pk: ['code_hash'],
  },
  {
    name: 'oauth_tokens',
    cols: [
      ['token_hash', 'key', 'notnull'], ['kind', 'short'], ['client_id', 'key'], ['scopes', 'name'], ['resource', 'url'],
      ['family', 'id'], ['created_at', 'big'], ['expires_at', 'big'], ['last_used', 'big'],
    ],
    pk: ['token_hash'],
    indexes: [['oauth_tokens_family', ['family']]],
  },
]

const SCHEMA_VERSION = 1

export async function migrate(h: DbHandle): Promise<void> {
  const { db, dialect } = h
  for (const t of TABLES) {
    let b = db.schema.createTable(t.name).ifNotExists()
    for (const [name, type, mod] of t.cols) {
      b = b.addColumn(name, colType(dialect, type) as any, (c) => {
        let cc = c
        if (mod === 'notnull') cc = cc.notNull()
        if (mod === 'unique') cc = cc.unique()
        return cc
      })
    }
    b = b.addPrimaryKeyConstraint(`${t.name}_pk`, t.pk as any)
    if (dialect === 'mysql') b = b.modifyEnd(sql`DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await b.execute()
  }
  // columns added in later versions to tables that already exist
  const existing = await db.introspection.getTables()
  for (const t of TABLES) {
    const have = existing.find((x) => x.name === t.name)
    if (!have) continue
    for (const [name, type] of t.cols) {
      if (have.columns.some((c) => c.name === name)) continue
      await db.schema.alterTable(t.name).addColumn(name, colType(dialect, type) as any).execute()
      logger.info({ table: t.name, column: name }, 'database column added')
    }
  }
  const row = await db.selectFrom('meta').select('v').where('k', '=', 'schema_version').executeTakeFirst()
  if (!row) {
    for (const t of TABLES) {
      for (const [idx, cols] of t.indexes ?? []) {
        try {
          await db.schema.createIndex(idx).on(t.name).columns(cols).execute()
        } catch (e) {
          // index may already exist (e.g. re-run after partial failure)
          logger.debug({ idx, err: String(e) }, 'index create skipped')
        }
      }
    }
    await db.insertInto('meta').values({ k: 'schema_version', v: String(SCHEMA_VERSION) }).execute()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const now = (): number => Date.now()

/** Insert-or-update rows sharing the same column set. */
export async function upsertMany(
  h: DbHandle,
  table: string,
  rows: Record<string, unknown>[],
  keyCols: string[],
  updateCols?: string[],
): Promise<void> {
  if (!rows.length) return
  const cols = updateCols ?? Object.keys(rows[0]).filter((c) => !keyCols.includes(c))
  const chunk = 300
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk)
    if (h.dialect === 'mysql') {
      if (!cols.length) {
        await h.db.insertInto(table).ignore().values(part).execute()
      } else {
        const set: Record<string, unknown> = {}
        for (const c of cols) set[c] = sql`VALUES(${sql.ref(c)})`
        await h.db.insertInto(table).values(part).onDuplicateKeyUpdate(set as any).execute()
      }
    } else {
      await h.db
        .insertInto(table)
        .values(part)
        .onConflict((oc: any) => {
          const target = oc.columns(keyCols)
          if (!cols.length) return target.doNothing()
          const set: Record<string, unknown> = {}
          for (const c of cols) set[c] = sql.ref(`excluded.${c}`)
          return target.doUpdateSet(set)
        })
        .execute()
    }
  }
}

export async function upsert(h: DbHandle, table: string, row: Record<string, unknown>, keyCols: string[], updateCols?: string[]) {
  return upsertMany(h, table, [row], keyCols, updateCols)
}

export async function getSetting(h: DbHandle, k: string): Promise<string | undefined> {
  const r = await h.db.selectFrom('settings').select('v').where('k', '=', k).executeTakeFirst()
  return r?.v ?? undefined
}

export async function setSetting(h: DbHandle, k: string, v: string): Promise<void> {
  await upsert(h, 'settings', { k, v }, ['k'])
}

/** Copy every table from one database to another (used when the user moves the DB). */
export async function copyAll(src: DbHandle, dst: DbHandle, onProgress?: (table: string, n: number) => void): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const t of TABLES) {
    if (t.name === 'meta') continue
    let offset = 0
    let total = 0
    const page = 500
    // order by primary key for stable paging
    for (;;) {
      let q = src.db.selectFrom(t.name).selectAll()
      for (const c of t.pk) q = q.orderBy(c)
      const rows = await q.limit(page).offset(offset).execute()
      if (!rows.length) break
      await upsertMany(dst, t.name, rows as Record<string, unknown>[], t.pk)
      total += rows.length
      offset += rows.length
      onProgress?.(t.name, total)
      if (rows.length < page) break
    }
    counts[t.name] = total
  }
  return counts
}

export async function pingDb(h: DbHandle): Promise<void> {
  await sql`select 1`.execute(h.db)
}
