/**
 * Research probe for live locations (only with WA_LIVE_LOCATION_PROBE=1; off by default).
 *
 * The first frame of a live location is a normal message. The updates travel on a separate channel: the
 * sharer hands out a fast-ratchet "location key" and the server relays the updates (enc fskmsg/frskmsg)
 * to devices that subscribe with an IQ in the `location` namespace (WhatsApp Web does it). This probe:
 *  - subscribes to the live locations being shared, and renews every 25 s;
 *  - logs the location frames (never the encrypted bytes, only their length);
 *  - stores the location key like a normal sender key and tries to open each update with it,
 *    logging only what it is (fields, sequence), never where.
 * Output: <data>/probe/live-location.jsonl (stays on the server).
 */
import fs from 'node:fs'
import path from 'node:path'
import { proto, unpadRandomMax16, type BinaryNode, type WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import type { DbHandle } from '../db/index.js'
import { logger } from '../log.js'

export const PROBE_ON = process.env.WA_LIVE_LOCATION_PROBE === '1'
const MINUTES = Number(process.env.WA_LIVE_LOCATION_PROBE_MINUTES || 60)
const EVERY_MS = 25_000
const KNOWN_ENC = new Set(['msg', 'pkmsg', 'skmsg', 'plaintext'])

export function probeFile(): string {
  return path.join(config.dataDir, 'probe', 'live-location.jsonl')
}

export function writeProbe(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(probeFile()), { recursive: true })
    fs.appendFileSync(probeFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
  } catch (e) {
    logger.warn({ mod: 'probe', err: String(e) }, 'live location probe not written')
  }
}

/** A node without its bytes: tag, attributes, children, and the length of binary content. */
export function describeNode(n: BinaryNode | null | undefined, depth = 0): unknown {
  if (!n || typeof n !== 'object') return n ?? null
  const out: Record<string, unknown> = { tag: n.tag, attrs: n.attrs ?? {} }
  if (n.content instanceof Uint8Array) out.bytes = n.content.length
  else if (Array.isArray(n.content)) out.children = depth < 4 ? n.content.map((c) => describeNode(c, depth + 1)) : `${n.content.length} children`
  else if (typeof n.content === 'string') out.text = n.content.slice(0, 200)
  return out
}

const kids = (n: BinaryNode): BinaryNode[] => (Array.isArray(n.content) ? n.content : [])

/** Is this frame about live locations, or encrypted in a way Baileys cannot read? */
export function isLocationFrame(n: BinaryNode): boolean {
  if (n.tag === 'notification' && /location/i.test(n.attrs?.type ?? '')) return true
  if (n.tag === 'iq' && n.attrs?.xmlns === 'location') return true
  if (n.tag === 'message') {
    for (const c of kids(n)) {
      if (c.tag === 'enc' && (c.attrs?.mediatype === 'livelocation' || !KNOWN_ENC.has(c.attrs?.type ?? ''))) return true
    }
  }
  return kids(n).some((c) => /location/i.test(c.tag))
}

/** The subscribe request in the shapes seen in public research (Baileys issue #1026 first). */
export function subscribeNodes(chat: string): BinaryNode[] {
  return [
    { tag: 'iq', attrs: { xmlns: 'location', type: 'get', to: 's.whatsapp.net', target: chat }, content: [{ tag: 'subscribe', attrs: { participants: 'true' } }] },
    { tag: 'iq', attrs: { xmlns: 'location', type: 'get', to: chat }, content: [{ tag: 'subscribe', attrs: { participants: 'true' } }] },
    { tag: 'iq', attrs: { xmlns: 'location', type: 'get', to: 's.whatsapp.net' }, content: [{ tag: 'subscribe', attrs: { jid: chat, participants: 'true' } }] },
  ]
}

type Query = (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode | undefined>

/** Try each shape once; the index of the first one WhatsApp accepts, or -1. Every answer is logged. */
export async function trySubscribe(query: Query, chat: string, account: string): Promise<number> {
  const nodes = subscribeNodes(chat)
  for (let i = 0; i < nodes.length; i++) {
    const node = structuredClone(nodes[i]) // query() writes attrs.id into it
    writeProbe({ account, dir: 'out', variant: i, node: describeNode(node) })
    try {
      const res = await query(node, 15_000)
      writeProbe({ account, dir: 'in', variant: i, result: describeNode(res) })
      return i
    } catch (e) {
      const err = e as { message?: string; output?: { statusCode?: number }; data?: unknown }
      writeProbe({ account, dir: 'in', variant: i, error: err.message ?? String(e), status: err.output?.statusCode ?? null, data: err.data && typeof err.data === 'object' ? describeNode(err.data as BinaryNode) : (err.data ?? null) })
    }
  }
  return -1
}

const running = new Map<string, ReturnType<typeof setInterval>>()
/** User parts (digits) of the sharers we subscribed to: every frame that mentions them is logged (shape only). */
const watched = new Set<string>()
const userPart = (jid: string) => jid.split('@')[0].split(':')[0]
export function mentionsWatched(n: BinaryNode): boolean {
  if (!watched.size) return false
  return Object.values(n.attrs ?? {}).some((v) => typeof v === 'string' && watched.has(userPart(v)))
}

/** Subscribe to one chat (each candidate JID until one is accepted), then renew every 25 s for WA_LIVE_LOCATION_PROBE_MINUTES. */
export async function probeSubscribe(sock: Pick<WASocket, 'query' | 'ws'>, chats: string[], account: string): Promise<void> {
  const k = `${account}|${chats.join(',')}`
  if (running.has(k)) return
  let idx = -1
  let chat = ''
  for (const c of chats) {
    idx = await trySubscribe(sock.query.bind(sock) as Query, c, account)
    if (idx >= 0) {
      chat = c
      break
    }
  }
  for (const c of chats) watched.add(userPart(c))
  const targets = idx >= 0 ? [chat] : chats // no answer at all: keep sending shape 0 to every candidate, like #1026 (no wait)
  if (idx < 0) idx = 0
  writeProbe({ account, dir: 'note', note: 'subscribed', targets, variant: idx })
  const end = Date.now() + MINUTES * 60_000
  const t = setInterval(() => {
    const open = (sock.ws as { isOpen?: boolean }).isOpen !== false
    if (!open || Date.now() > end) {
      clearInterval(t)
      running.delete(k)
      return void writeProbe({ account, dir: 'note', note: 'probe subscription ended', targets })
    }
    for (const c of targets) {
      sock
        .query(structuredClone(subscribeNodes(c)[idx]), 20_000)
        .then((res) => writeProbe({ account, dir: 'in', variant: idx, target: c, renew: true, result: describeNode(res) }))
        .catch((e) => writeProbe({ account, dir: 'in', variant: idx, target: c, renew: true, error: String((e as Error)?.message ?? e) }))
    }
  }, EVERY_MS)
  t.unref()
  running.set(k, t)
}

/** At connection: subscribe to the live locations received in the last 8 hours (chat JID and the raw LID/PN of the key). */
export async function probeActiveShares(sock: Pick<WASocket, 'query' | 'ws'>, h: DbHandle, accountId: string): Promise<void> {
  const since = Math.floor(Date.now() / 1000) - 8 * 3600
  const rows = await h.db.selectFrom('messages').select(['chat_jid', 'raw']).where('account_id', '=', accountId).where('type', '=', 'liveLocationMessage').where('from_me', '=', 0).where('ts', '>', since).execute()
  const seen = new Set<string>()
  for (const r of rows as { chat_jid: string; raw: string }[]) {
    if (seen.has(r.chat_jid)) continue
    seen.add(r.chat_jid)
    let key: { remoteJid?: string; remoteJidAlt?: string } = {}
    try {
      key = (JSON.parse(r.raw) as { key?: typeof key }).key ?? {}
    } catch {
      /* raw without key */
    }
    const chats = [...new Set([r.chat_jid, key.remoteJid, key.remoteJidAlt].filter((x): x is string => !!x))]
    writeProbe({ account: accountId, dir: 'note', note: 'active share found', chats })
    await probeSubscribe(sock, chats, accountId)
  }
}

/* ---------- location key + decrypt attempt ---------- */

type Repo = WASocket['signalRepository']
const keyGroups = new Set<string>() // groupId of every location key seen (the sender-key name the updates may use)

/**
 * The sharer hands its location key out as a message carrying fastRatchetKeySenderKeyDistributionMessage
 * (Baileys only processes senderKeyDistributionMessage). Store it the same way, under <groupId>::<author>.
 */
export async function captureLocationKey(repo: Pick<Repo, 'processSenderKeyDistributionMessage'>, msg: { key: { participant?: string | null; remoteJid?: string | null }; message?: proto.IMessage | null }, account: string): Promise<boolean> {
  const item = msg.message?.fastRatchetKeySenderKeyDistributionMessage
  if (!item?.axolotlSenderKeyDistributionMessage) return false
  const author = msg.key.participant || msg.key.remoteJid || ''
  if (item.groupId) keyGroups.add(item.groupId)
  try {
    await repo.processSenderKeyDistributionMessage({ item, authorJid: author })
    writeProbe({ account, dir: 'note', note: 'location key stored', groupId: item.groupId ?? null, author })
    return true
  } catch (e) {
    writeProbe({ account, dir: 'note', note: 'location key NOT stored', groupId: item.groupId ?? null, author, error: String((e as Error)?.message ?? e) })
    return false
  }
}

/** Try to open an update (enc type not msg/pkmsg/skmsg) with the stored location key. Logs what it is, never where. */
export async function tryDecryptUpdate(repo: Pick<Repo, 'decryptGroupMessage'>, n: BinaryNode, account: string): Promise<'ok' | 'fail' | 'skip'> {
  const enc = kids(n).find((c) => c.tag === 'enc' && !KNOWN_ENC.has(c.attrs?.type ?? ''))
  if (n.tag !== 'message' || !enc || !(enc.content instanceof Uint8Array)) return 'skip'
  const from = n.attrs.from ?? ''
  const author = n.attrs.participant || from
  // 1:1 chat: the chat itself is a candidate name; in a group, only the location key's own groupId (never the group's normal key)
  const groups = [...keyGroups, ...(from.endsWith('@g.us') ? [] : [from])]
  if (!groups.length) {
    writeProbe({ account, dir: 'note', note: 'update before any location key', enc: enc.attrs.type })
    return 'fail'
  }
  for (const group of new Set(groups)) {
    try {
      const buf = await repo.decryptGroupMessage({ group, authorJid: author, msg: enc.content })
      const m = proto.Message.decode(unpadRandomMax16(buf))
      writeProbe({ account, dir: 'note', note: 'update decrypted', enc: enc.attrs.type, group, fields: Object.keys(m.toJSON()), sequence: m.liveLocationMessage?.sequenceNumber?.toString() ?? null })
      return 'ok'
    } catch (e) {
      writeProbe({ account, dir: 'note', note: 'update not decrypted', enc: enc.attrs.type, group, error: String((e as Error)?.message ?? e) })
    }
  }
  return 'fail'
}

/** Log every location frame this socket receives and try to open the updates. */
export function attachProbe(sock: Pick<WASocket, 'ws' | 'signalRepository'>, account: string): void {
  sock.ws.on('frame', (n: BinaryNode) => {
    try {
      const loc = isLocationFrame(n)
      if (!loc && !mentionsWatched(n)) return
      writeProbe({ account, dir: 'in', ...(loc ? {} : { watched: true }), frame: describeNode(n) })
      if (!loc) return
      void tryDecryptUpdate(sock.signalRepository, n, account).catch(() => undefined)
    } catch {
      /* never break the socket */
    }
  })
  writeProbe({ account, dir: 'note', note: 'probe attached' })
}
