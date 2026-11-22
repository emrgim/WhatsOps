import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb, type DbHandle } from '../src/db/index.js'
import { linkLabel, saveLabel } from '../src/wa/labels.js'
import { WaService } from '../src/wa/service.js'

const A = '971500000001'
const MARIO = '393330000001@s.whatsapp.net'
const MARIO_LID = '222222222222222@lid'
const LUCA = '393330000002@s.whatsapp.net'

describe('writing labels (Business)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-lw-'))
  let h: DbHandle
  let svc: WaService
  const calls: string[] = []
  let platform = 'smbi'
  const sock = {
    authState: { creds: { get platform() { return platform } } },
    addChatLabel: async (jid: string, id: string) => void calls.push(`add ${id} ${jid}`),
    removeChatLabel: async (jid: string, id: string) => void calls.push(`remove ${id} ${jid}`),
    addMessageLabel: async (jid: string, msg: string, id: string) => void calls.push(`add ${id} ${jid} ${msg}`),
    removeMessageLabel: async (jid: string, msg: string, id: string) => void calls.push(`remove ${id} ${jid} ${msg}`),
  }
  const lid = new Map([[MARIO_LID, MARIO]])
  const acc = {
    id: A,
    requireOpen: () => sock,
    store: {
      canonical: (j: string) => lid.get(j) ?? j,
      aliases: (j: string) => [j, ...[...lid].filter(([, p]) => p === j).map(([l]) => l)],
      nameOf: async () => null,
      phoneOf: () => null,
    },
  }
  beforeAll(async () => {
    h = await openDb(`sqlite://${path.join(tmp, 'wa.db')}`)
    await migrate(h)
    svc = new WaService(h, null as never, { get: () => ({ sendAllowlist: '' }) } as never)
    for (const [id, name] of [['20', 'Founder'], ['22', 'WhatsOps'], ['7', '\u200eFollow up']]) await saveLabel(h, A, { id, name, color: 0, deleted: false, predefinedId: id === '7' ? '7' : null })
    await linkLabel(h, A, { labelId: '22', chat: MARIO_LID }, true) // WhatsApp keeps this chat's labels under its LID
  })
  afterAll(async () => {
    await h.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('change a label: the old one is taken off under the form WhatsApp uses, the new one put on the same form', async () => {
    calls.length = 0
    const r = await svc.labelChat(acc as never, { chat: '+39 333 000 0001', add: ['founder'], remove: ['WhatsOps'] })
    expect(calls).toEqual([`remove 22 ${MARIO_LID}`, `add 20 ${MARIO_LID}`])
    expect(r).toEqual({ chat: MARIO, messageId: null, added: ['Founder'], removed: ['WhatsOps'], labels: [{ id: '20', name: 'Founder' }] })
  })

  it('a label the chat already has is not sent again; removing one it does not have sends nothing', async () => {
    await linkLabel(h, A, { labelId: '22', chat: MARIO_LID }, false)
    await linkLabel(h, A, { labelId: '20', chat: MARIO_LID }, true)
    calls.length = 0
    const r = await svc.labelChat(acc as never, { chat: MARIO, add: ['Founder'], remove: ['Follow up'] })
    expect(calls).toEqual([])
    expect(r).toMatchObject({ added: [], removed: [], labels: [{ id: '20', name: 'Founder' }] })
  })

  it('a chat without labels gets them under its phone number; a message can be labelled too', async () => {
    calls.length = 0
    await svc.labelChat(acc as never, { chat: LUCA, add: ['Follow up'] })
    await svc.labelChat(acc as never, { chat: LUCA, add: ['WhatsOps'], messageId: 'M1' })
    expect(calls).toEqual([`add 7 ${LUCA}`, `add 22 ${LUCA} M1`])
  })

  it('only on WhatsApp Business, only known labels, something to do', async () => {
    await expect(svc.labelChat(acc as never, { chat: LUCA, add: ['Nope'] })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' })
    await expect(svc.labelChat(acc as never, { chat: LUCA })).rejects.toMatchObject({ code: 'LABELS_NOTHING' })
    platform = 'iphone'
    await expect(svc.labelChat(acc as never, { chat: LUCA, add: ['Founder'] })).rejects.toMatchObject({ code: 'LABELS_BUSINESS_ONLY' })
    platform = 'smbi'
  })
})
