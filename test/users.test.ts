import { describe, expect, it } from 'vitest'
import { normPerms, phoneDigits, pluginAccess, type User } from '../src/users.js'
import { planAdmins } from '../src/plugins/currentrms.js'
import { requireScope } from '../src/app.js'

const user = (perms: unknown, active = true): User => ({ id: 'u1', name: 'Anna', phone: '393331234567', perms: normPerms(perms), active, source: 'currentrms:7', createdAt: 0, lastLogin: null })

describe('user permissions', () => {
  it('default is nothing', () => {
    expect(normPerms(undefined)).toEqual({ plugins: {} })
    expect(pluginAccess(user({}), 'currentrms')).toBeNull()
  })
  it('a plugin is visible only when enabled and the user is active', () => {
    expect(pluginAccess(user({ plugins: { currentrms: { access: true } } }), 'currentrms')).toEqual({ access: true, scope: 'owned', manage: false })
    expect(pluginAccess(user({ plugins: { currentrms: { access: false, scope: 'all' } } }), 'currentrms')).toBeNull()
    expect(pluginAccess(user({ plugins: { currentrms: { access: true } } }, false), 'currentrms')).toBeNull()
  })
  it('scope defaults to the records they own; junk is dropped', () => {
    expect(normPerms({ plugins: { currentrms: { access: true, scope: 'everything', manage: 'yes' }, 'bad key!': { access: true } } })).toEqual({
      plugins: { currentrms: { access: true, scope: 'owned', manage: true } },
    })
  })
  it('a signed-in user has no API scope at all', () => {
    const p = { kind: 'user' as const, id: 'u1', label: 'Anna', scopes: new Set<string>(), accounts: [] as string[] }
    for (const s of ['read', 'send', 'admin'] as const) expect(() => requireScope(p, s)).toThrow()
  })
  it('phone numbers: digits only, 00 prefix dropped', () => {
    expect(phoneDigits('+39 333 123 4567')).toBe('393331234567')
    expect(phoneDigits('0039 333-123-4567')).toBe('393331234567')
  })
})

describe('group admins', () => {
  const parts = [
    { id: '971500000001@s.whatsapp.net', admin: 'superadmin' as const },
    { id: '123456789012345@lid', phoneNumber: '393331234567@s.whatsapp.net', admin: null },
    { id: '393400000000@s.whatsapp.net', admin: 'admin' as const },
  ]
  it('promotes members that are not admin yet (matched by phone, also behind a LID)', () => {
    expect(planAdmins(parts, ['393331234567'])).toEqual({ add: [], promote: ['123456789012345@lid'] })
  })
  it('leaves admins alone and adds who is missing', () => {
    expect(planAdmins(parts, ['393400000000', '447700900000'])).toEqual({ add: ['447700900000'], promote: [] })
  })
})
