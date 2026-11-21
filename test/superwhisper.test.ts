import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOggOpus, oggOpusToWav, toMono16k, wavFrom } from '../src/audio.js'
import { durationMatches, readMeta, SW_BUNDLE, Superwhisper } from '../src/superwhisper.js'

const tone = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'tone-2s.ogg'))
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sw-'))

/** Superwhisper's behaviour: a new recordings/<id>/meta.json a moment after it gets a file. */
function writeRecording(rec: string, id: string, meta: Record<string, unknown>, afterMs = 150) {
  setTimeout(() => {
    fs.mkdirSync(path.join(rec, id), { recursive: true })
    fs.writeFileSync(path.join(rec, id, 'meta.json'), JSON.stringify(meta))
  }, afterMs)
}

describe('voice audio', () => {
  it('WhatsApp Ogg Opus → 16 kHz mono WAV, no ffmpeg', async () => {
    expect(isOggOpus(tone)).toBe(true)
    expect(isOggOpus(Buffer.from('RIFF0000WAVEfmt '))).toBe(false)
    const { wav, seconds } = await oggOpusToWav(tone)
    expect(seconds).toBeGreaterThan(1.9)
    expect(seconds).toBeLessThan(2.1)
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44)
    // a 440 Hz tone is not silence
    let peak = 0
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)))
    expect(peak).toBeGreaterThan(5000)
  })
  it('downmix and resample', () => {
    const l = new Float32Array([1, 1, 1, 0, 0, 0])
    const r = new Float32Array([0, 0, 0, 0, 0, 0])
    expect([...toMono16k([l, r], 48_000)]).toEqual([0.5, 0])
    expect(wavFrom(new Float32Array([2, -2]), 16_000).readInt16LE(44)).toBe(32767)
  })
})

describe('Superwhisper recordings', () => {
  it('text of a recording, waiting for the AI only when the mode has one', () => {
    expect(readMeta({ result: ' ciao ', duration: 2100 })).toMatchObject({ text: 'ciao', processed: null, duration: 2100 })
    expect(readMeta({ result: 'ciao', languageModelName: 'GPT', llmResult: '' })?.text).toBeNull()
    expect(readMeta({ result: 'ciao', languageModelName: 'GPT', llmResult: 'Ciao.' })).toMatchObject({ text: 'ciao', processed: 'Ciao.' })
    expect(readMeta({ result: '' })?.text).toBeNull()
    expect(readMeta([])).toBeNull()
  })
  it('length check (ms, or s on older versions)', () => {
    expect(durationMatches(36_300, 36)).toBe(true)
    expect(durationMatches(36.3, 36)).toBe(true)
    expect(durationMatches(4_000, 36)).toBe(false)
    expect(durationMatches(null, 36)).toBe(true)
  })
})

describe('Superwhisper engine per system', () => {
  it('Linux: not offered, the engine there is faster-whisper', async () => {
    const sw = new Superwhisper('linux', async () => ({ code: 1, out: '', err: '' }), async () => undefined, {}, tmpHome())
    const st = await sw.status('')
    expect(st.supported).toBe(false)
    expect(st.download).toBeNull()
    await expect(sw.transcribe('/x.ogg', 2, { folder: '', prefer: 'raw', timeoutMs: 500 })).rejects.toMatchObject({ code: 'SW_PLATFORM' })
    await expect(sw.open('app')).rejects.toMatchObject({ code: 'SW_PLATFORM' })
  })

  it('macOS: finds the app and its folder, hands it a WAV, takes the new recording', async () => {
    const home = tmpHome()
    const rec = path.join(home, 'superwhisper', 'recordings')
    fs.mkdirSync(path.join(rec, '1700000000'), { recursive: true })
    fs.writeFileSync(path.join(rec, '1700000000', 'meta.json'), JSON.stringify({ result: 'older dictation', duration: 2000 }))
    const calls: string[][] = []
    let running = true
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args])
      if (file === 'mdfind') return { code: 0, out: '/Applications/superwhisper.app\n', err: '' }
      if (file === 'pgrep') return { code: running ? 0 : 1, out: running ? '4242\n' : '', err: '' }
      if (file === 'open' && args.at(-1)?.endsWith('.wav')) {
        expect(args.slice(0, 3)).toEqual(['-g', '-b', SW_BUNDLE])
        const wav = fs.readFileSync(args.at(-1)!)
        expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
        // the user dictating something else at the same moment: different length, ignored
        writeRecording(rec, '1700000100', { result: 'unrelated dictation', duration: 9000 }, 100)
        writeRecording(rec, '1700000101', { result: 'quattro quattro zero', rawResult: 'x', llmResult: 'Quattro, quattro, zero.', languageModelName: 'Clean', duration: 2010 }, 300)
        return { code: 0, out: '', err: '' }
      }
      return { code: 0, out: '', err: '' }
    }
    const sw = new Superwhisper('darwin', run, async () => undefined, {}, home)
    const st = await sw.status('', true)
    expect(st).toMatchObject({ supported: true, download: 'https://superwhisper.com/download', app: { installed: true, running: true }, folder: { found: true, recordings: 1, custom: false } })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sw-in-'))
    fs.writeFileSync(path.join(dir, 'audio.ogg'), tone)
    const r = await sw.transcribe(path.join(dir, 'audio.ogg'), 2, { folder: '', prefer: 'raw', timeoutMs: 5_000, pollMs: 50 })
    expect(r.text).toBe('quattro quattro zero')
    expect(r.duration).toBeCloseTo(2.01, 2)
    // closed app: WhatsOps opens it first
    running = false
    calls.length = 0
    writeRecording(rec, '1700000200', { result: 'second', duration: 2000 }, 400)
    const r2 = await sw.transcribe(path.join(dir, 'audio.ogg'), 2, { folder: '', prefer: 'processed', timeoutMs: 5_000, pollMs: 50, startWaitMs: 10 })
    expect(r2.text).toBe('second')
    expect(calls.some((c) => c.join(' ') === `open -g -b ${SW_BUNDLE}`)).toBe(true)
  })

  it('macOS: Superwhisper never answers → plain reason (Pro, app open)', async () => {
    const home = tmpHome()
    fs.mkdirSync(path.join(home, 'superwhisper', 'recordings'), { recursive: true })
    const run = async (file: string) => ({ code: 0, out: file === 'mdfind' ? '/Applications/superwhisper.app\n' : file === 'pgrep' ? '1\n' : '', err: '' })
    const sw = new Superwhisper('darwin', run, async () => undefined, {}, home)
    const f = path.join(home, 'a.ogg')
    fs.writeFileSync(f, tone)
    await expect(sw.transcribe(f, 2, { folder: '', prefer: 'raw', timeoutMs: 300, pollMs: 50 })).rejects.toMatchObject({ code: 'SW_TIMEOUT', message: expect.stringContaining('Pro') })
  })

  it('Windows: superwhisper.exe <file>, folder in %LOCALAPPDATA%', async () => {
    const home = tmpHome()
    const local = path.join(home, 'AppData', 'Local')
    const exe = path.join(local, 'Programs', 'superwhisper', 'superwhisper.exe')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, '')
    const rec = path.join(local, 'com.superwhisper.app', 'recordings')
    fs.mkdirSync(rec, { recursive: true })
    const launched: string[][] = []
    const run = async (file: string) => ({ code: 0, out: file === 'tasklist' ? 'superwhisper.exe   4242 Console 1 120,000 K\n' : '', err: '' })
    const launch = async (file: string, args: string[]) => {
      launched.push([file, ...args])
      if (args[0]?.endsWith('.wav')) writeRecording(rec, 'rec-1', { result: 'ciao dal pc', duration: 2000 })
    }
    const sw = new Superwhisper('win32', run, launch, { LOCALAPPDATA: local }, home)
    const st = await sw.status('', true)
    expect(st).toMatchObject({ supported: true, download: 'https://superwhisper.com/windows', app: { installed: true, path: exe, running: true }, folder: { found: true, recordings: 0 } })
    const f = path.join(home, 'audio.ogg')
    fs.writeFileSync(f, tone)
    const r = await sw.transcribe(f, null, { folder: '', prefer: 'raw', timeoutMs: 5_000, pollMs: 50 })
    expect(r.text).toBe('ciao dal pc')
    expect(launched[0][0]).toBe(exe)
    expect(launched[0][1]).toMatch(/audio\.wav$/)
  })

  it('a folder moved in Superwhisper is used when written in Settings', async () => {
    const home = tmpHome()
    const custom = path.join(home, 'Dropbox', 'sw')
    fs.mkdirSync(path.join(custom, 'recordings', 'a'), { recursive: true })
    const sw = new Superwhisper('darwin', async (file) => ({ code: 0, out: file === 'mdfind' ? '/Applications/superwhisper.app\n' : '', err: '' }), async () => undefined, {}, home)
    expect((await sw.status('', true)).folder.found).toBe(false)
    expect((await sw.status(custom, true)).folder).toMatchObject({ found: true, recordings: 1, custom: true, path: custom })
  })
})
