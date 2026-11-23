/**
 * Contact cards (.vcf, vCard 3.0 as macOS Contacts and iPhone write them) of a WhatsApp number, made
 * only from WhatsOps' database. What a card needs that WhatsApp does not send by itself — the profile
 * photo, the website of a business — is asked once per contact, slowly, and kept in contact_cards
 * (refreshed after CARD_REFRESH_MS). The download is offered when every contact with a phone number
 * has been checked.
 */
import { getBinaryNodeChild, getBinaryNodeChildren, type BinaryNode } from '@whiskeysockets/baileys'
import { sql } from 'kysely'
import { upsert, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import { bareJid, userOf } from '../util.js'

export const CARD_REFRESH_MS = 30 * 24 * 3600_000
/** side of the square photo kept for a card (px): sharp enough for a contact, small enough for thousands */
export const PHOTO_SIZE = 256
const BATCH = 40
const GAP_MS = 1200

export type CardContact = { jid: string; name: string | null; notify: string | null; verifiedName: string | null; photo: string | null; websites: string[] }
type CardSock = {
  profilePictureUrl(jid: string, type?: 'image' | 'preview', timeoutMs?: number): Promise<string | undefined>
  query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>
}

// ------------------------------------------------------------------ vCard text

/** vCard 3.0 text value: backslash, comma, semicolon and line breaks escaped */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
const clean = (s: string | null | undefined) => (s ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()

/** Lines longer than 75 bytes go on folded lines (CRLF + space), never cutting a letter in two. */
function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line
  const out: string[] = []
  let cur = ''
  let bytes = 0
  let limit = 75
  for (const ch of line) {
    const b = Buffer.byteLength(ch)
    if (bytes + b > limit) {
      out.push(cur)
      cur = ''
      bytes = 0
      limit = 74 // the leading space of a folded line counts
    }
    cur += ch
    bytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

/** "Gianni Bruzzese" → given Gianni, family Bruzzese (WhatsApp keeps only the full name of a contact) */
function splitName(full: string): { given: string; family: string } {
  const i = full.indexOf(' ')
  return i < 0 ? { given: full, family: '' } : { given: full.slice(0, i), family: full.slice(i + 1).trim() }
}

/** The display name a card gets: address book name, else the business name, else the WhatsApp name, else the number. */
export function cardName(c: Pick<CardContact, 'jid' | 'name' | 'notify' | 'verifiedName'>): string {
  return clean(c.name) || clean(c.verifiedName) || clean(c.notify) || '+' + userOf(c.jid)
}

/** One contact card. */
export function vcard(c: CardContact): string {
  const phone = userOf(c.jid).replace(/\D/g, '')
  const person = clean(c.name) || (!clean(c.verifiedName) ? clean(c.notify) : '')
  const company = clean(c.verifiedName)
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//WhatsOps//Contacts//EN']
  if (person) {
    const n = splitName(person)
    lines.push(`N:${esc(n.family)};${esc(n.given)};;;`, `FN:${esc(person)}`)
    if (company && company !== person) lines.push(`ORG:${esc(company)}`)
  } else if (company) {
    lines.push('N:;;;;', `FN:${esc(company)}`, `ORG:${esc(company)}`, 'X-ABShowAs:COMPANY')
  } else {
    lines.push('N:;;;;', `FN:+${phone}`)
  }
  lines.push(`TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}`)
  for (const w of c.websites) if (w.trim()) lines.push(`URL;type=WORK:${w.replace(/[\r\n]/g, '').trim()}`)
  if (c.photo) lines.push(`PHOTO;ENCODING=b;TYPE=JPEG:${c.photo}`)
  lines.push('END:VCARD')
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** Every card in one file, in name order (macOS Contacts imports them all at once). */
export function vcardFile(list: CardContact[]): string {
  return [...list].sort((a, b) => cardName(a).localeCompare(cardName(b))).map(vcard).join('')
}

// ------------------------------------------------------------------ what is in the database

/** Contacts that get a card: with a phone number, not the number itself. */
function cardContacts(h: DbHandle, accountId: string, meJid: string) {
  return h.db
    .selectFrom('contacts as k')
    .where('k.account_id', '=', accountId)
    .where('k.jid', 'like', '%@s.whatsapp.net')
    .where('k.jid', '!=', bareJid(meJid))
}

/** How many contacts get a card, how many are ready (photo and website checked), how many are in the address book. */
export async function cardProgress(h: DbHandle, accountId: string, meJid: string): Promise<{ total: number; done: number; addressBook: number }> {
  const r = await cardContacts(h, accountId, meJid)
    .leftJoin('contact_cards as c', (j) => j.onRef('c.account_id', '=', 'k.account_id').onRef('c.jid', '=', 'k.jid'))
    .select([
      sql<number>`count(*)`.as('total'),
      sql<number>`sum(case when c.checked_at is not null then 1 else 0 end)`.as('done'),
      sql<number>`sum(case when k.name is not null and k.name <> '' then 1 else 0 end)`.as('book'),
    ])
    .executeTakeFirst()
  return { total: Number(r?.total ?? 0), done: Number(r?.done ?? 0), addressBook: Number(r?.book ?? 0) }
}

/** Contacts never checked, then those checked longer ago than CARD_REFRESH_MS. */
async function pendingCards(h: DbHandle, accountId: string, meJid: string, limit: number): Promise<string[]> {
  const rows = await cardContacts(h, accountId, meJid)
    .leftJoin('contact_cards as c', (j) => j.onRef('c.account_id', '=', 'k.account_id').onRef('c.jid', '=', 'k.jid'))
    .select(['k.jid as jid', 'c.checked_at as checked'])
    .where((eb) => eb.or([eb('c.checked_at', 'is', null), eb('c.checked_at', '<', Date.now() - CARD_REFRESH_MS)]))
    .orderBy(sql`coalesce(c.checked_at, 0)`)
    .orderBy('k.jid')
    .limit(limit)
    .execute()
  return rows.map((r) => r.jid as string)
}

/** The cards of a number, from the database only. */
export async function loadCards(h: DbHandle, accountId: string, meJid: string, only?: 'addressbook'): Promise<CardContact[]> {
  let q = cardContacts(h, accountId, meJid)
    .leftJoin('contact_cards as c', (j) => j.onRef('c.account_id', '=', 'k.account_id').onRef('c.jid', '=', 'k.jid'))
    .select(['k.jid as jid', 'k.name as name', 'k.notify as notify', 'k.verified_name as verifiedName', 'c.photo as photo', 'c.websites as websites'])
  if (only === 'addressbook') q = q.where('k.name', 'is not', null).where('k.name', '!=', '')
  const rows = await q.execute()
  return rows.map((r) => ({
    jid: r.jid as string,
    name: (r.name as string | null) ?? null,
    notify: (r.notify as string | null) ?? null,
    verifiedName: (r.verifiedName as string | null) ?? null,
    photo: (r.photo as string | null) || null,
    websites: r.websites ? (JSON.parse(r.websites as string) as string[]) : [],
  }))
}

// ------------------------------------------------------------------ asking WhatsApp, once per contact

/** The code of a WhatsApp error: Baileys puts it in data (401 hidden, 404 none, 429 too many); the HTTP-like status otherwise. */
function statusOf(e: unknown): number | undefined {
  const d = (e as { data?: unknown })?.data
  if (typeof d === 'number' && d) return d
  const o = (e as { output?: { statusCode?: number } })?.output?.statusCode
  return o && o !== 500 ? o : undefined
}
const isLimit = (e: unknown) => statusOf(e) === 429 || /rate-overlimit/i.test(String((e as Error)?.message ?? e))

/** Business profiles in an answer of WhatsApp: jid → its websites (all of them). */
export function parseBusinessProfiles(node: BinaryNode): Map<string, { websites: string[] }> {
  const out = new Map<string, { websites: string[] }>()
  const bp = getBinaryNodeChild(node, 'business_profile')
  for (const p of bp ? getBinaryNodeChildren(bp, 'profile') : []) {
    const jid = p.attrs?.jid
    if (!jid) continue
    const websites = getBinaryNodeChildren(p, 'website').map((w) => (w.content ? Buffer.from(w.content as Uint8Array).toString('utf8').trim() : '')).filter(Boolean)
    out.set(bareJid(jid), { websites })
  }
  return out
}

const bizQuery = (jids: string[]): BinaryNode => ({
  tag: 'iq',
  attrs: { to: 's.whatsapp.net', xmlns: 'w:biz', type: 'get' },
  content: [{ tag: 'business_profile', attrs: { v: '244' }, content: jids.map((jid) => ({ tag: 'profile', attrs: { jid } })) }],
})

/** Business profiles of many contacts in one question; one by one if WhatsApp does not take the batch. */
async function businessProfiles(sock: CardSock, jids: string[]): Promise<Map<string, { websites: string[] }>> {
  try {
    return parseBusinessProfiles(await sock.query(bizQuery(jids), 30_000))
  } catch (e) {
    if (isLimit(e)) throw e
    logger.debug({ err: String(e) }, 'business profiles: batch refused, asking one by one')
  }
  const out = new Map<string, { websites: string[] }>()
  for (const jid of jids) {
    try {
      for (const [k, v] of parseBusinessProfiles(await sock.query(bizQuery([jid]), 20_000))) out.set(k, v)
    } catch (e) {
      if (isLimit(e)) throw e
    }
  }
  return out
}

/** A photo made small (PHOTO_SIZE square JPEG); the original if it cannot be resized. */
async function shrink(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default
    return await sharp(buf).resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'cover' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
  } catch {
    return buf
  }
}

type PhotoResult = { state: 'photo' | 'none' | 'hidden' | 'error'; data?: string }

async function fetchPhoto(sock: CardSock, jid: string, get: typeof fetch): Promise<PhotoResult> {
  let url: string | undefined
  try {
    url = await sock.profilePictureUrl(jid, 'image', 15_000)
  } catch (e) {
    if (isLimit(e)) throw e
    const code = statusOf(e)
    return { state: code === 401 || code === 403 ? 'hidden' : code === 404 ? 'none' : 'error' }
  }
  if (!url) return { state: 'none' }
  try {
    const r = await get(url, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return { state: 'error' }
    return { state: 'photo', data: (await shrink(Buffer.from(await r.arrayBuffer()))).toString('base64') }
  } catch {
    return { state: 'error' }
  }
}

/**
 * Check the contacts that still need it: business websites in batches, then each photo, one contact
 * every gapMs. Stops at once when WhatsApp says to slow down (limited) or the connection goes (alive).
 */
export async function collectCards(d: { h: DbHandle; accountId: string; meJid: string; sock: CardSock; alive: () => boolean; fetch?: typeof fetch; gapMs?: number; batch?: number }): Promise<{ checked: number; limited: boolean }> {
  const get = d.fetch ?? fetch
  const gap = d.gapMs ?? GAP_MS
  let checked = 0
  for (;;) {
    if (!d.alive()) return { checked, limited: false }
    const jids = await pendingCards(d.h, d.accountId, d.meJid, d.batch ?? BATCH)
    if (!jids.length) return { checked, limited: false }
    let biz: Map<string, { websites: string[] }>
    try {
      biz = await businessProfiles(d.sock, jids)
    } catch (e) {
      if (isLimit(e)) return { checked, limited: true }
      biz = new Map()
    }
    for (const jid of jids) {
      if (!d.alive()) return { checked, limited: false }
      let p: PhotoResult
      try {
        p = await fetchPhoto(d.sock, jid, get)
      } catch {
        return { checked, limited: true }
      }
      const b = biz.get(jid)
      await upsert(
        d.h,
        'contact_cards',
        { account_id: d.accountId, jid, photo: p.data ?? null, websites: b?.websites.length ? JSON.stringify(b.websites) : null, business: b ? 1 : 0, state: p.state, checked_at: Date.now() },
        ['account_id', 'jid'],
      )
      checked++
      if (gap) await new Promise((r) => setTimeout(r, gap))
    }
  }
}
