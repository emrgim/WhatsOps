import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb, type DbHandle } from '../src/db/index.js'
import { describeEvent } from '../src/events.js'
import { labelLinks, linkLabel, listLabels, pickLabel, saveLabel } from '../src/wa/labels.js'
import { WaService } from '../src/wa/service.js'

const A = '971500000001'
const MARIO = '393330000001@s.whatsapp.net'
const LUCA = '393330000002@s.whatsapp.net'
const LUCA_LID = '111111111111111@lid'
const GROUP = '120363000000000000@g.us'

describe('labels', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-labels-'))
  let h: DbHandle
  beforeAll(async () => {
    h = await openDb(`sqlite://${path.join(tmp, 'wa.db')}`)
    await migrate(h)
  })
  afterAll(async () => {
    await h.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a label is saved, renamed, deleted; changed tells whether something changed', async () => {
    expect(await saveLabel(h, A, { id: '1', name: 'New customer', color: 0, deleted: false, predefinedId: '1' })).toBe(true)
    expect(await saveLabel(h, A, { id: '1', name: 'New customer', color: 0, deleted: false, predefinedId: '1' })).toBe(false)
    expect(await saveLabel(h, A, { id: '2', name: 'Paid', color: 4, deleted: false })).toBe(true)
    expect(await saveLabel(h, A, { id: '3', name: 'Old', color: 7, deleted: false })).toBe(true)
    expect(await saveLabel(h, A, { id: '3', name: 'Old', color: 7, deleted: true })).toBe(true)
    expect(await saveLabel(h, A, { id: '1', name: 'Nuovo cliente', color: 0, deleted: false, predefinedId: '1' })).toBe(true)
  })

  it('chats and messages get and lose labels; the same link twice changes nothing', async () => {
    expect(await linkLabel(h, A, { labelId: '2', chat: MARIO }, true)).toBe(true)
    expect(await linkLabel(h, A, { labelId: '2', chat: MARIO }, true)).toBe(false)
    expect(await linkLabel(h, A, { labelId: '2', chat: LUCA_LID }, true)).toBe(true)
    expect(await linkLabel(h, A, { labelId: '1', chat: GROUP }, true)).toBe(true)
    expect(await linkLabel(h, A, { labelId: '1', chat: MARIO, messageId: 'M1' }, true)).toBe(true)
    expect(await linkLabel(h, A, { labelId: '1', chat: GROUP }, false)).toBe(true)
    expect(await linkLabel(h, A, { labelId: '1', chat: GROUP }, false)).toBe(false)
    expect(await labelLinks(h, A, '2')).toEqual([
      { labelId: '2', chat: LUCA_LID, messageId: null },
      { labelId: '2', chat: MARIO, messageId: null },
    ])
  })

  it('lists the labels in use order with how many chats and messages have them; deleted ones are hidden', async () => {
    expect(await listLabels(h, A)).toEqual([
      { id: '1', name: 'Nuovo cliente', color: 0, predefinedId: '1', chats: 0, messages: 1 },
      { id: '2', name: 'Paid', color: 4, predefinedId: null, chats: 2, messages: 0 },
    ])
    expect(await listLabels(h, 'other')).toEqual([])
  })

  it('names written by WhatsApp lose their invisible mark; its own filters (Unread, Favorites, Groups) are not labels', async () => {
    await saveLabel(h, 'biz', { id: '7', name: '\u200eFollow up', color: 12, deleted: false, predefinedId: '7' })
    await saveLabel(h, 'biz', { id: '12', name: '\u200eUnread', color: 0, deleted: false })
    await saveLabel(h, 'biz', { id: '13', name: '\u200eFavorites', color: 0, deleted: false })
    await saveLabel(h, 'biz', { id: '22', name: 'WhatsOps', color: 0, deleted: false })
    const list = await listLabels(h, 'biz')
    expect(list.map((l) => l.name)).toEqual(['Follow up', 'WhatsOps'])
    expect(pickLabel(list, 'follow up').id).toBe('7')
  })

  it('a label is picked by id or by name, not caring about case', async () => {
    const all = await listLabels(h, A)
    expect(pickLabel(all, '2').name).toBe('Paid')
    expect(pickLabel(all, 'paid').id).toBe('2')
    expect(() => pickLabel(all, 'Nope')).toThrow(/Nuovo cliente, Paid/)
  })

  it('chats list: labels on each chat, filter by label (also a chat stored under its LID)', async () => {
    for (const [jid, name, ts] of [
      [MARIO, 'Mario', 300],
      [LUCA, 'Luca', 200],
      [GROUP, 'Crew', 100],
    ] as const)
      await h.db.insertInto('chats').values({ account_id: A, jid, name, is_group: jid === GROUP ? 1 : 0, unread: 0, last_ts: ts }).execute()
    const lid = new Map([[LUCA_LID, LUCA]])
    const acc = {
      id: A,
      store: {
        canonical: (j: string) => lid.get(j) ?? j,
        aliases: (j: string) => [j, ...[...lid].filter(([, p]) => p === j).map(([l]) => l)],
        nameOf: async (j: string) => ({ [MARIO]: 'Mario', [LUCA]: 'Luca' })[j] ?? null,
        phoneOf: (j: string) => (j.endsWith('@s.whatsapp.net') ? '+' + j.split('@')[0] : null),
        loadRow: async () => undefined,
      },
    }
    const svc = new WaService(h, null as never, null as never)
    const all = await svc.listChats(acc as never, {})
    expect(all.map((c) => [c.name, c.labels.map((l) => l.name)])).toEqual([
      ['Mario', ['Paid']],
      ['Luca', ['Paid']],
      ['Crew', []],
    ])
    expect((await svc.listChats(acc as never, { label: 'Paid' })).map((c) => c.name)).toEqual(['Mario', 'Luca'])
    expect(await svc.listChats(acc as never, { label: '1' })).toEqual([])
    const one = await svc.labels(acc as never, 'paid')
    expect(one.label).toMatchObject({ id: '2', name: 'Paid', chats: 2 })
    expect(one.chats.map((c) => [c.jid, c.name, c.phone])).toEqual([
      [LUCA, 'Luca', '+393330000002'],
      [MARIO, 'Mario', '+393330000001'],
    ])
    const first = await svc.labels(acc as never, 'Nuovo cliente')
    expect(first.messages).toEqual([{ chat: MARIO, chatName: 'Mario', id: 'M1', message: null }])
    expect((await svc.labels(acc as never)).labels).toHaveLength(2)
  })

  it('webhook context line for a label put on a chat', () => {
    expect(describeEvent({ type: 'label.update', account: A, data: { action: 'add', label: { id: '2', name: 'Paid' }, chat: MARIO, chatName: 'Mario', chatPhone: '+393330000001' } })).toBe('Label "Paid" put on the chat Mario +393330000001 on +971500000001')
    expect(describeEvent({ type: 'label.update', account: A, data: { action: 'remove', label: { id: '2', name: 'Paid' }, chat: GROUP, chatName: 'Crew', messageId: 'M9' } })).toBe('Label "Paid" taken off a message in the chat Crew on +971500000001')
    expect(describeEvent({ type: 'label.update', account: A, data: { action: 'edit', label: { id: '2', name: 'Pagato' } } })).toBe('Label "Pagato" created or changed on +971500000001')
    expect(describeEvent({ type: 'label.update', account: A, data: { action: 'delete', label: { id: '2', name: 'Pagato' } } })).toBe('Label "Pagato" deleted on +971500000001')
  })
})
