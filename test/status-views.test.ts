import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb, type DbHandle } from '../src/db/index.js'
import { describeEvent } from '../src/events.js'
import { recordStatusReceipt, saveStatus, statusFromMessage } from '../src/wa/statuses.js'
import { WaService } from '../src/wa/service.js'

const A = '971500000001'
const ME = '971500000001@s.whatsapp.net'
const MARIO = '393330000001@s.whatsapp.net'
const MARIO_LID = '222222222222222@lid'
const LUCA = '393330000002@s.whatsapp.net'
const ANNA = '393330000003@s.whatsapp.net'
const NAMES: Record<string, string> = { [MARIO]: 'Mario', [LUCA]: 'Luca', [ANNA]: 'Anna' }
const HOUR = 3600_000

describe('who saw my statuses', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-status-views-'))
  let h: DbHandle
  const t0 = Date.now() - 2 * HOUR
  const store = {
    canonical: (j: string) => (j === MARIO_LID ? MARIO : j),
    nameOf: async (j: string) => NAMES[j] ?? null,
    phoneOf: (j: string) => (j.endsWith('@s.whatsapp.net') ? '+' + j.split('@')[0] : null),
  }
  const acc = { id: A, store, row: { me_jid: ME, me_lid: null } }
  let svc: WaService

  beforeAll(async () => {
    h = await openDb(`sqlite://${path.join(tmp, 'wa.db')}`)
    await migrate(h)
    svc = new WaService(h, null as never, { get: () => ({}) } as never)
  })
  afterAll(async () => {
    await h.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a status of mine is kept: what it is, when, and who may see it', async () => {
    await saveStatus(h, A, { id: 'S1', ts: t0, type: 'image', text: 'Ciao a tutti', audience: [MARIO, LUCA, ANNA], source: 'whatsops' })
    // WhatsApp's echo of the same status must not lose the audience nor say it came from the phone
    await saveStatus(h, A, { id: 'S1', ts: t0 + 500, type: 'image', text: 'Ciao a tutti', source: 'phone' })
    const row = await h.db.selectFrom('statuses').selectAll().where('id', '=', 'S1').executeTakeFirstOrThrow()
    expect(row).toMatchObject({ type: 'image', text: 'Ciao a tutti', source: 'whatsops', ts: t0 })
    expect(JSON.parse(String(row.audience))).toEqual([MARIO, LUCA, ANNA])
  })

  it('reads my own statuses out of the messages WhatsApp sends, and only those', () => {
    const mine = { key: { remoteJid: 'status@broadcast', fromMe: true, id: 'P1' }, messageTimestamp: 1_800_000_000, message: { imageMessage: { caption: 'dal telefono' } } }
    expect(statusFromMessage(mine as never)).toEqual({ id: 'P1', ts: 1_800_000_000_000, type: 'image', text: 'dal telefono' })
    const text = { key: { remoteJid: 'status@broadcast', fromMe: true, id: 'P2' }, messageTimestamp: 1_800_000_000, message: { extendedTextMessage: { text: 'solo testo' } } }
    expect(statusFromMessage(text as never)).toMatchObject({ id: 'P2', type: 'text', text: 'solo testo' })
    const theirs = { ...mine, key: { ...mine.key, fromMe: false, participant: MARIO } }
    expect(statusFromMessage(theirs as never)).toBeNull()
    const chat = { ...mine, key: { ...mine.key, remoteJid: MARIO } }
    expect(statusFromMessage(chat as never)).toBeNull()
    const revoke = { key: { remoteJid: 'status@broadcast', fromMe: true, id: 'P3' }, message: { protocolMessage: { type: 0, key: { id: 'P1' } } } }
    expect(statusFromMessage(revoke as never)).toEqual({ id: 'P1', deleted: true })
  })

  it('a view counts once per person, delivered before viewed; unknown statuses and my own devices are ignored', async () => {
    expect(await recordStatusReceipt(h, A, { statusId: 'S1', viewer: LUCA, deliveredAt: t0 + 1000 })).toBe('delivered')
    expect(await recordStatusReceipt(h, A, { statusId: 'S1', viewer: LUCA, viewedAt: t0 + HOUR })).toBe('viewed')
    expect(await recordStatusReceipt(h, A, { statusId: 'S1', viewer: LUCA, viewedAt: t0 + HOUR + 5000 })).toBeNull()
    expect(await recordStatusReceipt(h, A, { statusId: 'S1', viewer: MARIO_LID, viewedAt: t0 + 60_000 })).toBe('viewed')
    // a status that is not mine (a receipt for somebody else's status that my phone opened)
    expect(await recordStatusReceipt(h, A, { statusId: 'NOT-MINE', viewer: ANNA, viewedAt: t0 })).toBeNull()
    expect(await h.db.selectFrom('status_views').select('status_id').where('status_id', '=', 'NOT-MINE').execute()).toEqual([])
  })

  it('lists my statuses with who saw them and who did not yet', async () => {
    await saveStatus(h, A, { id: 'S2', ts: t0 + 10_000, type: 'text', text: 'Secondo', audience: [MARIO, LUCA, ANNA], source: 'whatsops' })
    await recordStatusReceipt(h, A, { statusId: 'S2', viewer: MARIO, viewedAt: t0 + 2 * HOUR - 1000 })
    await saveStatus(h, A, { id: 'OLD', ts: Date.now() - 30 * HOUR, type: 'text', text: 'ieri', source: 'phone' })

    const r = await svc.statusViews(acc as never, {})
    expect(r.statuses.map((s) => s.id)).toEqual(['S2', 'S1'])
    const s1 = r.statuses.find((s) => s.id === 'S1')!
    expect(s1).toMatchObject({ type: 'image', text: 'Ciao a tutti', active: true, audience: 3, views: 2 })
    // Mario saw it under his LID: counted as Mario, with his name and number
    expect(s1.viewers).toEqual([
      { jid: MARIO, name: 'Mario', phone: '+393330000001', viewedAt: new Date(t0 + 60_000).toISOString() },
      { jid: LUCA, name: 'Luca', phone: '+393330000002', viewedAt: new Date(t0 + HOUR).toISOString() },
    ])
    expect(s1.notViewed).toEqual([{ jid: ANNA, name: 'Anna', phone: '+393330000003' }])
    // over the whole story: who saw how many of its statuses
    expect(r.people).toEqual([
      { jid: MARIO, name: 'Mario', phone: '+393330000001', saw: 2, of: 2, lastViewedAt: new Date(t0 + 2 * HOUR - 1000).toISOString() },
      { jid: LUCA, name: 'Luca', phone: '+393330000002', saw: 1, of: 2, lastViewedAt: new Date(t0 + HOUR).toISOString() },
    ])

    const old = await svc.statusViews(acc as never, { since: new Date(Date.now() - 48 * HOUR).toISOString() })
    expect(old.statuses.map((s) => s.id)).toEqual(['S2', 'S1', 'OLD'])
    expect(old.statuses.find((s) => s.id === 'OLD')).toMatchObject({ active: false, audience: null, notViewed: null })
    const one = await svc.statusViews(acc as never, { statusId: 'S2' })
    expect(one.statuses.map((s) => s.id)).toEqual(['S2'])
    await expect(svc.statusViews(acc as never, { statusId: 'NOPE' })).rejects.toMatchObject({ code: 'STATUS_NOT_FOUND' })
  })

  it('a deleted status is left out', async () => {
    await saveStatus(h, A, { id: 'S2', deleted: true })
    const r = await svc.statusViews(acc as never, {})
    expect(r.statuses.map((s) => s.id)).toEqual(['S1'])
  })

  it('the webhook line says who saw which status', () => {
    const line = describeEvent({ type: 'status.view', account: A, data: { statusId: 'S1', viewerName: 'Mario', viewerPhone: '+393330000001', statusType: 'image', statusText: 'Ciao a tutti' } })
    expect(line).toBe('Status seen on +971500000001 by Mario +393330000001 (image: Ciao a tutti)')
  })
})
