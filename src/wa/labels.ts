/**
 * WhatsApp labels: on WhatsApp Business the labels of chats and messages ("New customer", "Paid"…),
 * on regular WhatsApp the chat lists. They live in WhatsApp's app state (collection "regular"):
 * Baileys emits labels.edit and labels.association whenever that state changes. A number linked
 * before WhatsOps stored them has them only in the full copy of that collection, which the account
 * asks WhatsApp for once (WaAccount.readAllLabels).
 */
import { now, upsert, type DbHandle } from '../db/index.js'
import { AppError } from '../util.js'

export type Label = { id: string; name: string; color: number | null; predefinedId: string | null; chats: number; messages: number }
export type LabelLink = { labelId: string; chat: string; messageId: string | null }

type LabelRow = { account_id: string; label_id: string; name: string | null; color: number | null; predefined_id: string | null; deleted: number | null; updated_at: number | null }
type LinkRow = { account_id: string; label_id: string; chat_jid: string; msg_id: string; updated_at: number | null }

/** A label created, renamed, recoloured or deleted. Returns whether anything changed. */
export async function saveLabel(h: DbHandle, accountId: string, l: { id: string; name?: string | null; color?: number | null; deleted?: boolean | null; predefinedId?: string | null }, at = now()): Promise<boolean> {
  const next = { name: l.name ?? null, color: l.color ?? null, predefined_id: l.predefinedId ?? null, deleted: l.deleted ? 1 : 0 }
  const cur = (await h.db.selectFrom('labels').selectAll().where('account_id', '=', accountId).where('label_id', '=', l.id).executeTakeFirst()) as LabelRow | undefined
  if (cur && cur.name === next.name && Number(cur.color ?? -1) === Number(next.color ?? -1) && (cur.predefined_id ?? null) === next.predefined_id && Number(cur.deleted ?? 0) === next.deleted) return false
  await upsert(h, 'labels', { account_id: accountId, label_id: l.id, ...next, updated_at: at }, ['account_id', 'label_id'])
  return true
}

/** A label put on (add) or taken off a chat, or a message of a chat. Returns whether anything changed. */
export async function linkLabel(h: DbHandle, accountId: string, a: { labelId: string; chat: string; messageId?: string | null }, add: boolean, at = now()): Promise<boolean> {
  const key = { account_id: accountId, label_id: a.labelId, chat_jid: a.chat, msg_id: a.messageId ?? '' }
  const where = h.db.selectFrom('label_links').select('label_id').where('account_id', '=', key.account_id).where('label_id', '=', key.label_id).where('chat_jid', '=', key.chat_jid).where('msg_id', '=', key.msg_id)
  const have = !!(await where.executeTakeFirst())
  if (add === have) return false
  if (add) await h.db.insertInto('label_links').values({ ...key, updated_at: at }).execute()
  else await h.db.deleteFrom('label_links').where('account_id', '=', key.account_id).where('label_id', '=', key.label_id).where('chat_jid', '=', key.chat_jid).where('msg_id', '=', key.msg_id).execute()
  return true
}

// names WhatsApp writes itself (its own labels, its filters) start with an invisible left-to-right mark
const MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
export const cleanName = (s: string | null | undefined): string => String(s ?? '').replace(MARKS, '').trim()
/**
 * WhatsApp's own chat filters (Unread, Favorites, Groups) travel as labels too: a name written by
 * WhatsApp and no predefined label id. They are not labels anybody put on a chat: left out.
 */
export const isBuiltInFilter = (r: { name: string | null; predefined_id: string | null }): boolean => /^\u200e/.test(r.name ?? '') && !r.predefined_id

const byId = (a: { id: string }, b: { id: string }) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.id.localeCompare(b.id)

/** The labels of the number (deleted ones left out), with how many chats and messages carry each. */
export async function listLabels(h: DbHandle, accountId: string): Promise<Label[]> {
  const rows = (await h.db.selectFrom('labels').selectAll().where('account_id', '=', accountId).execute()) as LabelRow[]
  const links = (await h.db.selectFrom('label_links').select(['label_id', 'msg_id']).where('account_id', '=', accountId).execute()) as Pick<LinkRow, 'label_id' | 'msg_id'>[]
  const count = new Map<string, { chats: number; messages: number }>()
  for (const l of links) {
    const c = count.get(l.label_id) ?? { chats: 0, messages: 0 }
    if (l.msg_id) c.messages++
    else c.chats++
    count.set(l.label_id, c)
  }
  return rows
    .filter((r) => !Number(r.deleted) && !isBuiltInFilter(r))
    .map((r) => ({ id: r.label_id, name: cleanName(r.name), color: r.color == null ? null : Number(r.color), predefinedId: r.predefined_id ?? null, ...(count.get(r.label_id) ?? { chats: 0, messages: 0 }) }))
    .sort(byId)
}

/** Chats and messages that carry a label, as stored (the chat may be a LID: canonicalise when reading). */
export async function labelLinks(h: DbHandle, accountId: string, labelId?: string, chats?: string[]): Promise<LabelLink[]> {
  let q = h.db.selectFrom('label_links').selectAll().where('account_id', '=', accountId)
  if (labelId) q = q.where('label_id', '=', labelId)
  if (chats) {
    if (!chats.length) return []
    q = q.where('chat_jid', 'in', chats)
  }
  const rows = (await q.orderBy('chat_jid').orderBy('msg_id').execute()) as LinkRow[]
  return rows.map((r) => ({ labelId: r.label_id, chat: r.chat_jid, messageId: r.msg_id || null }))
}

/** A label by id or by name (case does not matter). */
export function pickLabel(labels: Label[], input: string): Label {
  const s = String(input ?? '').trim()
  const l = labels.find((x) => x.id === s) ?? labels.find((x) => x.name.toLowerCase() === s.toLowerCase())
  if (!l) throw new AppError('LABEL_NOT_FOUND', 'No label "{0}" on this number. Labels: {1}', 404, [s, labels.map((x) => x.name || x.id).join(', ') || '—'])
  return l
}
