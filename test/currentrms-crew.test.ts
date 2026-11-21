import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('Current RMS: crew of the services', () => {
  it('members allocated to services, nested in the items or at the top, without duplicates', () => {
    const o = {
      opportunity_items: [
        { item_type: 'Service', item_assets: [{ stock_level_member_id: 3, status_name: 'Allocated' }, { stock_level_member_id: 9, status_name: 'Confirmed' }] },
        { item_type: 'Product', item_assets: [{ stock_level_member_id: null, stock_level: { member_id: null } }] },
      ],
      item_assets: [{ stock_level_member_id: 3 }, { stock_level: { member_id: 12 } }],
    }
    expect(crewOf(o).sort((a, b) => a - b)).toEqual([3, 9, 12])
  })
  it('declined or cancelled bookings are not crew', () => {
    expect(crewOf({ item_assets: [{ stock_level_member_id: 4, status_name: 'Declined' }, { stock_level_member_id: 5, status_name: 'Cancelled' }, { stock_level_member_id: 6, status_name: 'Reserved' }] })).toEqual([6])
  })
  it('no items, no crew', () => {
    expect(crewOf({})).toEqual([])
    expect(crewOf({ opportunity_items: 'x', item_assets: null })).toEqual([])
  })
})

// ---- the opportunity group against a fake Current RMS and a fake WhatsApp
const ME = '971500000001'
const MEMBERS: Record<number, { name: string; membership_type: string; whatsapp?: string }> = {
  1: { name: 'Olivia Owner', membership_type: 'User', whatsapp: '+39 333 000 0001' },
  2: { name: 'Paolo Participant', membership_type: 'Contact', whatsapp: '+39 333 000 0002' },
  3: { name: 'Carla Crew', membership_type: 'Contact', whatsapp: '+39 333 000 0003' },
  4: { name: 'Dario Declined', membership_type: 'Contact', whatsapp: '+39 333 000 0004' },
  5: { name: 'Elena Later', membership_type: 'Contact', whatsapp: '+39 333 000 0005' },
  6: { name: 'Van 1', membership_type: 'Vehicle' },
  8: { name: 'Franco Afteroff', membership_type: 'Contact', whatsapp: '+39 333 000 0008' },
}
const crew: Record<string, { stock_level_member_id: number; status_name: string }[]> = {
  '7': [
    { stock_level_member_id: 3, status_name: 'Allocated' },
    { stock_level_member_id: 4, status_name: 'Declined' },
    { stock_level_member_id: 6, status_name: 'Allocated' },
  ],
  '17': [{ stock_level_member_id: 3, status_name: 'Allocated' }],
}
const memberJson = (id: number) => ({ id, name: MEMBERS[id].name, membership_type: MEMBERS[id].membership_type, active: true, custom_fields: { whatsapp: MEMBERS[id].whatsapp ?? '' } })

function startMock(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const send = (j: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(j))
    }
    const opp = u.pathname.match(/^\/opportunities\/(\d+)$/)
    if (opp) {
      const id = opp[1]
      const o: Record<string, unknown> = { id: Number(id), subject: id === '7' ? 'Jazz Night' : 'Gala', owned_by: 1, participants: [{ member_id: 2 }], created_at: '2026-11-01T10:00:00Z' }
      // the crew only comes with include[]=item_assets, like the real API
      if (u.searchParams.getAll('include[]').includes('item_assets')) o.opportunity_items = [{ id: 70, item_type: 'Service', item_assets: crew[id] ?? [] }, { id: 71, item_type: 'Product', item_assets: [{ stock_level_member_id: null }] }]
      return send({ opportunity: o })
    }
    if (u.pathname === '/members') {
      const ids = u.searchParams.getAll('q[id_in][]').map(Number)
      const users = u.searchParams.get('q[membership_type_eq]') === 'User'
      const list = Object.keys(MEMBERS)
        .map(Number)
        .filter((id) => (ids.length ? ids.includes(id) : true) && (!users || MEMBERS[id].membership_type === 'User'))
        .map(memberJson)
      return send({ members: list, meta: { total_row_count: list.length } })
    }
    res.statusCode = 404
    send({ error: `not mocked: ${u.pathname}` })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })))
}

// the plugin reads its API address when the module loads: start the fake Current RMS first
const mock = await startMock()
process.env.WA_CRMS_API = `http://127.0.0.1:${mock.port}`
const { crewOf, CurrentRmsPlugin } = await import('../src/plugins/currentrms.js')

function fakeWhatsApp() {
  type Part = { id: string; admin?: string | null }
  const groups = new Map<string, { subject: string; parts: Part[] }>()
  let n = 0
  const sock = {
    groupCreate: async (subject: string) => {
      const id = `g${++n}@g.us`
      groups.set(id, { subject, parts: [{ id: `${ME}@s.whatsapp.net`, admin: 'superadmin' }] })
      return { id }
    },
    groupUpdateDescription: async () => undefined,
    groupMemberAddMode: async () => undefined,
    groupJoinApprovalMode: async () => undefined,
    groupSettingUpdate: async () => undefined,
    groupInviteCode: async () => 'INVITE',
    groupMetadata: async (id: string) => ({ id, participants: groups.get(id)?.parts ?? [] }),
    groupParticipantsUpdate: async (id: string, jids: string[], action: string) => {
      const g = groups.get(id)!
      return jids.map((jid) => {
        if (action === 'add' && !g.parts.some((p) => p.id === jid)) g.parts.push({ id: jid, admin: null })
        if (action === 'promote') for (const p of g.parts) if (p.id === jid) p.admin = 'admin'
        return { status: '200', jid }
      })
    },
  }
  const acc = { row: { id: ME, me_jid: `${ME}:5@s.whatsapp.net`, phone: ME }, state: 'open', requireOpen: () => sock, sendRaw: async () => ({ key: { id: 'm1' } }) }
  return { acc, groups }
}

describe('Current RMS plugin: crew of the services in the opportunity group', () => {
  let pl: import('../src/plugins/currentrms.js').CurrentRmsPlugin
  let wa: ReturnType<typeof fakeWhatsApp>
  let h: import('../src/db/index.js').DbHandle
  const people = (subject: string) =>
    [...wa.groups.values()]
      .find((g) => g.subject.includes(subject))
      ?.parts.map((p) => p.id.split('@')[0])
      .filter((p) => p !== ME)
      .sort()
  const groupOn = async (key: string) => {
    for (let i = 0; i < 100; i++) {
      const r = (await h.db.selectFrom('crms_objects').select(['state', 'error']).where('key', '=', key).executeTakeFirst()) as { state: string; error: string | null } | undefined
      if (r?.state === 'on') return
      if (r?.state === 'error') throw new Error(String(r.error))
      await new Promise((ok) => setTimeout(ok, 30))
    }
    throw new Error(`${key} never got its group`)
  }

  beforeAll(async () => {
    const { openDb, migrate } = await import('../src/db/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-crew-'))
    h = await openDb(`sqlite://${path.join(dir, 't.db')}`)
    await migrate(h)
    wa = fakeWhatsApp()
    const app = { h, accounts: { get: () => wa.acc }, bus: { on: () => undefined } } as unknown as import('../src/app.js').App
    pl = new CurrentRmsPlugin(app)
    await pl.start()
    await pl.updateConfig({ subdomain: 'acme', apiKey: 'k', account: ME, mode: 'groups', whatsappField: 'whatsapp' })
  })
  afterAll(() => mock.server.close())

  it('off by default: the group gets the participants of the opportunity, not the crew', async () => {
    expect(pl.publicConfig().crewFromServices).toBe(false)
    await pl.setObjectGroup('Opportunity', '17', true)
    await groupOn('Opportunity:17')
    expect(people('Gala')).toEqual(['393330000001', '393330000002'])
  })

  it('switched on: the existing opportunity group gets its crew at once', async () => {
    await pl.updateConfig({ crewFromServices: true })
    for (let i = 0; i < 100 && people('Gala')?.length !== 3; i++) await new Promise((ok) => setTimeout(ok, 30))
    expect(people('Gala')).toEqual(['393330000001', '393330000002', '393330000003'])
  })

  it('on: a new group gets the crew allocated to services too; declined bookings and vehicles do not', async () => {
    await pl.setObjectGroup('Opportunity', '7', true)
    await groupOn('Opportunity:7')
    expect(people('Jazz Night')).toEqual(['393330000001', '393330000002', '393330000003'])
  })

  it('crew allocated later is added by the check, nobody twice', async () => {
    crew['7'].push({ stock_level_member_id: 5, status_name: 'Allocated' })
    expect(await pl.syncCrew()).toBe(1)
    expect(people('Jazz Night')).toEqual(['393330000001', '393330000002', '393330000003', '393330000005'])
    expect(await pl.syncCrew()).toBe(0)
  })

  it('off again: nobody else is added, nobody is removed', async () => {
    await pl.updateConfig({ crewFromServices: false })
    crew['7'].push({ stock_level_member_id: 8, status_name: 'Allocated' })
    expect(await pl.syncCrew()).toBe(0)
    expect(people('Jazz Night')).toEqual(['393330000001', '393330000002', '393330000003', '393330000005'])
  })
})
