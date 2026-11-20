/** Replace {0}, {1}… with params. */
export function fmt(template: string, params: unknown[] = []): string {
  return template.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < params.length ? String(params[Number(i)]) : m))
}

/** Error with a stable code and an English template; translated at the edge (REST / MCP / pages). */
export class AppError extends Error {
  constructor(
    public code: string,
    public template: string,
    public status = 400,
    public params: unknown[] = [],
  ) {
    super(fmt(template, params))
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function digits(s: string): string {
  return String(s ?? '').replace(/\D+/g, '')
}

const JID_SUFFIXES = ['@s.whatsapp.net', '@lid', '@g.us', '@newsletter', '@broadcast', '@c.us', '@hosted', '@hosted.lid']

/**
 * Accepts an E.164 / free-form phone number, a PN JID, a LID, a group JID or a newsletter JID.
 * Returns a JID (no device suffix for users).
 */
export function toJid(input: string): string {
  const s = String(input ?? '').trim()
  if (!s) throw new AppError('INVALID_RECIPIENT', 'Recipient is empty', 400)
  if (s.includes('@')) {
    const at = s.indexOf('@')
    let user = s.slice(0, at)
    let server = s.slice(at)
    if (server === '@c.us') server = '@s.whatsapp.net'
    if (!JID_SUFFIXES.includes(server)) throw new AppError('INVALID_RECIPIENT', 'Unsupported JID server {0}', 400, [server])
    if (server === '@s.whatsapp.net' || server === '@lid') user = user.split(':')[0]
    return user + server
  }
  // group ids without suffix look like 120363xxxxxxxx (18+ digits) or old style 9715xxx-1600000000
  if (/^\d{6,}-\d{6,}$/.test(s)) return `${s}@g.us`
  const d = digits(s)
  if (d.length < 7 || d.length > 15) throw new AppError('INVALID_RECIPIENT', '"{0}" is not a valid phone number (use international format, e.g. +971501234567)', 400, [input])
  return `${d}@s.whatsapp.net`
}

export const isGroupJid = (j: string) => j.endsWith('@g.us')
export const isLidJid = (j: string) => j.endsWith('@lid')
export const isPnJid = (j: string) => j.endsWith('@s.whatsapp.net')

/** '15551234567:12@s.whatsapp.net' -> '15551234567' */
export function userOf(jid?: string | null): string {
  if (!jid) return ''
  return jid.split('@')[0].split(':')[0]
}

export function bareJid(jid?: string | null): string {
  if (!jid) return ''
  const at = jid.indexOf('@')
  if (at < 0) return jid
  return userOf(jid) + jid.slice(at)
}

export function slugify(s: string): string {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account'
  )
}
