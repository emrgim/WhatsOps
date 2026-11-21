import { describe, expect, it } from 'vitest'
import { WaService } from '../src/wa/service.js'

const settings = { get: () => ({ sendAllowlist: '', allowColdContacts: true, maxMediaMb: 16 }) }
function fakeAccount() {
  const calls: { jid: string; content: Record<string, unknown>; opts: Record<string, unknown> }[] = []
  const acc = {
    id: '971500000001',
    store: { canonical: (j: string) => j },
    resolveRecipient: async (j: string) => j,
    requireOpen: () => ({ user: { id: '971500000001:7@s.whatsapp.net' } }),
    sendRaw: async (jid: string, content: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push({ jid, content, opts })
      return { key: { id: 'STATUS1' } }
    },
  }
  return { acc, calls }
}
const svc = new WaService(null as never, null as never, settings as never)
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64')

describe('status (stories) with a chosen audience', () => {
  it('posts an image only to the people listed, plus my own devices', async () => {
    const { acc, calls } = fakeAccount()
    const r = await svc.postStatus(acc as never, { audience: ['+39 333 000 0000'], type: 'image', base64: PNG, caption: 'ciao' })
    expect(r).toMatchObject({ id: 'STATUS1', status: 'sent', audience: ['393330000000@s.whatsapp.net'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].jid).toBe('status@broadcast')
    expect(calls[0].content).toMatchObject({ caption: 'ciao', mimetype: 'image/png' })
    expect(Buffer.isBuffer(calls[0].content.image)).toBe(true)
    expect(calls[0].opts).toEqual({ broadcast: true, statusJidList: ['393330000000@s.whatsapp.net', '971500000001@s.whatsapp.net'] })
  })

  it('a text status', async () => {
    const { acc, calls } = fakeAccount()
    await svc.postStatus(acc as never, { audience: ['393330000000'], type: 'text', text: 'Sono Gianni' })
    expect(calls[0].content).toEqual({ text: 'Sono Gianni' })
  })

  it('refuses an empty audience, a group, a text status without text', async () => {
    const { acc } = fakeAccount()
    await expect(svc.postStatus(acc as never, { audience: [], type: 'image', base64: PNG })).rejects.toMatchObject({ code: 'STATUS_AUDIENCE_REQUIRED' })
    await expect(svc.postStatus(acc as never, { audience: ['120363000000000000@g.us'], type: 'image', base64: PNG })).rejects.toMatchObject({ code: 'STATUS_AUDIENCE_GROUP' })
    await expect(svc.postStatus(acc as never, { audience: ['393330000000'], type: 'text', text: ' ' })).rejects.toMatchObject({ code: 'EMPTY_TEXT' })
  })
})
