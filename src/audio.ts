/**
 * WhatsApp voice notes are Ogg Opus. Some transcribers (Superwhisper on the Mac) read WAV best:
 * decode here (WebAssembly, no ffmpeg needed on any system) to 16 kHz mono 16-bit WAV.
 */
import { OggOpusDecoder } from 'ogg-opus-decoder'

export function isOggOpus(buf: Buffer): boolean {
  return buf.length > 36 && buf.subarray(0, 4).toString('latin1') === 'OggS' && buf.includes(Buffer.from('OpusHead'))
}

/** Mono PCM float samples → 16-bit WAV. */
export function wavFrom(samples: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'latin1')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVEfmt ', 8, 'latin1')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'latin1')
  out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return out
}

/** Downmix to mono and resample by averaging (48 kHz → 16 kHz is an exact factor of 3). */
export function toMono16k(channels: Float32Array[], rate: number, target = 16_000): Float32Array {
  const n = channels[0]?.length ?? 0
  const mono = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length
  if (rate === target) return mono
  const ratio = rate / target
  const len = Math.floor(n / ratio)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio)
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio))
    let s = 0
    for (let j = a; j < b && j < n; j++) s += mono[j]
    out[i] = s / (b - a)
  }
  return out
}

/** Ogg Opus → 16 kHz mono WAV; with its length in seconds. */
export async function oggOpusToWav(buf: Buffer): Promise<{ wav: Buffer; seconds: number }> {
  const dec = new OggOpusDecoder({ forceStereo: false })
  await dec.ready
  try {
    const r = await dec.decodeFile(new Uint8Array(buf))
    if (r.errors?.length && !r.samplesDecoded) throw new Error(r.errors[0]?.message ?? 'not decodable')
    const pcm = toMono16k(r.channelData, r.sampleRate)
    return { wav: wavFrom(pcm, 16_000), seconds: pcm.length / 16_000 }
  } finally {
    dec.free()
  }
}
