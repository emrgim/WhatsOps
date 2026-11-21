import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS test helper
import { startRentmanMock } from './mocks/rentman.mjs'

// ---- pure helpers
describe('Rentman helpers', async () => {
  const m = await import('../src/plugins/rentman.js')
  it('phone numbers: international as is, local ones with the account country', () => {
    expect(m.normPhone('+31 6 2222 3333', '31')).toBe('31622223333')
    expect(m.normPhone('0031 6 4444 5555', '31')).toBe('31644445555')
    expect(m.normPhone('06 1111 2222', '31')).toBe('31611112222')
    expect(m.normPhone('333 123 4567', '39')).toBe('393331234567')
    expect(m.normPhone('06 1234 5678', '39')).toBe('390612345678') // Italian landline keeps its 0
    expect(m.normPhone('', '31')).toBeNull()
    expect(m.normPhone('12', '31')).toBeNull()
    expect(m.callingCode('NL')).toBe('31')
  })
  it('webhook signature: HMAC of the raw body with the token', async () => {
    const crypto = await import('node:crypto')
    const body = '{"itemType":"Project","items":[{"id":1}]}'
    const sig = crypto.createHmac('sha512', 'tok').update(body).digest('hex')
    expect(m.verifyDigest(body, `sha512=${sig}`, 'tok')).toBe(true)
    expect(m.verifyDigest(body + ' ', `sha512=${sig}`, 'tok')).toBe(false)
    expect(m.verifyDigest(body, `sha512=${sig}`, 'other')).toBe(false)
    expect(m.verifyDigest(body, undefined, 'tok')).toBe(false)
  })
  it('members: add the new ones, remove the ones taken off the planning, never admins', () => {
    expect(m.planMembers(['a', 'b'], ['b', 'c', 'd'], ['d'], true)).toEqual({ add: ['a'], remove: ['c'] })
    expect(m.planMembers(['a'], ['c'], [], false)).toEqual({ add: ['a'], remove: [] })
  })
  it('a status reached, not one the project already had', () => {
    expect(m.statusHits({ 1: '2' }, { 1: '3' }, ['3'])).toBe(true)
    expect(m.statusHits({ 1: '3' }, { 1: '3' }, ['3'])).toBe(false)
    expect(m.statusHits(null, { 1: '3' }, ['3'])).toBe(true)
    expect(m.statusHits({ 1: '2' }, { 1: '1' }, ['3'])).toBe(false)
  })
})

// ---- the whole sync against a fake Rentman and a fake WhatsApp
type Part = { id: string; admin?: string | null }
function fakeWhatsApp(me: string) {
  const groups = new Map<string, { subject: string; community?: string; parts: Part[] }>()
  const sent: { to: string; text: string }[] = []
  const log: string[] = []
  let n = 0
  const sock = {
    groupCreate: async (subject: string) => {
      const id = `g${++n}@g.us`
      groups.set(id, { subject, parts: [{ id: `${me}@s.whatsapp.net`, admin: 'superadmin' }] })
      log.push(`create ${subject}`)
      return { id }
    },
    communityCreate: async (subject: string) => {
      const id = `c${++n}@g.us`
      groups.set(id, { subject, parts: [{ id: `${me}@s.whatsapp.net`, admin: 'superadmin' }] })
      log.push(`community ${subject}`)
      return { id }
    },
    communityCreateGroup: async (subject: string, _p: string[], community: string) => {
      const id = `g${++n}@g.us`
      groups.set(id, { subject, community, parts: [{ id: `${me}@s.whatsapp.net`, admin: 'superadmin' }] })
      log.push(`create ${subject} in ${groups.get(community)?.subject}`)
      return { id }
    },
    groupUpdateDescription: async () => undefined,
    groupMemberAddMode: async () => undefined,
    groupJoinApprovalMode: async () => undefined,
    groupSettingUpdate: async () => undefined,
    communityJoinApprovalMode: async () => undefined,
    communityMemberAddMode: async () => undefined,
    groupInviteCode: async () => 'INVITE',
    groupMetadata: async (id: string) => ({ id, participants: groups.get(id)?.parts ?? [] }),
    groupParticipantsUpdate: async (id: string, jids: string[], action: string) => {
      const g = groups.get(id)!
      log.push(`${action} ${jids.map((j) => j.split('@')[0]).join(',')} @ ${g.subject}`)
      return jids.map((jid) => {
        if (action === 'add') {
          if (jid.startsWith('31644445555')) return { status: '403', jid } // privacy settings: invite link instead
          if (!g.parts.some((p) => p.id === jid)) g.parts.push({ id: jid, admin: null })
        }
        if (action === 'remove') g.parts = g.parts.filter((p) => p.id !== jid)
        if (action === 'promote') for (const p of g.parts) if (p.id === jid) p.admin = 'admin'
        return { status: '200', jid }
      })
    },
    communityParticipantsUpdate: async () => [],
  }
  const acc = {
    row: { id: me, me_jid: `${me}:5@s.whatsapp.net`, phone: me },
    state: 'open',
    requireOpen: () => sock,
    sendRaw: async (to: string, c: { text: string }) => {
      sent.push({ to, text: c.text })
      return { key: { id: `m${sent.length}` } }
    },
  }
  return { acc, groups, sent, log }
}

describe('Rentman plugin with fake Rentman + fake WhatsApp', () => {
  let mock: { server: { close: () => void }; port: number }
  let pl: import('../src/plugins/rentman.js').RentmanPlugin
  let wa: ReturnType<typeof fakeWhatsApp>
  let base = ''
  const ctl = (p: string) => fetch(`${base}${p}`).then((r) => r.json())
  const members = (subject: string) => [...wa.groups.values()].find((g) => g.subject === subject)?.parts.map((p) => `${p.id.split('@')[0]}${p.admin ? '*' : ''}`).sort()
  const textsTo = (subject: string) => {
    const id = [...wa.groups].find(([, g]) => g.subject === subject)?.[0]
    return wa.sent.filter((s) => s.to === id).map((s) => s.text)
  }

  beforeAll(async () => {
    mock = await startRentmanMock(0)
    base = `http://127.0.0.1:${mock.port}`
    process.env.WA_RENTMAN_API = base
    const { openDb, migrate } = await import('../src/db/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-rm-'))
    const h = await openDb(`sqlite://${path.join(dir, 't.db')}`)
    await migrate(h)
    const { RentmanPlugin } = await import('../src/plugins/rentman.js')
    wa = fakeWhatsApp('971500000001')
    const app = { h, accounts: { get: () => wa.acc } } as unknown as import('../src/app.js').App
    pl = new RentmanPlugin(app)
    await pl.start()
    await pl.updateConfig({ token: 'rtok' })
  })
  afterAll(() => mock.server.close())

  it('connects and reads the account and the projects', async () => {
    const t = await pl.test()
    expect(t).toMatchObject({ workspace: 'acme', countryCode: '31', timezone: 'Europe/Amsterdam' })
    await pl.refresh()
    const list = await pl.projects()
    expect(list.map((p) => p.name)).toEqual(['Jazz Festival', 'Corporate Gala', 'Product Launch'])
    expect(list[0].statuses).toEqual(['Confirmed'])
    expect(list[0].creator).toMatchObject({ name: 'Anna Planner', whatsapp: true })
  })

  it('one group per project: crew that accepted, creator admin, project card', async () => {
    await pl.setGroup('100', true)
    await pl.syncProject('100')
    const subject = 'Jazz Festival · 2026-041'
    expect(wa.log).toContain(`create ${subject}`)
    // Mario accepted (local number + country code); Luca's invitation is still open; Anna created the project → admin
    expect(members(subject)).toEqual(['31611112222', '393331234567*', '971500000001*'])
    const card = textsTo(subject)[0]
    expect(card).toContain('*Jazz Festival · 2026-041*')
    expect(card).toContain('📍 Teatro Verdi')
    expect(card).toContain('Mario Fonico — Sound engineer')
    expect(card).not.toContain('Luca')
    expect(card).not.toMatch(/\d{9,}/) // never a phone number
    const p = (await pl.projects()).find((x) => x.id === '100')!
    expect(p).toMatchObject({ sync: true, state: 'on', crew: { planned: 2, confirmed: 1 } })
  })

  it('updates: someone accepts, someone is taken off, times change', async () => {
    const subject = 'Jazz Festival · 2026-041'
    await ctl('/__accept?pc=501')
    await ctl('/__unplan?pc=500')
    await pl.poll() // the accepted invitation shows up in the "modified" feed
    await pl.syncProject('100')
    expect(members(subject)).toEqual(['31622223333', '393331234567*', '971500000001*'])
    const upd = textsTo(subject).at(-1)!
    expect(upd).toContain('🔄 *Jazz Festival · 2026-041*')
    expect(upd).toContain('➕ Luca Luci — Lighting operator')
    expect(upd).toContain('➖ Mario Fonico — Sound engineer')
    await ctl('/__time?pc=501&start=2026-12-12T11:00:00%2B01:00')
    await pl.syncProject('100')
    expect(textsTo(subject).at(-1)).toContain('🕒 Luca Luci — Lighting operator')
    const before = wa.sent.length
    await pl.syncProject('100') // nothing changed: nothing posted
    expect(wa.sent.length).toBe(before)
  })

  it('Community per project with a group per department; refused adds get the invite link', async () => {
    await pl.updateConfig({ mode: 'department' })
    await pl.setGroup('101', true)
    await pl.syncProject('101')
    expect(wa.log).toContain('community Corporate Gala · 2026-042')
    expect(wa.log).toContain('create Audio in Corporate Gala · 2026-042')
    expect(wa.log).toContain('create Lights in Corporate Gala · 2026-042')
    // Piet refuses group adds (403): he gets the link in private
    expect(wa.sent.some((s) => s.to === '31644445555@s.whatsapp.net' && s.text.includes('https://chat.whatsapp.com/INVITE'))).toBe(true)
    // Lights: Luca accepted; Sara has no invitation (and no phone)
    expect(members('Lights')).toEqual(['31622223333', '393331234567*', '971500000001*'])
    const p = (await pl.projects()).find((x) => x.id === '101')!
    expect(p.groups.map((g) => g.name).sort()).toEqual(['Audio', 'Lights'])
  })

  it('a project reaching an automatic status gets its groups by itself (not the ones already there)', async () => {
    await pl.updateConfig({ mode: 'project', autoStatuses: ['3'] })
    await pl.poll() // baseline: nothing new
    expect((await pl.projects()).find((x) => x.id === '102')).toMatchObject({ sync: false })
    await ctl('/__status?sub=203&status=3')
    await pl.poll()
    const p = (await pl.projects()).find((x) => x.id === '102')!
    expect(p).toMatchObject({ sync: true, auto: true })
    await pl.syncProject('102')
    expect(members('Product Launch · 2026-043')).toEqual(['31611112222', '393331234567*', '971500000001*'])
  })

  it('switched off by hand: groups stay, nothing changes any more', async () => {
    await pl.setGroup('102', false)
    const before = wa.log.length
    await ctl('/__unplan?pc=505')
    await pl.syncProject('102')
    expect(wa.log.length).toBe(before)
    expect((await pl.projects()).find((x) => x.id === '102')).toMatchObject({ sync: false, state: 'paused' })
  })

  it('after a restart the list still has the names (no read from Rentman needed)', async () => {
    const { RentmanPlugin } = await import('../src/plugins/rentman.js')
    const again = new RentmanPlugin((pl as unknown as { app: import('../src/app.js').App }).app)
    await again.start()
    await ctl('/__calls')
    const p = (await again.projects()).find((x) => x.id === '100')!
    expect(p.statuses).toEqual(['Confirmed'])
    expect(p.creator).toMatchObject({ name: 'Anna Planner', whatsapp: true })
    expect(await ctl('/__calls')).toEqual([])
  })

  it('webhooks: a planning change is traced back to its project', async () => {
    await ctl('/__accept?pc=503')
    await pl.onHook({ account: 'acme', itemType: 'ProjectCrew', eventType: 'update', items: [{ id: 503, ref: '/projectcrew/503', parent: null }] })
    await new Promise((r) => setTimeout(r, 3500))
    // Sara accepted but has no phone number: listed, nobody added
    const p = (await pl.projects()).find((x) => x.id === '101')!
    expect(p.crew?.noPhone).toEqual(['Sara Video'])
  })
})
