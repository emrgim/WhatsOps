import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openDb, type DbHandle } from '../src/db/index.js'
import { cardProgress, collectCards, PACE, parseBusinessProfiles, vcard, vcardFile } from '../src/wa/contact-cards.js'
import { WaService } from '../src/wa/service.js'

const A = '971500000001'
const ME = '971500000001@s.whatsapp.net'
const GIANNI = '393330000001@s.whatsapp.net'
const SHOP = '393330000002@s.whatsapp.net'
const NICK = '393330000003@s.whatsapp.net'
const BARE = '393330000004@s.whatsapp.net'
const LID = '222222222222222@lid'

const unfold = (s: string) => s.replace(/\r\n /g, '')

describe('vCard text', () => {
  it('a person of the address book: name and surname, WhatsApp number, website, photo; lines folded for macOS', () => {
    const photo = Buffer.alloc(300, 7).toString('base64')
    const v = vcard({ jid: GIANNI, name: 'Gianni Bruzzese', notify: 'Gianni', verifiedName: null, photo, websites: ['https://example.com/gianni'] })
    expect(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true)
    expect(v.endsWith('END:VCARD\r\n')).toBe(true)
    for (const line of v.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    const u = unfold(v)
    expect(u).toContain('\r\nN:Bruzzese;Gianni;;;\r\n')
    expect(u).toContain('\r\nFN:Gianni Bruzzese\r\n')
    expect(u).toContain('\r\nTEL;type=CELL;type=VOICE;waid=393330000001:+393330000001\r\n')
    expect(u).toContain('\r\nURL;type=WORK:https://example.com/gianni\r\n')
    expect(u).toContain(`\r\nPHOTO;ENCODING=b;TYPE=JPEG:${photo}\r\n`)
  })

  it('a business known only by its WhatsApp name is a company card', () => {
    const u = unfold(vcard({ jid: SHOP, name: null, notify: 'Shop', verifiedName: 'SLS Production, Equipments; LLC', photo: null, websites: [] }))
    expect(u).toContain('\r\nN:;;;;\r\n')
    expect(u).toContain('\r\nFN:SLS Production\\, Equipments\\; LLC\r\n')
    expect(u).toContain('\r\nORG:SLS Production\\, Equipments\\; LLC\r\n')
    expect(u).toContain('\r\nX-ABShowAs:COMPANY\r\n')
    expect(u).not.toContain('PHOTO')
  })

  it('without an address book name: the WhatsApp name, else the number; a long name folds without breaking a letter', () => {
    expect(unfold(vcard({ jid: NICK, name: null, notify: 'Zoë', verifiedName: null, photo: null, websites: [] }))).toContain('\r\nN:;Zoë;;;\r\nFN:Zoë\r\n')
    expect(unfold(vcard({ jid: BARE, name: null, notify: null, verifiedName: null, photo: null, websites: [] }))).toContain('\r\nFN:+393330000004\r\n')
    const long = 'Ä'.repeat(60)
    const v = vcard({ jid: NICK, name: long, notify: null, verifiedName: null, photo: null, websites: [] })
    for (const line of v.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
      expect(line).not.toContain('\uFFFD')
    }
    expect(unfold(v)).toContain(`FN:${long}`)
  })

  it('one file with every card, in name order', () => {
    const f = vcardFile([
      { jid: NICK, name: 'Zeno Rossi', notify: null, verifiedName: null, photo: null, websites: [] },
      { jid: GIANNI, name: 'Anna Bianchi', notify: null, verifiedName: null, photo: null, websites: [] },
    ])
    expect(f.match(/BEGIN:VCARD/g)).toHaveLength(2)
    expect(f.indexOf('Anna Bianchi')).toBeLessThan(f.indexOf('Zeno Rossi'))
  })
})

describe('pace', () => {
  it('asks WhatsApp slowly and never at a steady beat', () => {
    const gaps = Array.from({ length: 500 }, PACE.gap)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5_000)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15_000)
    expect(new Set(gaps).size).toBeGreaterThan(100)
    const rests = Array.from({ length: 200 }, PACE.rest)
    expect(Math.min(...rests)).toBeGreaterThanOrEqual(120_000)
    expect(Math.max(...rests)).toBeLessThanOrEqual(360_000)
    const every = Array.from({ length: 200 }, PACE.restEvery)
    expect(Math.min(...every)).toBeGreaterThanOrEqual(40)
    expect(Math.max(...every)).toBeLessThanOrEqual(80)
  })
})

describe('business profiles', () => {
  it('reads every profile of the answer, with all its websites', () => {
    const node = {
      tag: 'iq',
      attrs: {},
      content: [
        {
          tag: 'business_profile',
          attrs: {},
          content: [
            { tag: 'profile', attrs: { jid: SHOP }, content: [{ tag: 'website', attrs: {}, content: Buffer.from('https://shop.example') }, { tag: 'website', attrs: {}, content: Buffer.from('https://shop.example/2') }, { tag: 'email', attrs: {}, content: Buffer.from('a@shop.example') }] },
            { tag: 'profile', attrs: { jid: GIANNI }, content: [] },
          ],
        },
      ],
    }
    const m = parseBusinessProfiles(node as never)
    expect(m.get(SHOP)).toEqual({ websites: ['https://shop.example', 'https://shop.example/2'] })
    expect(m.get(GIANNI)).toEqual({ websites: [] })
  })
})

describe('contact cards from the database', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cards-'))
  let h: DbHandle
  let jpeg: Buffer
  beforeAll(async () => {
    h = await openDb(`sqlite://${path.join(tmp, 'wa.db')}`)
    await migrate(h)
    jpeg = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#3366aa' } }).jpeg().toBuffer()
    const c = (jid: string, name: string | null, notify: string | null, verified: string | null = null) => ({ account_id: A, jid, pn: jid.endsWith('@lid') ? null : jid, lid: null, name, notify, verified_name: verified, data: '{}' })
    await h.db.insertInto('contacts').values([c(ME, null, 'Me'), c(GIANNI, 'Gianni Bruzzese', 'Gianni'), c(SHOP, null, 'Shop', 'SLS LLC'), c(NICK, null, 'Zoë'), c(LID, null, 'Lid only')]).execute()
  })
  afterAll(async () => {
    await h.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function fakeSock(opts: { limitedAt?: string } = {}) {
    const asked: string[] = []
    const sock = {
      profilePictureUrl: async (jid: string, type: string) => {
        asked.push(`${type}:${jid}`)
        if (jid === opts.limitedAt) throw Object.assign(new Error('rate-overlimit'), { output: { statusCode: 429 } })
        if (jid === GIANNI) return 'https://pps.example/gianni.jpg'
        if (jid === SHOP) throw Object.assign(new Error('not-authorized'), { output: { statusCode: 401 } })
        throw Object.assign(new Error('item-not-found'), { output: { statusCode: 404 } })
      },
      query: async (node: { content: { content: { attrs: { jid: string } }[] }[] }) => {
        const jids = node.content[0].content.map((p) => p.attrs.jid)
        return { tag: 'iq', attrs: {}, content: [{ tag: 'business_profile', attrs: {}, content: jids.filter((j) => j === SHOP).map((j) => ({ tag: 'profile', attrs: { jid: j }, content: [{ tag: 'website', attrs: {}, content: Buffer.from('https://sls.example') }] })) }] }
      },
    }
    return { sock, asked }
  }
  const fetchImg = async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { 'content-type': 'image/jpeg' } })

  it('counts the contacts with a phone number (not me, not LID-only) and how many are ready', async () => {
    expect(await cardProgress(h, A, ME)).toEqual({ total: 3, done: 0, addressBook: 1 })
  })

  it('a rate limit stops the round without marking the contact as done', async () => {
    const { sock } = fakeSock({ limitedAt: GIANNI })
    const r = await collectCards({ h, accountId: A, meJid: ME, sock: sock as never, alive: () => true, fetch: fetchImg, gapMs: 0 })
    expect(r.limited).toBe(true)
    const p = await cardProgress(h, A, ME)
    expect(p.done).toBeLessThan(3)
  })

  it('fetches each photo and the business websites once, then everything is ready', async () => {
    const { sock, asked } = fakeSock()
    const r = await collectCards({ h, accountId: A, meJid: ME, sock: sock as never, alive: () => true, fetch: fetchImg, gapMs: 0 })
    expect(r.limited).toBe(false)
    expect(asked.every((x) => x.startsWith('image:'))).toBe(true)
    expect(await cardProgress(h, A, ME)).toEqual({ total: 3, done: 3, addressBook: 1 })
    const g = await h.db.selectFrom('contact_cards').selectAll().where('jid', '=', GIANNI).executeTakeFirstOrThrow()
    const meta = await sharp(Buffer.from(String(g.photo), 'base64')).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 256, 256])
    expect(await h.db.selectFrom('contact_cards').select(['state', 'websites', 'business']).where('jid', '=', SHOP).executeTakeFirstOrThrow()).toEqual({ state: 'hidden', websites: '["https://sls.example"]', business: 1 })
    // nothing left: a second round asks WhatsApp nothing
    const again = fakeSock()
    await collectCards({ h, accountId: A, meJid: ME, sock: again.sock as never, alive: () => true, fetch: fetchImg, gapMs: 0 })
    expect(again.asked).toEqual([])
  })

  it('the .vcf is made from the database only, when every contact is ready', async () => {
    const acc = { id: A, row: { me_jid: ME } }
    const svc = new WaService(h, null as never, { get: () => ({}) } as never)
    const all = await svc.contactsVcf(acc as never, {})
    expect(all.count).toBe(3)
    expect(all.body.match(/BEGIN:VCARD/g)).toHaveLength(3)
    expect(unfold(all.body)).toContain('URL;type=WORK:https://sls.example')
    expect(unfold(all.body)).toContain('PHOTO;ENCODING=b;TYPE=JPEG:')
    expect(all.body).not.toContain('Lid only')
    const book = await svc.contactsVcf(acc as never, { only: 'addressbook' })
    expect(book.count).toBe(1)
    expect(unfold(book.body)).toContain('FN:Gianni Bruzzese')

    await h.db.insertInto('contacts').values({ account_id: A, jid: BARE, pn: BARE, lid: null, name: 'Nuovo Contatto', notify: null, verified_name: null, data: '{}' }).execute()
    await expect(svc.contactsVcf(acc as never, {})).rejects.toMatchObject({ code: 'CARDS_NOT_READY' })
  })
})
