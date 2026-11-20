import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import pino from 'pino'
import { config } from './config.js'

/**
 * Log entries are written to stdout (journald / terminal) AND kept for the config page:
 * the last RING_MAX in memory, plus a rotating JSON-lines file in <data>/logs so they survive restarts.
 * Redaction happens in pino before any stream sees the line.
 */
export type LogEntry = { t: number; level: number; mod?: string; msg: string; data?: Record<string, unknown> }

const RING_MAX = 3000
const FILE_MAX = 5 * 1024 * 1024
const FILE_KEEP = 2
const FIELD_MAX = 4000
const LOG_DIR = path.join(config.dataDir, 'logs')
export const LOG_FILE = path.join(LOG_DIR, 'whatsops.log')

const ring: LogEntry[] = []
const listeners = new Set<(e: LogEntry) => void>()
let fileFd: number | null = null
let fileSize = 0

function openFile(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    fileFd = fs.openSync(LOG_FILE, 'a', 0o600)
    fileSize = fs.fstatSync(fileFd).size
  } catch {
    fileFd = null
  }
}

function rotate(): void {
  try {
    if (fileFd !== null) fs.closeSync(fileFd)
    for (let i = FILE_KEEP; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`
      if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i}`)
    }
  } catch {
    /* keep logging to a fresh file even if a rename failed */
  }
  openFile()
}

function toEntry(o: Record<string, unknown>): LogEntry {
  const { level, time, msg, mod, pid: _pid, hostname: _host, ...rest } = o
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    data[k] = s.length > FIELD_MAX ? s.slice(0, FIELD_MAX) + '…' : v
  }
  return {
    t: typeof time === 'number' ? time : Date.now(),
    level: typeof level === 'number' ? level : 30,
    ...(typeof mod === 'string' ? { mod } : {}),
    msg: typeof msg === 'string' ? msg : '',
    ...(Object.keys(data).length ? { data } : {}),
  }
}

function remember(e: LogEntry): void {
  ring.push(e)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  for (const l of listeners) {
    try {
      l(e)
    } catch {
      /* a broken listener must not break logging */
    }
  }
}

/** Load the tail of the log file so the page shows what happened before the last restart. */
function loadTail(): void {
  try {
    const st = fs.statSync(LOG_FILE)
    const start = Math.max(0, st.size - 1024 * 1024)
    const fd = fs.openSync(LOG_FILE, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift() // partial first line
    for (const line of lines.slice(-RING_MAX)) {
      if (!line.trim()) continue
      try {
        ring.push(JSON.parse(line) as LogEntry)
      } catch {
        /* skip a torn line */
      }
    }
  } catch {
    /* no file yet */
  }
}

class Sink extends Writable {
  private partial = ''
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const text = this.partial + chunk.toString()
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: LogEntry
      try {
        entry = toEntry(JSON.parse(line) as Record<string, unknown>)
      } catch {
        entry = { t: Date.now(), level: 30, msg: line.slice(0, FIELD_MAX) }
      }
      remember(entry)
      if (fileFd !== null) {
        const out = JSON.stringify(entry) + '\n'
        try {
          fs.writeSync(fileFd, out)
          fileSize += Buffer.byteLength(out)
          if (fileSize > FILE_MAX) rotate()
        } catch {
          /* disk full or similar: the ring buffer still works */
        }
      }
    }
    cb()
  }
}

loadTail()
openFile()

export const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie',
        '*.password', '*.secret', '*.token', '*.access_token', '*.refresh_token', '*.code_verifier',
        '*.creds', '*.keys', '*.mediaKey', 'dbUrl', '*.dbUrl',
      ],
      censor: '***',
    },
  },
  pino.multistream([
    { level: config.logLevel as pino.Level, stream: process.stdout },
    { level: config.logLevel as pino.Level, stream: new Sink() },
  ]),
)

export type Logger = typeof logger

/** Recent entries, oldest first. */
export function recentLogs(o: { minLevel?: number; q?: string; limit?: number } = {}): LogEntry[] {
  const q = o.q?.trim().toLowerCase()
  const out: LogEntry[] = []
  for (let i = ring.length - 1; i >= 0 && out.length < (o.limit ?? 500); i--) {
    const e = ring[i]
    if (o.minLevel && e.level < o.minLevel) continue
    if (q && !`${e.mod ?? ''} ${e.msg} ${e.data ? JSON.stringify(e.data) : ''}`.toLowerCase().includes(q)) continue
    out.push(e)
  }
  return out.reverse()
}

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
