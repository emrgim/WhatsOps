import fs from 'node:fs'
import { proto } from '@whiskeysockets/baileys'
import { beforeEach, describe, expect, it } from 'vitest'
import { captureLocationKey, describeNode, isLocationFrame, probeFile, subscribeNodes, tryDecryptUpdate, trySubscribe } from '../src/wa/live-location-probe.js'

const CHAT = '393330000000@s.whatsapp.net'
const lines = () =>
  fs
    .readFileSync(probeFile(), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('live location probe', () => {
  beforeEach(() => fs.rmSync(probeFile(), { force: true }))

  it('spots live location frames and never keeps the encrypted bytes', () => {
    const update = { tag: 'message', attrs: { from: CHAT, id: 'X1', type: 'media' }, content: [{ tag: 'enc', attrs: { v: '2', type: 'frskmsg', mediatype: 'livelocation' }, content: new Uint8Array(40).fill(7) }] }
    expect(isLocationFrame(update)).toBe(true)
    const d = JSON.stringify(describeNode(update))
    expect(d).toContain('"bytes":40')
    expect(d).not.toContain('7,7')
    expect(isLocationFrame({ tag: 'notification', attrs: { type: 'location' }, content: [] })).toBe(true)
    expect(isLocationFrame({ tag: 'iq', attrs: { xmlns: 'location', type: 'set' } })).toBe(true)
    expect(isLocationFrame({ tag: 'message', attrs: {}, content: [{ tag: 'enc', attrs: { type: 'msg' }, content: new Uint8Array(3) }] })).toBe(false)
    expect(isLocationFrame({ tag: 'receipt', attrs: {} })).toBe(false)
  })

  it('three shapes of the subscribe request, the Baileys #1026 one first', () => {
    const v = subscribeNodes(CHAT)
    expect(v).toHaveLength(3)
    for (const n of v) {
      expect(n.tag).toBe('iq')
      expect(n.attrs.xmlns).toBe('location')
    }
    expect(v[0]).toEqual({ tag: 'iq', attrs: { xmlns: 'location', type: 'get', to: 's.whatsapp.net', target: CHAT }, content: [{ tag: 'subscribe', attrs: { participants: 'true' } }] })
  })

  it('tries the shapes in order, logs every answer, returns the first accepted', async () => {
    const seen: string[] = []
    const query = async (n: { attrs: Record<string, string> }) => {
      seen.push(n.attrs.to)
      if (n.attrs.target) throw Object.assign(new Error('bad-request'), { output: { statusCode: 400 }, data: 400 })
      return { tag: 'iq', attrs: { type: 'result' } }
    }
    expect(await trySubscribe(query as never, CHAT, 'acc1')).toBe(1)
    expect(seen).toEqual(['s.whatsapp.net', CHAT])
    const l = lines()
    expect(l.map((x) => [x.dir, x.variant])).toEqual([['out', 0], ['in', 0], ['out', 1], ['in', 1]])
    expect(l[1]).toMatchObject({ error: 'bad-request', status: 400, data: 400 })
    expect(l[3].result).toMatchObject({ tag: 'iq', attrs: { type: 'result' } })
  })
})

describe('location key and update decrypt', () => {
  beforeEach(() => fs.rmSync(probeFile(), { force: true }))

  it('stores a fast-ratchet key like a sender key, ignores other messages', async () => {
    const seen: unknown[] = []
    const repo = { processSenderKeyDistributionMessage: async (o: unknown) => void seen.push(o) }
    const item = { groupId: 'loc-1', axolotlSenderKeyDistributionMessage: new Uint8Array([1, 2]) }
    expect(await captureLocationKey(repo as never, { key: { remoteJid: CHAT }, message: { fastRatchetKeySenderKeyDistributionMessage: item } }, 'acc1')).toBe(true)
    expect(seen).toEqual([{ item, authorJid: CHAT }])
    expect(await captureLocationKey(repo as never, { key: { remoteJid: CHAT }, message: { conversation: 'ciao' } }, 'acc1')).toBe(false)
    expect(lines()[0]).toMatchObject({ note: 'location key stored', groupId: 'loc-1' })
  })

  it('opens an fskmsg update with the stored key and logs only its shape', async () => {
    const plain = proto.Message.encode({ liveLocationMessage: { degreesLatitude: 45.4642, degreesLongitude: 9.19, sequenceNumber: 7 } }).finish()
    const padded = new Uint8Array([...plain, 1]) // unpadRandomMax16: last byte = pad length
    const repo = {
      decryptGroupMessage: async ({ group }: { group: string }) => {
        if (group !== 'loc-1') throw new Error('No SenderKeyRecord found for decryption')
        return padded
      },
    }
    const node = { tag: 'message', attrs: { from: CHAT, id: 'U1' }, content: [{ tag: 'enc', attrs: { type: 'fskmsg' }, content: new Uint8Array(9) }] }
    expect(await tryDecryptUpdate(repo as never, node as never, 'acc1')).toBe('ok')
    const ok = lines().find((l) => l.note === 'update decrypted')
    expect(ok).toMatchObject({ enc: 'fskmsg', group: 'loc-1', sequence: '7' })
    expect(JSON.stringify(lines())).not.toContain('45.4642')
  })
})
