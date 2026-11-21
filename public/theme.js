// Follow the theme (Light / Dark / System): when /theme.json changes hash, swap /theme.css without reloading the page.
;(() => {
  let cur = null
  const swap = (hash) => {
    const old = document.getElementById('omTheme')
    if (!old) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/theme.css?h=' + hash
    link.onload = () => { old.remove(); link.id = 'omTheme'; bar() }
    old.after(link)
  }
  // installed app (PWA / Omarchy web app): the window bar takes the color of the page header
  const bar = () => {
    const m = document.querySelector('meta[name=theme-color]')
    if (!m) return
    const el = document.querySelector('header') || document.body
    const c = el && getComputedStyle(el).backgroundColor
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') m.content = c
  }
  window.addEventListener('load', bar)
  const check = async () => {
    try {
      const r = await fetch('/theme.json', { cache: 'no-store' })
      if (!r.ok) return
      const j = await r.json()
      if (cur && j.hash !== cur) swap(j.hash)
      cur = j.hash
      document.documentElement.dataset.theme = j.name
    } catch {}
  }
  window.WA_THEME_CHECK = check
  check()
  setInterval(check, 10000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
})()
