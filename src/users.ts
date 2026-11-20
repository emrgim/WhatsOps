/**
 * WhatsOps users (besides the owner, who has full access).
 *
 * A user signs in with a code sent to their own WhatsApp number and sees only what their
 * permissions allow. Default: nothing. Today the permissions cover plugins: which plugins
 * the user sees and, per plugin, what they can do there (e.g. Current RMS: only the records
 * they own, or all of them; manage the plugin's connection and settings or not).
 */
import crypto from 'node:crypto'
import { now, type DbHandle } from './db/index.js'
import { AppError } from './util.js'

export type PluginPerms = { access: boolean; scope: 'owned' | 'all'; manage: boolean }
export type Perms = { plugins: Record<string, PluginPerms> }
export type User = {
  id: string
  name: string
  phone: string | null
  perms: Perms
  active: boolean
  /** where the user comes from, e.g. `currentrms:123` (Current RMS member id 123) */
  source: string | null
  createdAt: number
  lastLogin: number | null
}
type UserRow = { id: string; name: string | null; phone: string | null; perms: string | null; active: number | null; source: string | null; created_at: number | null; last_login: number | null }

export const phoneDigits = (s: unknown) => String(s ?? '').trim().replace(/^00/, '').replace(/\D+/g, '')

export function normPerms(p: unknown): Perms {
  const out: Perms = { plugins: {} }
  const pl = ((p as Perms | undefined)?.plugins ?? {}) as Record<string, Partial<PluginPerms>>
  for (const [k, v] of Object.entries(pl)) {
    if (!/^[a-z0-9_-]{1,40}$/.test(k) || !v || typeof v !== 'object') continue
    out.plugins[k] = { access: !!v.access, scope: v.scope === 'all' ? 'all' : 'owned', manage: !!v.manage }
  }
  return out
}

/** Can this user see the plugin? */
export const pluginAccess = (u: User | undefined | null, plugin: string): PluginPerms | null => {
  const p = u?.active ? u.perms.plugins[plugin] : undefined
  return p?.access ? p : null
}

export class Users {
  constructor(private h: DbHandle) {}

  private map(r: UserRow): User {
    let perms: Perms = { plugins: {} }
    try {
      perms = normPerms(JSON.parse(r.perms || '{}'))
    } catch {
      /* keep empty */
    }
    return { id: r.id, name: r.name ?? '', phone: r.phone, perms, active: !!r.active, source: r.source, createdAt: r.created_at ?? 0, lastLogin: r.last_login }
  }

  async list(): Promise<User[]> {
    const rows = (await this.h.db.selectFrom('users').selectAll().orderBy('name').execute()) as UserRow[]
    return rows.map((r) => this.map(r))
  }

  async get(id: string): Promise<User | null> {
    const r = (await this.h.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()) as UserRow | undefined
    return r ? this.map(r) : null
  }

  async byPhone(phone: string): Promise<User | null> {
    const d = phoneDigits(phone)
    if (!d) return null
    const r = (await this.h.db.selectFrom('users').selectAll().where('phone', '=', d).executeTakeFirst()) as UserRow | undefined
    return r ? this.map(r) : null
  }

  async bySource(source: string): Promise<User | null> {
    const r = (await this.h.db.selectFrom('users').selectAll().where('source', '=', source).executeTakeFirst()) as UserRow | undefined
    return r ? this.map(r) : null
  }

  async countActive(): Promise<number> {
    const r = await this.h.db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).where('active', '=', 1).executeTakeFirst()
    return Number(r?.n ?? 0)
  }

  private async checkPhone(phone: string | null, self?: string): Promise<string | null> {
    if (!phone) return null
    const d = phoneDigits(phone)
    if (d.length < 8 || d.length > 15) throw new AppError('INVALID_PHONE', 'Write the full number with the country code, e.g. +39 333 123 4567', 400)
    const other = await this.byPhone(d)
    if (other && other.id !== self) throw new AppError('USER_PHONE_TAKEN', 'Another user already has this number ({0})', 409, [other.name])
    return d
  }

  async create(input: { name: string; phone?: string | null; perms?: unknown; source?: string | null; active?: boolean }): Promise<User> {
    const name = String(input.name ?? '').trim().slice(0, 120)
    if (!name) throw new AppError('INVALID_NAME', 'The name is required', 400)
    const phone = await this.checkPhone(input.phone ?? null)
    const id = crypto.randomUUID()
    await this.h.db
      .insertInto('users')
      .values({ id, name, phone, perms: JSON.stringify(normPerms(input.perms)), active: input.active === false ? 0 : 1, source: input.source ?? null, created_at: now(), last_login: null })
      .execute()
    return (await this.get(id))!
  }

  async update(id: string, patch: { name?: string; phone?: string | null; perms?: unknown; active?: boolean }): Promise<User> {
    const u = await this.get(id)
    if (!u) throw new AppError('NO_USER', 'User {0} not found', 404, [id])
    const set: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 120)
      if (!name) throw new AppError('INVALID_NAME', 'The name is required', 400)
      set.name = name
    }
    if (patch.phone !== undefined) set.phone = await this.checkPhone(patch.phone, id)
    if (patch.perms !== undefined) set.perms = JSON.stringify(normPerms(patch.perms))
    if (patch.active !== undefined) set.active = patch.active ? 1 : 0
    if (Object.keys(set).length) await this.h.db.updateTable('users').set(set).where('id', '=', id).execute()
    // signed out at once when switched off or when the number changes
    if (patch.active === false || (patch.phone !== undefined && set.phone !== u.phone)) await this.signOut(id)
    return (await this.get(id))!
  }

  /** Set one plugin's permissions, keeping the others. */
  async setPluginPerms(id: string, plugin: string, p: Partial<PluginPerms>): Promise<User> {
    const u = await this.get(id)
    if (!u) throw new AppError('NO_USER', 'User {0} not found', 404, [id])
    const cur = u.perms.plugins[plugin] ?? { access: false, scope: 'owned', manage: false }
    const perms = { ...u.perms, plugins: { ...u.perms.plugins, [plugin]: { ...cur, ...p } } }
    return this.update(id, { perms })
  }

  async remove(id: string): Promise<void> {
    await this.signOut(id)
    await this.h.db.deleteFrom('users').where('id', '=', id).execute()
  }

  async signOut(id: string): Promise<void> {
    await this.h.db.deleteFrom('admin_sessions').where('user_id', '=', id).execute()
  }

  async touch(id: string): Promise<void> {
    await this.h.db.updateTable('users').set({ last_login: now() }).where('id', '=', id).execute()
  }
}
