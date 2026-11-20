import { describe, expect, it } from 'vitest'
import { toJid, userOf, bareJid } from '../src/util.js'
import { signPayload } from '../src/events.js'
import { redirectUriAllowed } from '../src/security/oauth.js'

describe('jid normalisation', () => {
  it('accepts numbers, JIDs, LIDs and groups', () => {
    expect(toJid('+971 50 123 4567')).toBe('971501234567@s.whatsapp.net')
    expect(toJid('971501234567:72@s.whatsapp.net')).toBe('971501234567@s.whatsapp.net')
    expect(toJid('393331234567@c.us')).toBe('393331234567@s.whatsapp.net')
    expect(toJid('222161579077860@lid')).toBe('222161579077860@lid')
    expect(toJid('120363198851684748@g.us')).toBe('120363198851684748@g.us')
    expect(() => toJid('12')).toThrow()
    expect(userOf('971501234567:72@s.whatsapp.net')).toBe('971501234567')
    expect(bareJid('222161579077860:72@lid')).toBe('222161579077860@lid')
  })
})

describe('security helpers', () => {
  it('signs webhooks deterministically', () => {
    expect(signPayload('s3cret', '1700000000', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(signPayload('s3cret', '1700000000', '{"a":1}')).toBe(signPayload('s3cret', '1700000000', '{"a":1}'))
  })
  it('allows only safe OAuth redirect URIs', () => {
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectUriAllowed('http://localhost:33418/callback')).toBe(true)
    expect(redirectUriAllowed('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true)
    expect(redirectUriAllowed('http://evil.example/cb')).toBe(false)
    expect(redirectUriAllowed('javascript:alert(1)')).toBe(false)
    expect(redirectUriAllowed('https://x.example/cb#frag')).toBe(false)
  })
})
