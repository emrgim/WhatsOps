import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('appearance', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-theme-'))
  process.env.XDG_STATE_HOME = path.join(home, 'state')
  delete process.env.WA_THEME
  const { currentTheme, desktopTheme, desktopFiles } = await import('../src/theme.js')

  it('light and dark are fixed palettes', () => {
    const l = currentTheme('light'), d = currentTheme('dark')
    expect(l.mode).toBe('light')
    expect(l.css).toContain('color-scheme: light')
    expect(l.css).toContain('--wo-background: #ffffff')
    expect(d.mode).toBe('dark')
    expect(d.css).toContain('--wo-background: #121212')
    expect(l.hash).not.toBe(d.hash)
  })

  it('system follows the OS light/dark setting when the computer has no desktop theme', () => {
    expect(desktopTheme()).toBeNull()
    const s = currentTheme('system')
    expect(s.source).toBe('os')
    expect(s.css).toContain('@media (prefers-color-scheme: dark)')
    expect(currentTheme(undefined).source).toBe('os')
  })

  it('system follows the desktop theme live when there is one', () => {
    const file = desktopFiles()[0]
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '..', 'theme.name'), 'moodpeak\n')
    fs.writeFileSync(file, 'accent = "#4ecdc4"\nbackground = "#181c22"\nforeground = "#e0e6ed"\n')
    const a = currentTheme('system')
    expect(a.source).toBe('desktop')
    expect(a.name).toBe('moodpeak')
    expect(a.mode).toBe('dark')
    expect(a.css).toContain('--wo-accent: #4ecdc4')
    expect(a.css).not.toMatch(new RegExp(path.basename(path.dirname(path.dirname(dir))), 'i'))
    // theme switch on the desktop → new colors, new hash
    fs.writeFileSync(file, 'mode = "light"\naccent = "#1e66f5"\nbackground = "#eff1f5"\nforeground = "#4c4f69"\n')
    const t = Date.now() / 1000 + 5
    fs.utimesSync(file, t, t)
    const b = currentTheme('system')
    expect(b.mode).toBe('light')
    expect(b.css).toContain('--wo-accent: #1e66f5')
    expect(b.hash).not.toBe(a.hash)
    // light / dark still win over the desktop theme
    expect(currentTheme('dark').source).toBe('dark')
  })
})
