import { now, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import { AppError, slugify } from '../util.js'
import { WaAccount, type AccountRow, type Ctx } from './account.js'
import { wipeAuth } from './auth.js'

const DATA_TABLES = ['auth_keys', 'auth_creds', 'messages', 'chats', 'contacts', 'lid_map', 'wa_groups', 'outbox']

export class AccountManager {
  readonly accounts = new Map<string, WaAccount>()

  constructor(private ctx: Ctx) {}

  get h(): DbHandle {
    return this.ctx.h
  }

  async loadAll(): Promise<void> {
    const rows = (await this.h.db.selectFrom('accounts').selectAll().orderBy('created_at').execute()) as AccountRow[]
    for (const r of rows) {
      const acc = new WaAccount(r, this.ctx)
      this.accounts.set(r.id, acc)
    }
    for (const acc of this.accounts.values()) {
      if (!acc.row.enabled) {
        acc.state = 'stopped'
        continue
      }
      acc.start().catch((e) => logger.error({ account: acc.id, err: String(e) }, 'account start failed'))
    }
  }

  list(): WaAccount[] {
    return [...this.accounts.values()]
  }

  /** Get an account by id, phone or label; default account when omitted. */
  get(idOrPhone?: string | null): WaAccount {
    if (!idOrPhone) {
      const list = this.list()
      const def = list.find((a) => a.row.is_default) ?? list.find((a) => a.state === 'open') ?? list[0]
      if (!def) throw new AppError('NO_ACCOUNT', 'No WhatsApp number is configured yet. Add one in the config page.', 404)
      return def
    }
    const k = String(idOrPhone).trim()
    const direct = this.accounts.get(k)
    if (direct) return direct
    const d = k.replace(/\D+/g, '')
    for (const a of this.accounts.values()) {
      if (d && (a.row.phone === d || (a.row.me_jid ?? '').startsWith(d + ':') || (a.row.me_jid ?? '').startsWith(d + '@'))) return a
      if (a.row.label && a.row.label.toLowerCase() === k.toLowerCase()) return a
    }
    throw new AppError('ACCOUNT_NOT_FOUND', 'WhatsApp account "{0}" not found', 404, [k])
  }

  async create(input: { id?: string; label?: string; phone?: string; syncHistory?: boolean; browser?: [string, string, string] }): Promise<WaAccount> {
    let id = slugify(input.id || input.label || input.phone || 'account')
    const base = id
    let i = 2
    while (this.accounts.has(id)) id = `${base}-${i++}`
    const isFirst = this.accounts.size === 0
    const row: AccountRow = {
      id,
      label: input.label?.trim() || id,
      phone: input.phone ? input.phone.replace(/\D+/g, '') : null,
      // 'Mac OS' is refused at registration (428) by WhatsApp today; a custom name + 'Desktop' works and keeps full-history sync
      browser: JSON.stringify(input.browser ?? [`WhatsOps ${id}`.slice(0, 40), 'Desktop', '1.0']),
      enabled: 1,
      sync_history: input.syncHistory === false ? 0 : 1,
      is_default: isFirst ? 1 : 0,
      me_jid: null,
      me_lid: null,
      me_name: null,
      status: 'not_linked',
      created_at: now(),
      updated_at: now(),
    }
    await this.h.db.insertInto('accounts').values(row).execute()
    const acc = new WaAccount(row, this.ctx)
    acc.state = 'not_linked'
    this.accounts.set(id, acc)
    this.ctx.bus.publish('connection.update', id, { state: 'not_linked', created: true })
    return acc
  }

  async update(id: string, patch: { label?: string; enabled?: boolean; syncHistory?: boolean; isDefault?: boolean; browser?: [string, string, string] }): Promise<WaAccount> {
    const acc = this.get(id)
    const set: Record<string, unknown> = { updated_at: now() }
    if (patch.label !== undefined) set.label = patch.label.trim() || acc.id
    if (patch.syncHistory !== undefined) set.sync_history = patch.syncHistory ? 1 : 0
    if (patch.browser) set.browser = JSON.stringify(patch.browser)
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.isDefault) {
      await this.h.db.updateTable('accounts').set({ is_default: 0 }).execute()
      set.is_default = 1
      for (const a of this.accounts.values()) a.row.is_default = 0
    }
    await this.h.db.updateTable('accounts').set(set).where('id', '=', acc.id).execute()
    Object.assign(acc.row, set)
    if (patch.enabled === false) await acc.stop()
    if (patch.enabled === true && ['stopped', 'error', 'replaced'].includes(acc.state)) await acc.start()
    return acc
  }

  async remove(id: string, purge = true): Promise<void> {
    const acc = this.get(id)
    await acc.stop(false)
    if (purge) {
      for (const t of DATA_TABLES) await this.h.db.deleteFrom(t).where('account_id', '=', acc.id).execute()
    } else {
      await wipeAuth(this.h, acc.id)
    }
    await this.h.db.deleteFrom('accounts').where('id', '=', acc.id).execute()
    this.accounts.delete(acc.id)
    if (acc.row.is_default) {
      const next = this.list()[0]
      if (next) await this.update(next.id, { isDefault: true })
    }
    this.ctx.bus.publish('connection.update', acc.id, { state: 'deleted' })
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.stop(false).catch(() => undefined)))
  }
}
