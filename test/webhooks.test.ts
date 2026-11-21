import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeEvent, EventBus, maskHookHeaders, parseHookHeaders, signPayload, WebhookDispatcher } from '../src/events.js'

describe('webhook headers, written the way receivers show them', () => {
  it('a key alone, "Bearer <key>" or the whole header line', () => {
    const want = { Authorization: 'Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce' }
    expect(parseHookHeaders('crsr_95d84a3f816c59bc6a431b8d59a8e688ce')).toEqual(want)
    expect(parseHookHeaders('Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce')).toEqual(want)
    expect(parseHookHeaders('  Authorization: Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce  ')).toEqual(want)
    expect(parseHookHeaders('bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce')).toEqual(want)
  })
  it('other headers, several lines, an object; empty = none', () => {
    expect(parseHookHeaders('X-Api-Key: abc123\nAuthorization: Basic dXNlcjpwYXNz')).toEqual({ 'X-Api-Key': 'abc123', Authorization: 'Basic dXNlcjpwYXNz' })
    expect(parseHookHeaders({ 'X-Automation-Key': 'k1' })).toEqual({ 'X-Automation-Key': 'k1' })
    expect(parseHookHeaders('{"X-Token":"t"}')).toEqual({ 'X-Token': 't' })
    expect(parseHookHeaders('')).toEqual({})
    expect(parseHookHeaders(undefined)).toEqual({})
  })
  it('refuses what would break the request or the signature', () => {
    expect(() => parseHookHeaders('X-WA-Signature: x')).toThrow()
    expect(() => parseHookHeaders('Content-Type: text/plain')).toThrow()
    expect(() => parseHookHeaders('two words here')).toThrow()
    expect(() => parseHookHeaders({ 'Bad Name': 'x' })).toThrow()
  })
  it('the key is never shown whole', () => {
    expect(maskHookHeaders(JSON.stringify({ Authorization: 'Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce' }))).toEqual({ Authorization: 'Bearer crsr_95d…' })
    expect(maskHookHeaders(JSON.stringify({ 'X-Api-Key': 'short' }))).toEqual({ 'X-Api-Key': '…' })
    expect(maskHookHeaders(null)).toEqual({})
  })
  it('context in plain words', () => {
    expect(describeEvent({ type: 'message.received', account: '971500000001', data: { chat: '393331234567@s.whatsapp.net', senderName: 'Mario', senderPhone: '+393331234567', text: 'ciao' } })).toBe(
      'WhatsApp message received on +971500000001 from Mario +393331234567: ciao',
    )
  })
})

describe('delivery with the receiver key (Cursor / Grok Bot automation format)', () => {
  let server: http.Server
  let url = ''
  let status = 200
  const got: { headers: http.IncomingHttpHeaders; body: string }[] = []
  let disp: WebhookDispatcher
  let bus: EventBus
  let h: Awaited<ReturnType<typeof import('../src/db/index.js').openDb>>

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        got.push({ headers: req.headers, body })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/automations/webhook/abc`
    const { openDb, migrate } = await import('../src/db/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-hooks-'))
    h = await openDb(`sqlite://${path.join(dir, 't.db')}`)
    await migrate(h)
    const t = Date.now()
    await h.db
      .insertInto('webhooks')
      .values([
        { id: 'cursor', url, events: 'message.received', account_id: '*', secret: 'whs_s1', active: 1, created_at: t, headers: JSON.stringify(parseHookHeaders('Authorization: Bearer crsr_key1')) },
        { id: 'plain', url, events: 'connection.update', account_id: '*', secret: 'whs_s2', active: 1, created_at: t + 1, headers: null },
      ])
      .execute()
    bus = new EventBus()
    disp = new WebhookDispatcher(h, bus)
    await disp.start()
  })
  afterAll(() => server.close())

  it('sends Authorization: Bearer <key>, the signature and a context line', async () => {
    bus.publish('message.received', '971500000001', { chat: '393331234567@s.whatsapp.net', senderName: 'Mario', senderPhone: '+393331234567', text: 'ciao' })
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBe(1)
    const { headers, body } = got[0]
    expect(headers.authorization).toBe('Bearer crsr_key1')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-wa-signature']).toBe(signPayload('whs_s1', String(headers['x-wa-timestamp']), body))
    const j = JSON.parse(body)
    expect(j).toMatchObject({ type: 'message.received', account: '971500000001', context: 'WhatsApp message received on +971500000001 from Mario +393331234567: ciao', data: { text: 'ciao' } })
  })

  it('Test reaches only that webhook, whatever its events, and returns the answer', async () => {
    got.length = 0
    const r = await disp.deliverTest('cursor', '971500000001')
    expect(r).toEqual({ ok: true, status: 200, error: null })
    expect(got.length).toBe(1)
    expect(got[0].headers.authorization).toBe('Bearer crsr_key1')
    expect(JSON.parse(got[0].body)).toMatchObject({ type: 'webhook.test', context: 'Test event from WhatsOps (+971500000001): the webhook works.' })
    got.length = 0
    await disp.deliverTest('plain', '971500000001')
    expect(got[0].headers.authorization).toBeUndefined()
  })

  it('a wrong key: the error comes back, no retries for a test', async () => {
    status = 401
    const r = await disp.deliverTest('cursor', '971500000001')
    expect(r).toEqual({ ok: false, status: 401, error: 'HTTP 401' })
    const d = await h.db.selectFrom('webhook_deliveries').selectAll().where('webhook_id', '=', 'cursor').orderBy('updated_at', 'desc').executeTakeFirst()
    expect(d).toMatchObject({ state: 'failed', last_status: 401 })
    status = 200
  })

  it('a database from an older version gets the new column, its webhooks untouched', async () => {
    const { openDb, migrate } = await import('../src/db/index.js')
    const { sql } = await import('kysely')
    const old = await openDb(`sqlite://${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wo-hooks-old-')), 'o.db')}`)
    await sql`create table webhooks (id varchar(64) not null primary key, url text, events text, account_id varchar(64), secret varchar(255), active integer, created_at bigint)`.execute(old.db)
    await sql`insert into webhooks values ('w1', 'https://example.com/h', '*', '*', 'whs_x', 1, 1)`.execute(old.db)
    await migrate(old)
    const cols = (await old.db.introspection.getTables()).find((t) => t.name === 'webhooks')!.columns.map((c) => c.name)
    expect(cols).toContain('headers')
    expect(await old.db.selectFrom('webhooks').selectAll().execute()).toMatchObject([{ id: 'w1', url: 'https://example.com/h', headers: null }])
  })
})
