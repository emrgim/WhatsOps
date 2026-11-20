import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'
import { upsert, upsertMany, now, type DbHandle } from '../db/index.js'

/**
 * Production auth state for Baileys, stored in the configured SQL database
 * (SQLite / PostgreSQL / MySQL), scoped per account.
 * Writes are transactional and complete before keys.set() resolves.
 */
export async function useDbAuthState(h: DbHandle, accountId: string) {
  const row = await h.db.selectFrom('auth_creds').select('data').where('account_id', '=', accountId).executeTakeFirst()
  const creds: AuthenticationCreds = row?.data ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds()

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const out: { [id: string]: SignalDataTypeMap[T] } = {}
      if (!ids.length) return out
      for (let i = 0; i < ids.length; i += 200) {
        const part = ids.slice(i, i + 200)
        const rows = await h.db
          .selectFrom('auth_keys')
          .select(['id', 'data'])
          .where('account_id', '=', accountId)
          .where('type', '=', type)
          .where('id', 'in', part)
          .execute()
        for (const r of rows) {
          let v = JSON.parse(r.data, BufferJSON.reviver)
          if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v)
          out[r.id as string] = v
        }
      }
      return out
    },
    set: async (data: SignalDataSet) => {
      const puts: Record<string, unknown>[] = []
      const dels: { type: string; id: string }[] = []
      for (const type in data) {
        const bucket = (data as Record<string, Record<string, unknown> | undefined>)[type]
        if (!bucket) continue
        for (const id in bucket) {
          const v = bucket[id]
          if (v === null || v === undefined) dels.push({ type, id })
          else puts.push({ account_id: accountId, type, id, data: JSON.stringify(v, BufferJSON.replacer) })
        }
      }
      if (!puts.length && !dels.length) return
      await h.db.transaction().execute(async (trx) => {
        const t = { ...h, db: trx }
        if (puts.length) await upsertMany(t, 'auth_keys', puts, ['account_id', 'type', 'id'], ['data'])
        for (const d of dels) {
          await trx.deleteFrom('auth_keys').where('account_id', '=', accountId).where('type', '=', d.type).where('id', '=', d.id).execute()
        }
      })
    },
    clear: async () => {
      await h.db.deleteFrom('auth_keys').where('account_id', '=', accountId).execute()
    },
  }

  const saveCreds = async () => {
    await upsert(h, 'auth_creds', { account_id: accountId, data: JSON.stringify(creds, BufferJSON.replacer), updated_at: now() }, ['account_id'])
  }

  return { state: { creds, keys }, saveCreds }
}

export async function wipeAuth(h: DbHandle, accountId: string): Promise<void> {
  await h.db.deleteFrom('auth_keys').where('account_id', '=', accountId).execute()
  await h.db.deleteFrom('auth_creds').where('account_id', '=', accountId).execute()
}

export async function hasCreds(h: DbHandle, accountId: string): Promise<{ paired: boolean; me?: { id?: string; lid?: string; name?: string } }> {
  const row = await h.db.selectFrom('auth_creds').select('data').where('account_id', '=', accountId).executeTakeFirst()
  if (!row?.data) return { paired: false }
  const c = JSON.parse(row.data, BufferJSON.reviver) as AuthenticationCreds
  return { paired: !!c.me?.id, me: c.me ?? undefined }
}
