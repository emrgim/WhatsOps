/**
 * WhatsApp groups for the plugins (Current RMS, Rentman): one shared pace, sealed groups, people
 * added (or invited privately when WhatsApp refuses), admins promoted, people removed.
 *
 * Group creation is the classic ban trigger for an unofficial client: every plugin goes through
 * the same gate, one new group at a time, 45 s apart (WA_GROUP_GAP_MS only for tests).
 */
import type { WaAccount } from '../wa/account.js'
import { toJid, userOf } from '../util.js'

export const GROUP_GAP_MS = Math.max(0, Number(process.env.WA_GROUP_GAP_MS ?? 45_000))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Sock = ReturnType<WaAccount['requireOpen']>
type Part = { id: string; phoneNumber?: string; admin?: string | null }

let gate: Promise<void> = Promise.resolve()
let lastAt = 0
/** Wait for the turn to create a WhatsApp group or Community (all plugins share it). */
export function paceGroups(): Promise<void> {
  const turn = gate.then(async () => {
    const wait = lastAt + GROUP_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastAt = Date.now()
  })
  gate = turn.catch(() => undefined)
  return turn
}

/** Who must be added to a group and who promoted to admin, given the group's participants. */
export function planAdmins(participants: Part[], phones: string[]): { add: string[]; promote: string[] } {
  const add: string[] = []
  const promote: string[] = []
  for (const ph of phones) {
    const p = participantOf(participants, ph)
    if (!p) add.push(ph)
    else if (!p.admin) promote.push(p.id)
  }
  return { add, promote }
}

/** The participant with this phone number (also when WhatsApp shows them behind a LID). */
export function participantOf(participants: Part[], phone: string): Part | undefined {
  return participants.find((x) => userOf(x.phoneNumber ?? '') === phone || (x.id.endsWith('@s.whatsapp.net') && userOf(x.id) === phone))
}

/** Sealed: only admins add people or change the group, new members need approval. */
export async function sealGroup(sock: Sock, group: string, description: string): Promise<void> {
  await sock.groupUpdateDescription(group, description).catch(() => undefined)
  await sock.groupMemberAddMode(group, 'admin_add').catch(() => undefined)
  await sock.groupJoinApprovalMode(group, 'on').catch(() => undefined)
  await sock.groupSettingUpdate(group, 'locked').catch(() => undefined)
}

/** A new sealed group, alone or inside a Community. Waits for its turn. */
export async function createGroup(acc: WaAccount, subject: string, description: string, community?: string | null): Promise<string> {
  const sock = acc.requireOpen()
  await paceGroups()
  const meta = community ? await sock.communityCreateGroup(clip(subject, 100), [], community) : await sock.groupCreate(clip(subject, 100), [])
  if (!meta?.id) throw new Error('WhatsApp did not create the group')
  await sealGroup(sock, meta.id, description)
  return meta.id
}

/** A new Community (join approval on, only admins add people). Waits for its turn. */
export async function createCommunity(acc: WaAccount, name: string, description: string): Promise<string> {
  const sock = acc.requireOpen()
  await paceGroups()
  const meta = await sock.communityCreate(clip(name, 100), description)
  if (!meta?.id) throw new Error('WhatsApp did not create the community')
  await sock.communityJoinApprovalMode(meta.id, 'on').catch(() => undefined)
  await sock.communityMemberAddMode(meta.id, 'admin_add').catch(() => undefined)
  return meta.id
}

/**
 * Add people (phone numbers). Those WhatsApp does not let us add (their privacy settings: 403, or they
 * just left: 408) get the invite link privately when `inviteText` is given.
 */
export async function addToGroup(acc: WaAccount, group: string, phones: string[], inviteText: string | null): Promise<{ added: string[]; invited: string[]; failed: string[] }> {
  const out = { added: [] as string[], invited: [] as string[], failed: [] as string[] }
  if (!phones.length) return out
  const sock = acc.requireOpen()
  const res = (await sock.groupParticipantsUpdate(group, phones.map((p) => toJid(p)), 'add').catch(() => [])) as { status: string; jid?: string; content?: unknown }[]
  const refused: string[] = []
  phones.forEach((ph, i) => {
    const r = res.find((x) => x.jid && userOf(x.jid) === ph) ?? res[i]
    const st = String(r?.status ?? '')
    if (st === '200' || st === '409') out.added.push(ph)
    else if (st === '403' || st === '408') refused.push(ph)
    else out.failed.push(ph)
  })
  if (refused.length && inviteText != null) {
    const code = await sock.groupInviteCode(group).catch(() => null)
    for (const ph of refused) {
      if (!code) {
        out.failed.push(ph)
        continue
      }
      const sent = await acc.sendRaw(toJid(ph), { text: `${inviteText.trim()}\nhttps://chat.whatsapp.com/${code}` }).then(
        () => true,
        () => false,
      )
      ;(sent ? out.invited : out.failed).push(ph)
    }
  } else out.failed.push(...refused)
  return out
}

/** Remove people (phone numbers) that are in the group. Returns the ones removed. */
export async function removeFromGroup(acc: WaAccount, group: string, phones: string[]): Promise<string[]> {
  if (!phones.length) return []
  const sock = acc.requireOpen()
  const g = await sock.groupMetadata(group)
  const ids = phones.map((ph) => [ph, participantOf(g.participants as Part[], ph)?.id] as const).filter(([, id]) => !!id)
  if (!ids.length) return phones // already gone
  await sock.groupParticipantsUpdate(group, ids.map(([, id]) => id!), 'remove')
  return phones
}

/** Make these people admins of the group (and of its Community): added first when missing. Never demotes. */
export async function ensureAdmins(acc: WaAccount, group: string, phones: string[], community?: string | null, inviteText: string | null = null): Promise<void> {
  if (!phones.length) return
  const sock = acc.requireOpen()
  const g = await sock.groupMetadata(group)
  const plan = planAdmins(g.participants as Part[], phones)
  const promote = [...plan.promote]
  if (plan.add.length) {
    const r = await addToGroup(acc, group, plan.add, inviteText)
    if (r.added.length) {
      const g2 = await sock.groupMetadata(group)
      for (const ph of r.added) {
        const p = participantOf(g2.participants as Part[], ph)
        if (p && !p.admin) promote.push(p.id)
      }
    }
  }
  if (promote.length) await sock.groupParticipantsUpdate(group, promote, 'promote')
  if (community) {
    const c = await sock.groupMetadata(community).catch(() => null)
    if (c) {
      const cp = planAdmins(c.participants as Part[], phones)
      const cpromote = [...cp.promote, ...cp.add.map((p) => toJid(p))]
      if (cpromote.length) await sock.communityParticipantsUpdate(community, cpromote, 'promote').catch(() => undefined)
    }
  }
}

/** Send a text to a group. */
export async function postToGroup(acc: WaAccount, group: string, text: string): Promise<void> {
  await acc.sendRaw(group, { text })
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
