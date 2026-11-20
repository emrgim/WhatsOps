import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { BufferJSON } from '@whiskeysockets/baileys'
import { now, upsert, upsertMany, type DbHandle } from '../db/index.js'
import { AppError, bareJid, isGroupJid } from '../util.js'

// longest first so 'sender-key-memory' wins over 'sender-key'
const KEY_TYPES = ['app-state-sync-version', 'app-state-sync-key', 'sender-key-memory', 'sender-key', 'pre-key', 'session', 'lid-mapping', 'device-list', 'tctoken', 'identity-key']

/**
 * Import a Baileys multi-file auth folder (useMultiFileAuthState) into an account.
 * The source session must NOT be in use by another process, or both sockets fight.
 */
export async function importMultiFileSession(h: DbHandle, accountId: string, dir: string): Promise<{ keys: number; me: unknown }> {
  const credsFile = path.join(dir, 'creds.json')
  if (!fs.existsSync(credsFile)) throw new AppError('NO_SESSION', '{0} not found', 404, [credsFile])
  const credsRaw = fs.readFileSync(credsFile, 'utf8')
  const creds = JSON.parse(credsRaw, BufferJSON.reviver)
  if (!creds?.me?.id) throw new AppError('NOT_PAIRED', 'That session folder is not linked to a WhatsApp account', 400)
  const rows: Record<string, unknown>[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'creds.json') continue
    const base = f.slice(0, -5)
    const type = KEY_TYPES.find((t) => base.startsWith(t + '-'))
    if (!type) continue
    let id = base.slice(type.length + 1).replace(/__/g, '/')
    if (type === 'sender-key') id = id.replace(/--/g, '::')
    const data = fs.readFileSync(path.join(dir, f), 'utf8')
    // validate JSON
    JSON.parse(data, BufferJSON.reviver)
    rows.push({ account_id: accountId, type, id, data })
  }
  await h.db.transaction().execute(async (trx) => {
    const t = { ...h, db: trx }
    await trx.deleteFrom('auth_keys').where('account_id', '=', accountId).execute()
    await upsertMany(t, 'auth_keys', rows, ['account_id', 'type', 'id'], ['data'])
    await upsert(t, 'auth_creds', { account_id: accountId, data: JSON.stringify(creds, BufferJSON.replacer), updated_at: now() }, ['account_id'])
  })
  await h.db
    .updateTable('accounts')
    .set({ me_jid: creds.me.id, me_lid: creds.me.lid ?? null, me_name: creds.me.name ?? null, phone: String(creds.me.id).split(':')[0].split('@')[0], updated_at: now() })
    .where('id', '=', accountId)
    .execute()
  return { keys: rows.length, me: { id: creds.me.id, name: creds.me.name } }
}

/**
 * Import a SQLite history store (messages/chats/contacts) produced by the old
 * wa_history_harvest.mjs (raw = JSON of WAMessage) into an account.
 */
export async function importHistoryDb(h: DbHandle, accountId: string, file: string): Promise<{ messages: number; chats: number; contacts: number }> {
  if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', '{0} not found', 404, [file])
  const src = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const out = { messages: 0, chats: 0, contacts: 0 }
    const tables = new Set((src.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name))
    if (tables.has('contacts')) {
      const rows = src.prepare('select jid, name, notify from contacts').all() as { jid: string; name: string | null; notify: string | null }[]
      const mapped = rows
        .filter((r) => r.jid && !isGroupJid(r.jid))
        .map((r) => {
          const j = bareJid(r.jid)
          return { account_id: accountId, jid: j, pn: j.endsWith('@s.whatsapp.net') ? j : null, lid: j.endsWith('@lid') ? j : null, name: r.name, notify: r.notify, verified_name: null, data: '{}' }
        })
      await upsertMany(h, 'contacts', mapped, ['account_id', 'jid'], ['name', 'notify'])
      out.contacts = mapped.length
    }
    if (tables.has('chats')) {
      const rows = src.prepare('select jid, name, raw from chats').all() as { jid: string; name: string | null; raw: string | null }[]
      const mapped = rows.map((r) => {
        let ts: number | null = null
        let unread: number | null = null
        try {
          const c = JSON.parse(r.raw || '{}')
          ts = Number(c.conversationTimestamp?.low ?? c.conversationTimestamp ?? 0) || null
          unread = typeof c.unreadCount === 'number' ? c.unreadCount : null
        } catch {
          /* ignore */
        }
        return { account_id: accountId, jid: bareJid(r.jid), name: r.name, is_group: isGroupJid(r.jid) ? 1 : 0, unread, last_ts: ts, archived: 0, pinned: 0, data: '{}' }
      })
      await upsertMany(h, 'chats', mapped, ['account_id', 'jid'], ['name'])
      out.chats = mapped.length
    }
    if (tables.has('messages')) {
      const it = src.prepare('select id, chat_jid, sender, from_me, ts, type, text, raw from messages').iterate() as IterableIterator<{
        id: string
        chat_jid: string
        sender: string | null
        from_me: number
        ts: number
        type: string | null
        text: string | null
        raw: string
      }>
      let batch: Record<string, unknown>[] = []
      const flush = async () => {
        if (!batch.length) return
        await upsertMany(h, 'messages', batch, ['account_id', 'chat_jid', 'id'], [])
        out.messages += batch.length
        batch = []
      }
      for (const r of it) {
        if (!r.id || !r.chat_jid || r.chat_jid === 'status@broadcast') continue
        if (r.type && ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage'].includes(r.type)) continue
        batch.push({
          account_id: accountId,
          chat_jid: bareJid(r.chat_jid),
          id: r.id,
          from_me: r.from_me ? 1 : 0,
          sender: r.from_me ? 'me' : r.sender ? bareJid(r.sender) : bareJid(r.chat_jid),
          ts: Number(r.ts) || 0,
          type: r.type ?? 'unknown',
          text: r.text,
          status: null,
          raw: r.raw,
        })
        if (batch.length >= 500) await flush()
      }
      await flush()
    }
    // derive chat last_ts where missing
    const chats = await h.db.selectFrom('messages').select(['chat_jid']).select((eb) => eb.fn.max('ts').as('m')).where('account_id', '=', accountId).groupBy('chat_jid').execute()
    for (const c of chats) {
      await h.db
        .updateTable('chats')
        .set({ last_ts: Number(c.m) })
        .where('account_id', '=', accountId)
        .where('jid', '=', c.chat_jid)
        .where((eb) => eb.or([eb('last_ts', 'is', null), eb('last_ts', '<', Number(c.m))]))
        .execute()
    }
    return out
  } finally {
    src.close()
  }
}
