import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { IT_KEYS, fromAcceptLanguage, normLang, tr } from '../src/i18n.js'
import { AppError } from '../src/util.js'

const SRC = path.resolve(__dirname, '../src')
const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []))
const unq = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

/** every English string the server can show must have an Italian translation */
function serverStrings(): string[] {
  const out = new Set<string>()
  for (const f of files(SRC)) {
    if (f.endsWith('i18n.ts')) continue
    const s = fs.readFileSync(f, 'utf8')
    for (const m of s.matchAll(/new AppError\([^,]+,\s*'((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]))
    for (const m of s.matchAll(/\bL\('((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]))
    for (const m of s.matchAll(/\btr\([^,]+,\s*'((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]))
    for (const m of s.matchAll(/\btool\(\s*'[a-z_]+',\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g)) {
      out.add(unq(m[1]))
      out.add(unq(m[2]))
    }
  }
  return [...out]
}

describe('server i18n', () => {
  it('has an Italian translation for every server string', () => {
    const strings = serverStrings()
    expect(strings.length).toBeGreaterThan(100)
    const missing = strings.filter((s) => !IT_KEYS.includes(s))
    expect(missing).toEqual([])
  })
  it('resolves languages', () => {
    expect(normLang('it-IT')).toBe('it')
    expect(normLang('en_US.UTF-8')).toBe('en')
    expect(normLang('fr')).toBeNull()
    expect(fromAcceptLanguage('fr-FR,it;q=0.8,en;q=0.5')).toBe('it')
    expect(fromAcceptLanguage('*')).toBeNull()
  })
  it('localizes errors with params', () => {
    const e = new AppError('NOT_ON_WHATSAPP', '+{0} is not on WhatsApp', 404, ['39333'])
    expect(e.message).toBe('+39333 is not on WhatsApp')
    expect(tr('it', e.template, e.params)).toBe('+39333 non è su WhatsApp')
  })
})

describe('config page i18n', () => {
  const pub = path.resolve(__dirname, '../public')
  const ctx: Record<string, unknown> = { window: {}, navigator: { languages: ['en'] }, localStorage: { getItem: () => null }, document: { cookie: '' }, location: {} }
  vm.runInNewContext(fs.readFileSync(path.join(pub, 'i18n.js'), 'utf8'), ctx)
  const dict = (ctx.window as { WA_I18N: Record<string, Record<string, string>> }).WA_I18N
  it('en and it have the same keys', () => {
    expect(Object.keys(dict.it).sort()).toEqual(Object.keys(dict.en).sort())
  })
  it('every key used by the page exists', () => {
    const html = fs.readFileSync(path.join(pub, 'app.html'), 'utf8')
    const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8')
    const used = new Set<string>()
    for (const m of html.matchAll(/data-i18n(?:-html|-ph)?="([^"]+)"/g)) used.add(m[1])
    for (const m of js.matchAll(/\bt\('([^']+)'/g)) if (!m[1].endsWith('.')) used.add(m[1])
    for (const m of js.matchAll(/t\((?:[a-z.]+ \? )'([^']+)' : '([^']+)'\)/g)) { used.add(m[1]); used.add(m[2]) }
    const missing = [...used].filter((k) => !(k in dict.en))
    expect(missing).toEqual([])
  })
})
