/**
 * Appearance of the web pages (config page, login, consent): Light, Dark or System.
 *
 *   light  — a classic light palette
 *   dark   — a classic dark palette
 *   system — on a desktop that publishes its own theme (colors.toml under
 *            ~/.local/state/…/current/theme), that theme, followed live;
 *            anywhere else the operating system's light/dark preference
 *            (prefers-color-scheme), switching on the fly.
 * WA_THEME (path or http(s) URL to a colors.toml / theme JSON) overrides the desktop theme source.
 * Open pages poll /theme.json and swap /theme.css when the hash changes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Appearance = 'light' | 'dark' | 'system'
export type Theme = { name: string; mode: 'dark' | 'light' | 'auto'; source: 'light' | 'dark' | 'os' | 'desktop'; hash: string; css: string }
type Palette = Record<string, string>

/** Roles every page uses. */
const LIGHT: Palette = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  accent: '#2563eb',
  accent_fg: '#ffffff',
  surface: '#f6f6f6',
  field: '#ffffff',
  bar: '#f2f2f2',
  border: '#d4d4d4',
  selection: '#e9e9e9',
  text_muted: '#666666',
  red: '#c62828',
  yellow: '#a15c00',
  magenta: '#8e24aa',
}
const DARK: Palette = {
  background: '#121212',
  foreground: '#e8e8e8',
  accent: '#60a5fa',
  accent_fg: '#0b0b0b',
  surface: '#1c1c1c',
  field: '#0d0d0d',
  bar: '#181818',
  border: '#343434',
  selection: '#2a2a2a',
  text_muted: '#9b9b9b',
  red: '#ff6b6b',
  yellow: '#e0b050',
  magenta: '#d08cf0',
}

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const hexToRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
const rgbToHex = (r: number[]) => '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
/** a + (b - a) * t */
const mix = (a: string, b: string, t: number) => {
  const x = hexToRgb(a), y = hexToRgb(b)
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t))
}
const luminance = (h: string) => {
  const [r, g, b] = hexToRgb(h).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const vars = (p: Palette) =>
  Object.entries(p)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  --wo-${k.replace(/_/g, '-')}: ${v};`)
    .join('\n')

function finish(name: string, mode: Theme['mode'], source: Theme['source'], css: string): Theme {
  return { name, mode, source, css, hash: crypto.createHash('sha1').update(css).digest('hex').slice(0, 12) }
}

const LIGHT_THEME = finish('light', 'light', 'light', `/* WhatsOps · light */\n:root {\n  color-scheme: light;\n${vars(LIGHT)}\n}\n`)
const DARK_THEME = finish('dark', 'dark', 'dark', `/* WhatsOps · dark */\n:root {\n  color-scheme: dark;\n${vars(DARK)}\n}\n`)
const OS_THEME = finish(
  'system',
  'auto',
  'os',
  `/* WhatsOps · system (follows the operating system light/dark setting) */\n:root {\n  color-scheme: light;\n${vars(LIGHT)}\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    color-scheme: dark;\n${vars(DARK).replace(/^/gm, '  ')}\n  }\n}\n`,
)

// --------------------------------------------------------------- desktop theme

/** colors.toml: flat `key = "#rrggbb"` lines. */
function parseToml(text: string): { colors: Palette; mode?: string } {
  const colors: Palette = {}
  let mode: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']?([^"'#\s][^"']*|#[0-9a-fA-F]{6,8})["']?\s*(#.*)?$/)
    if (!m) continue
    const k = m[1].toLowerCase(), v = m[2].trim()
    if (HEX.test(v)) colors[k] = v.slice(0, 7).toLowerCase()
    else if (k === 'mode') mode = v
  }
  return { colors, mode }
}

function parseAny(text: string): { colors: Palette; mode?: string; name?: string } {
  const t = text.trim()
  if (t.startsWith('{')) {
    const j = JSON.parse(t) as { name?: string; mode?: string; colors?: Palette; [k: string]: unknown }
    const colors: Palette = {}
    for (const [k, v] of Object.entries(j.colors ?? j)) if (typeof v === 'string' && HEX.test(v)) colors[k.toLowerCase()] = v.slice(0, 7).toLowerCase()
    return { colors, mode: j.mode, name: j.name }
  }
  return parseToml(t)
}

function themeName(file: string): string {
  const dir = path.dirname(file)
  for (const f of [path.join(dir, '..', 'theme.name'), path.join(dir, 'theme.name')]) {
    try {
      return fs.readFileSync(f, 'utf8').trim()
    } catch {}
  }
  try {
    return path.basename(fs.realpathSync(dir))
  } catch {
    return 'desktop'
  }
}

/** Map a desktop palette onto the page roles. */
function fromDesktop(c: Palette, modeHint?: string): { palette: Palette; mode: 'light' | 'dark' } {
  const bg = c.background ?? c.bg ?? c.color0
  const fg = c.foreground ?? c.fg ?? c.color7
  if (!bg || !fg) throw new Error('incomplete theme')
  const mode: 'light' | 'dark' = modeHint === 'light' || modeHint === 'dark' ? modeHint : luminance(bg) > 0.4 ? 'light' : 'dark'
  const base = mode === 'light' ? LIGHT : DARK
  const accent = c.accent ?? c.color4 ?? c.blue ?? base.accent
  const field = mode === 'light' ? bg : (c.dark_background ?? mix(bg, '#000000', 0.3))
  return {
    mode,
    palette: {
      background: bg,
      foreground: fg,
      accent,
      accent_fg: contrast(bg, accent) >= 3 ? bg : contrast('#ffffff', accent) > contrast('#000000', accent) ? '#ffffff' : '#000000',
      surface: c.lighter_background ?? mix(bg, fg, 0.06),
      field,
      bar: c.dark_background ?? c.darker_background ?? mix(bg, mode === 'light' ? '#000000' : '#000000', 0.15),
      border: c.color8 ?? (c.muted && contrast(c.muted, bg) < 3 ? c.muted : mix(bg, fg, 0.22)),
      selection: c.selection && c.selection !== accent ? c.selection : mix(bg, accent, 0.15),
      text_muted: [c.dark_foreground, c.muted, mix(fg, bg, 0.35), mix(fg, bg, 0.2)].find((x) => x && contrast(x, bg) >= 3.6) ?? fg,
      red: c.red ?? c.color1 ?? base.red,
      yellow: c.yellow ?? c.color3 ?? base.yellow,
      magenta: c.magenta ?? c.color5 ?? base.magenta,
    },
  }
}

const stateHome = () => process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state')
// desktops that keep their live theme as colors.toml (current and older layout)
export const desktopFiles = () => [path.join(stateHome(), 'omarchy/current/theme/colors.toml'), path.join(os.homedir(), '.config/omarchy/current/theme/colors.toml')]

let fileCache: { key: string; theme: Theme | null } | null = null
let urlCache: { url: string; theme: Theme | null; at: number } | null = null
let urlInflight: Promise<void> | null = null

function build(text: string, name: string): Theme {
  const raw = parseAny(text)
  const { palette, mode } = fromDesktop(raw.colors, raw.mode)
  const n = (raw.name || name).replace(/[^\w .-]/g, '').slice(0, 60)
  return finish(n, mode, 'desktop', `/* WhatsOps · system (desktop theme "${n}") */\n:root {\n  color-scheme: ${mode};\n${vars(palette)}\n}\n`)
}

function desktopFromFile(p: string): Theme | null {
  let st: fs.Stats
  try {
    st = fs.statSync(p)
  } catch {
    return null
  }
  const key = `${p}:${st.mtimeMs}:${st.size}`
  if (fileCache?.key === key) return fileCache.theme
  let theme: Theme | null = null
  try {
    theme = build(fs.readFileSync(p, 'utf8'), themeName(p))
  } catch {
    theme = null
  }
  fileCache = { key, theme }
  return theme
}

function desktopFromUrl(u: string): Theme | null {
  const fresh = urlCache?.url === u && Date.now() - urlCache.at < 30_000
  if (!fresh && !urlInflight) {
    urlInflight = (async () => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'WhatsOps-theme/1' } })
        if (!r.ok) throw new Error(String(r.status))
        urlCache = { url: u, theme: build(await r.text(), 'desktop'), at: Date.now() }
      } catch {
        if (urlCache?.url === u) urlCache.at = Date.now() // keep last good, retry in 30 s
      } finally {
        urlInflight = null
      }
    })()
  }
  return urlCache?.url === u ? urlCache.theme : null
}

/** The live theme of the desktop this server runs on, if it has one. */
export function desktopTheme(): Theme | null {
  const o = (process.env.WA_THEME || '').trim()
  if (/^https?:\/\//i.test(o)) return desktopFromUrl(o)
  if (o) return desktopFromFile(o.replace(/^~(?=\/)/, os.homedir()))
  for (const p of desktopFiles()) {
    const t = desktopFromFile(p)
    if (t) return t
  }
  return null
}

export function normAppearance(v: unknown): Appearance {
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function currentTheme(appearance: unknown): Theme {
  const a = normAppearance(appearance)
  if (a === 'light') return LIGHT_THEME
  if (a === 'dark') return DARK_THEME
  return desktopTheme() ?? OS_THEME
}

/** Warm the URL cache at startup so the first page already has the right colors. */
export async function primeTheme(): Promise<void> {
  desktopTheme()
  if (urlInflight) await urlInflight
}
