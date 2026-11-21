import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventBus, describeEvent, type WaEvent } from '../src/events.js'
import { cleanTranscript, splitCommand, VoiceService } from '../src/voice.js'
import { audioInfo } from '../src/wa/store.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-voice-'))
const voiceRaw = (id: string, seconds = 7) =>
  JSON.stringify({ key: { remoteJid: '393331234567@s.whatsapp.net', id, fromMe: false }, message: { audioMessage: { seconds, ptt: true, mimetype: 'audio/ogg; codecs=opus' } }, messageTimestamp: 1763700000 })

describe('voice helpers', () => {
  it('plain text out of what transcribers print', () => {
    expect(cleanTranscript('[0.0-2.1]  Ciao Mario,\n[2.1-4.0] arrivo alle otto.\n')).toBe('Ciao Mario, arrivo alle otto.')
    expect(cleanTranscript('Detecting language using up to the first 30 seconds.\nDetected language: Italian\n[00:00.000 --> 00:02.000]  Ciao\n')).toBe('Ciao')
    expect(cleanTranscript('just text')).toBe('just text')
  })
  it('command line → argv without a shell', () => {
    expect(splitCommand('stt-whisper {file} -l "{lang}"')).toEqual(['stt-whisper', '{file}', '-l', '{lang}'])
    expect(splitCommand(`whisper-cli -m '/a b/model.bin' -f {file}`)).toEqual(['whisper-cli', '-m', '/a b/model.bin', '-f', '{file}'])
  })
  it('length and voice-note flag of an audio message', () => {
    expect(audioInfo(voiceRaw('X', 12))).toEqual({ seconds: 12, voiceNote: true })
    expect(audioInfo(JSON.stringify({ key: { id: 'T' }, message: { conversation: 'hi' } }))).toBeNull()
  })
  it('context lines for agents', () => {
    expect(describeEvent({ type: 'message.transcribed', account: '971500000001', data: { chat: '393331234567@s.whatsapp.net', senderName: 'Mario', senderPhone: '+393331234567', seconds: 7, transcript: 'arrivo alle otto' } })).toBe(
      'Voice message (7 s) received on +971500000001 from Mario +393331234567, transcribed: arrivo alle otto',
    )
    expect(describeEvent({ type: 'message.received', account: '971500000001', data: { type: 'audioMessage', senderName: 'Mario', seconds: 7, voiceNote: true } })).toContain('Voice message (7 s) received')
  })
})

describe('voice service with a fake account', () => {
  let h: Awaited<ReturnType<typeof import('../src/db/index.js').openDb>>
  let voice: VoiceService
  const bus = new EventBus()
  const events: WaEvent[] = []
  let downloads = 0
  let fakeAcc: unknown
  const fakeCmd = path.join(tmp, 'fake-stt.mjs')
  const runs = path.join(tmp, 'runs.log')
  let server: http.Server
  let base = ''
  const apiCalls: { path: string; auth?: string; body: string }[] = []

  beforeAll(async () => {
    fs.writeFileSync(fakeCmd, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(runs)}, process.argv.slice(2).join(' ') + '\\n')\nif (!fs.statSync(process.argv[2]).size) process.exit(3)\nconsole.log('[0.0-2.0] Ciao, sono Mario.')\nconsole.log('[2.0-4.0] Arrivo alle otto (' + process.argv[3] + ').')\n`)
    server = http.createServer((req, res) => {
      let body = ''
      req.setEncoding('latin1')
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        apiCalls.push({ path: req.url ?? '', auth: req.headers.authorization, body })
        res.writeHead(req.headers.authorization === 'Bearer k1' ? 200 : 401, { 'content-type': 'application/json' })
        res.end(req.headers.authorization === 'Bearer k1' ? JSON.stringify({ text: ' Hello from the API ', language: 'en', duration: 7.2 }) : JSON.stringify({ error: { message: 'bad key' } }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`

    const { openDb, migrate } = await import('../src/db/index.js')
    h = await openDb(`sqlite://${path.join(tmp, 't.db')}`)
    await migrate(h)
    const rows = new Map<string, Record<string, unknown>>()
    for (const [id, ts] of [['V1', 100], ['V2', 200]] as const) {
      const r = { account_id: '971500000001', chat_jid: '393331234567@s.whatsapp.net', id, from_me: 0, sender: '393331234567@s.whatsapp.net', ts, type: 'audioMessage', text: null, status: null, raw: voiceRaw(id) }
      rows.set(id, r)
      await h.db.insertInto('messages').values(r).execute()
    }
    const acc = {
      id: '971500000001',
      store: {
        loadRow: async (_c: string, id: string) => rows.get(id),
        loadById: async (id: string) => rows.get(id),
        nameOf: async () => 'Mario',
      },
      summarize: async (r: { id: string; chat_jid: string; type: string }) => ({ id: r.id, chat: r.chat_jid, type: r.type, senderName: 'Mario', senderPhone: '+393331234567', seconds: 7, voiceNote: true }),
    }
    fakeAcc = acc
    const accounts = { get: () => acc, list: () => [acc] }
    const svc = {
      resolveChat: async (_a: unknown, c: string) => (c.includes('@') ? c : `${c.replace(/\D/g, '')}@s.whatsapp.net`),
      downloadMedia: async () => {
        downloads++
        return { buf: Buffer.from('OggS-fake-audio'), mimetype: 'audio/ogg', fileName: 'v.ogg' }
      },
    }
    voice = new VoiceService(h, bus, accounts as never, svc as never)
    await voice.start()
    bus.on('event', (e: WaEvent) => events.push(e))
  })
  afterAll(() => server.close())

  it('off: says where to switch it on', async () => {
    await expect(voice.transcribe(fakeAcc as never, undefined, 'V1')).rejects.toThrow(/Settings → Voice/)
  })

  it('command engine: transcribes once, then serves the stored text; event for webhooks', async () => {
    const acc = fakeAcc as never
    await voice.update({ engine: 'command', command: `node ${fakeCmd} {file} {lang}`, language: 'it' })
    const t1 = await voice.transcribe(acc, '+39 333 123 4567', 'V1')
    expect(t1).toMatchObject({ id: 'V1', text: 'Ciao, sono Mario. Arrivo alle otto (it).', seconds: 7, cached: false })
    expect(fs.readFileSync(runs, 'utf8')).toMatch(/audio\.ogg it/)
    const t2 = await voice.transcribe(acc, undefined, 'V1')
    expect(t2).toMatchObject({ text: t1.text, cached: true })
    expect(downloads).toBe(1)
    const ev = events.find((e) => e.type === 'message.transcribed')!
    expect(ev.data).toMatchObject({ id: 'V1', transcript: t1.text })
    const msgs = [{ id: 'V1', chat: '393331234567@s.whatsapp.net', type: 'audioMessage' }, { id: 'V2', chat: '393331234567@s.whatsapp.net', type: 'audioMessage' }, { id: 'T', chat: 'x', type: 'conversation' }] as { id: string; chat: string; type: string; transcript?: string | null }[]
    await voice.attach('971500000001', msgs)
    expect(msgs.map((m) => m.transcript)).toEqual([t1.text, null, undefined])
    expect(await voice.search('971500000001', 'like', '%otto%', 10)).toEqual([{ chat_jid: '393331234567@s.whatsapp.net', msg_id: 'V1' }])
  })

  it('new voice notes are transcribed as they arrive (when auto is on)', async () => {
    events.length = 0
    bus.publish('message.received', '971500000001', { id: 'V2', chat: '393331234567@s.whatsapp.net', type: 'audioMessage', upsertType: 'notify', seconds: 7 })
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'message.transcribed'); i++) await new Promise((r) => setTimeout(r, 100))
    expect(events.find((e) => e.type === 'message.transcribed')?.data).toMatchObject({ id: 'V2' })
    await voice.update({ auto: false })
    events.length = 0
    bus.publish('message.received', '971500000001', { id: 'V1', chat: '393331234567@s.whatsapp.net', type: 'audioMessage', upsertType: 'notify' })
    await new Promise((r) => setTimeout(r, 300))
    expect(events.filter((e) => e.type === 'message.transcribed')).toEqual([])
  })

  it('online service: xAI /stt and OpenAI-compatible /audio/transcriptions, with the key', async () => {
    await voice.update({ engine: 'api', provider: 'xai', apiUrl: base, apiKey: 'k1', language: 'auto' })
    expect(await voice.publicConfig()).toMatchObject({ apiKeySet: true, apiModelEffective: 'grok-voice-transcribe-2.0', platform: process.platform })
    expect(JSON.stringify(await voice.publicConfig())).not.toContain('k1')
    const r = await voice.transcribeAudio(Buffer.from('OggS'), 'audio/ogg', 7)
    expect(r).toEqual({ text: 'Hello from the API', language: 'en', duration: 7.2 })
    expect(apiCalls.at(-1)).toMatchObject({ path: '/v1/stt', auth: 'Bearer k1' })
    expect(apiCalls.at(-1)!.body).toContain('grok-voice-transcribe-2.0')
    expect(apiCalls.at(-1)!.body).toContain('filename="audio.ogg"')
    await voice.update({ provider: 'groq', apiUrl: base })
    await voice.transcribeAudio(Buffer.from('OggS'), 'audio/ogg', 7)
    expect(apiCalls.at(-1)).toMatchObject({ path: '/v1/audio/transcriptions' })
    expect(apiCalls.at(-1)!.body).toContain('whisper-large-v3-turbo')
    await voice.update({ apiKey: 'wrong' })
    await expect(voice.transcribeAudio(Buffer.from('OggS'), 'audio/ogg', 7)).rejects.toThrow(/HTTP 401 bad key/)
  })

  it('refuses settings that cannot work', async () => {
    await expect(voice.update({ engine: 'command', command: 'whisper' })).rejects.toThrow(/\{file\}/)
    await expect(voice.update({ language: 'italiano' })).rejects.toThrow()
    await expect(voice.update({ engine: 'api', provider: 'custom', apiUrl: '' })).rejects.toThrow()
  })
})
