#!/usr/bin/env node
// Real check on this machine: install faster-whisper exactly as the Settings → Voice button does
// (into a fresh folder, with its own Python — the system's Python is never used), then transcribe a
// voice note with the same worker WhatsOps runs. Exit code 1 on any failure.
//   node packaging/check-whisper.mjs [model]        (after npm run build; default model: tiny)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsops-whisper-check-'))
process.env.WA_DATA_DIR = path.join(tmp, 'data')
const model = process.argv[2] || 'tiny'
const t = Date.now()
const s = () => `${((Date.now() - t) / 1000).toFixed(0)} s`

const { WhisperInstaller } = await import(pathToFileURL(path.join(root, 'dist', 'whisper-install.js')).href)
const { LocalWorker } = await import(pathToFileURL(path.join(root, 'dist', 'voice.js')).href)

const inst = new WhisperInstaller(path.join(tmp, 'data', 'whisper'))
console.log(`system ${process.platform} ${process.arch}, supported: ${inst.supported}`)
if (!inst.supported) process.exit(1)
const tick = setInterval(() => console.log(`  … ${inst.st.step} (${s()})`), 15_000)
let py
try {
  py = await inst.install()
} catch (e) {
  clearInterval(tick)
  console.error(`install failed at step ${inst.st.step}: ${e.message}`)
  process.exit(1)
}
clearInterval(tick)
if (!py.startsWith(tmp)) {
  console.error(`the Python used is not WhatsOps' own: ${py}`)
  process.exit(1)
}
console.log(`installed in ${s()}: ${py}`)
console.log(`size: ${(dirSize(path.join(tmp, 'data', 'whisper')) / 1e6).toFixed(0)} MB`)

const w = new LocalWorker(() => py)
const t1 = Date.now()
await w.load(model)
console.log(`model ${model} ready in ${((Date.now() - t1) / 1000).toFixed(0)} s`)
const t2 = Date.now()
const r = await w.run(path.join(root, 'test', 'fixtures', 'hello-voice-note.ogg'), model, null, 300_000)
w.stop()
console.log(`transcribed in ${((Date.now() - t2) / 1000).toFixed(1)} s (${r.language}, ${r.duration?.toFixed(1)} s): ${r.text}`)
const ok = /hello/i.test(r.text) && /test/i.test(r.text) && /eight|8/i.test(r.text)
// Windows keeps a running program's files locked for a moment after it is stopped
await new Promise((r) => setTimeout(r, 1500))
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
} catch (e) {
  console.log(`(temporary folder left behind: ${e.code})`)
}
if (!ok) {
  console.error('unexpected text')
  process.exit(1)
}
console.log('OK')
process.exit(0)

function dirSize(d) {
  let n = 0
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) n += dirSize(p)
    else if (e.isFile()) n += fs.statSync(p).size
  }
  return n
}
