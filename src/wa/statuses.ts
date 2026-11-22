/**
 * My own statuses (stories) and who saw them. WhatsApp tells every device of the poster when somebody
 * gets or opens a status (receipts on status@broadcast, Baileys' message-receipt.update): that is how
 * WhatsApp Web shows the viewers too. Kept here per status and per person; a status is gone after
 * 24 hours on WhatsApp, its record stays.
 */
import { getContentType, normalizeMessageContent, type WAMessage } from '@whiskeysockets/baileys'
import { upsert, type DbHandle } from '../db/index.js'

export const STATUS_JID = 'status@broadcast'
/** WhatsApp keeps a status for 24 hours */
export const STATUS_LIFE_MS = 24 * 3600_000

export type StatusRow = { account_id: string; id: string; ts: number | null; type: string | null; text: string | null; audience: string | null; source: string | null; deleted: number | null }
export type StatusViewRow = { account_id: string; status_id: string; viewer: string; delivered_at: number | null; viewed_at: number | null }

/** Save a status of mine, or what is new about it: fields not given keep their value; the audience and "posted by WhatsOps" are never lost. */
export async function saveStatus(
  h: DbHandle,
  accountId: string,
  s: { id: string; ts?: number | null; type?: string | null; text?: string | null; audience?: string[] | null; source?: 'whatsops' | 'phone'; deleted?: boolean },
): Promise<void> {
  const cur = (await h.db.selectFrom('statuses').selectAll().where('account_id', '=', accountId).where('id', '=', s.id).executeTakeFirst()) as StatusRow | undefined
  const row: StatusRow = {
    account_id: accountId,
    id: s.id,
    ts: cur?.ts ?? s.ts ?? null,
    type: s.type ?? cur?.type ?? null,
    text: s.text ?? cur?.text ?? null,
    audience: s.audience ? JSON.stringify(s.audience) : cur?.audience ?? null,
    source: cur?.source === 'whatsops' || s.source === 'whatsops' ? 'whatsops' : s.source ?? cur?.source ?? null,
    deleted: s.deleted ? 1 : Number(cur?.deleted ?? 0),
  }
  await upsert(h, 'statuses', row, ['account_id', 'id'])
}

const KIND: Record<string, string> = { imageMessage: 'image', videoMessage: 'video', extendedTextMessage: 'text', conversation: 'text', audioMessage: 'audio' }

/** A status I posted (from any of my devices), or one I deleted, out of a message WhatsApp sent; null for anything else. */
export function statusFromMessage(m: WAMessage): { id: string; ts?: number; type?: string; text?: string | null; deleted?: true } | null {
  const k = m.key
  if (k?.remoteJid !== STATUS_JID || !k.fromMe || !k.id) return null
  const content = normalizeMessageContent(m.message)
  const t = content ? getContentType(content) : undefined
  if (!content || !t) return null
  if (t === 'protocolMessage') {
    const p = content.protocolMessage
    return p && Number(p.type) === 0 && p.key?.id ? { id: p.key.id, deleted: true } : null
  }
  const type = KIND[t]
  if (!type) return null
  const c = content as { conversation?: string | null; extendedTextMessage?: { text?: string | null }; imageMessage?: { caption?: string | null }; videoMessage?: { caption?: string | null } }
  const text = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? null
  return { id: k.id, ts: Number(m.messageTimestamp ?? 0) * 1000 || Date.now(), type, text: text || null }
}

/**
 * Somebody got (deliveredAt) or opened (viewedAt) one of my statuses. Only statuses I posted count.
 * Returns 'viewed' the first time that person opens it, 'delivered' the first time it reaches them, else null.
 */
export async function recordStatusReceipt(h: DbHandle, accountId: string, r: { statusId: string; viewer: string; deliveredAt?: number; viewedAt?: number }): Promise<'viewed' | 'delivered' | null> {
  const mine = await h.db.selectFrom('statuses').select('id').where('account_id', '=', accountId).where('id', '=', r.statusId).executeTakeFirst()
  if (!mine) return null
  const cur = (await h.db.selectFrom('status_views').selectAll().where('account_id', '=', accountId).where('status_id', '=', r.statusId).where('viewer', '=', r.viewer).executeTakeFirst()) as StatusViewRow | undefined
  const delivered = cur?.delivered_at ?? r.deliveredAt ?? r.viewedAt ?? null
  const viewed = cur?.viewed_at ?? r.viewedAt ?? null
  if (cur && Number(cur.delivered_at) === Number(delivered) && Number(cur.viewed_at ?? 0) === Number(viewed ?? 0)) return null
  await upsert(h, 'status_views', { account_id: accountId, status_id: r.statusId, viewer: r.viewer, delivered_at: delivered, viewed_at: viewed }, ['account_id', 'status_id', 'viewer'])
  if (viewed && !cur?.viewed_at) return 'viewed'
  return cur ? null : 'delivered'
}

/** My statuses posted since `since` (ms), newest first, or the one asked; deleted ones left out. */
export async function loadStatuses(h: DbHandle, accountId: string, q: { since?: number; id?: string }): Promise<{ statuses: StatusRow[]; views: StatusViewRow[] }> {
  let s = h.db.selectFrom('statuses').selectAll().where('account_id', '=', accountId)
  if (q.id) s = s.where('id', '=', q.id)
  else s = s.where('ts', '>=', q.since ?? Date.now() - STATUS_LIFE_MS).where('deleted', '=', 0)
  const statuses = (await s.orderBy('ts', 'desc').execute()) as StatusRow[]
  if (!statuses.length) return { statuses, views: [] }
  const views = (await h.db.selectFrom('status_views').selectAll().where('account_id', '=', accountId).where('status_id', 'in', statuses.map((x) => x.id)).execute()) as StatusViewRow[]
  return { statuses, views }
}
