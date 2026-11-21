'use strict'
/* global t, applyI18n, WA_LANG, WA_API_IT */
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ORIGIN = location.origin
const MCP = ORIGIN + '/mcp'
const LOCALE = WA_LANG === 'it' ? 'it-IT' : 'en-GB'
let state = { overview: null, accounts: [] }
let pairing = null // { id, timer }

document.title = t('title')
applyI18n()

function toast(msg, err = false) {
  const d = document.createElement('div')
  d.textContent = msg
  if (err) d.className = 'err'
  $('#toast').appendChild(d)
  setTimeout(() => d.remove(), err ? 7000 : 3500)
}

async function api(method, url, body) {
  const headers = { 'accept-language': WA_LANG }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(url, { method, credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  if (r.status === 401 && !url.startsWith('/auth')) { location.reload(); throw new Error(t('sessionExpired')) }
  let j = null
  try { j = await r.json() } catch { j = null }
  if (!r.ok) throw new Error((j && j.error && (j.error.message || j.error)) || `HTTP ${r.status}`)
  return j
}
const run = (fn) => async (...a) => { try { await fn(...a) } catch (e) { toast(e.message, true) } }

function copy(text) { navigator.clipboard.writeText(text).then(() => toast(t('copied'))) }
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy],[data-copy-el]')
  if (!b) return
  e.preventDefault()
  copy(b.dataset.copy ?? $('#' + b.dataset.copyEl).textContent)
})
const fmtDate = (v) => (v ? new Date(typeof v === 'number' ? v : Date.parse(v)).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : '—')
const num = (n) => Number(n ?? 0).toLocaleString(LOCALE)

// ---------------------------------------------------------------- grid / list view (per list, remembered in this browser)
const viewOf = (id) => (localStorage.getItem('wo.view.' + id) === 'list' ? 'list' : 'grid')
function applyView(id) {
  const v = viewOf(id)
  const el = document.getElementById(id)
  if (el) { el.classList.toggle('view-list', v === 'list'); el.classList.toggle('view-grid', v === 'grid') }
  $$(`.viewsw[data-view-for="${id}"] button`).forEach((b) => { b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-pressed', String(b.dataset.view === v)) })
}
$$('.viewsw').forEach((w) => {
  w.querySelectorAll('button').forEach((b) => { b.title = t(b.dataset.i18nTitle); b.setAttribute('aria-label', b.title) })
  w.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]')
    if (!b) return
    localStorage.setItem('wo.view.' + w.dataset.viewFor, b.dataset.view)
    applyView(w.dataset.viewFor)
  })
  applyView(w.dataset.viewFor)
})

// ---------------------------------------------------------------- tabs
// top tabs: numbers · connectors (mcp / api / hooks) · settings (general / db)
const SUBS = { connect: ['plugins', 'mcp', 'api', 'hooks'], settings: ['general', 'users', 'updates', 'db', 'log', 'voice', 'feedback', 'backup', 'license'] }
const LEGACY = { keys: 'connect/api', hooks: 'connect/hooks', db: 'settings/db' }
const lastSub = { connect: 'plugins', settings: 'general' }
let routeItem = null // third part of the route: #connect/mcp/cursor
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))
$$('.subnav button').forEach((b) => b.addEventListener('click', () => showTab(b.closest('.subnav').dataset.for, b.dataset.sub)))
function showTab(tab, sub, item) {
  routeItem = item || null
  if (SUBS[tab]) { sub = SUBS[tab].includes(sub) ? sub : lastSub[tab]; lastSub[tab] = sub } else sub = undefined
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab))
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === tab))
  $$('.subnav').forEach((n) => { n.hidden = n.dataset.for !== tab })
  $('.subbar').classList.toggle('on', !!sub)
  if (sub) {
    $$(`.subnav[data-for=${tab}] button`).forEach((b) => b.classList.toggle('on', b.dataset.sub === sub))
    $$('.sub', $('#' + tab)).forEach((d) => d.classList.toggle('on', d.id === tab + '-' + sub))
  }
  window.scrollTo(0, 0)
  const route = sub ? tab + '/' + sub : tab
  if (route !== 'settings/log') stopLogLive()
  history.replaceState(null, '', '#' + route + (routeItem ? '/' + routeItem : ''))
  loaders[route]?.()
}
$('#logout').addEventListener('click', run(async () => { await api('POST', '/auth/logout'); location.reload() }))

// ---------------------------------------------------------------- numbers
const STATE_CLASS = { open: 'open', connecting: 'warn', reconnecting: 'warn', qr: 'warn', pairing_code: 'warn', not_linked: 'bad', logged_out: 'bad', replaced: 'bad', pairing_expired: 'bad', error: 'bad', stopped: '' }
function badge(s) { return `<span class="badge ${STATE_CLASS[s] ?? ''}">${esc(t('state.' + s))}</span>` }

async function loadOverview() {
  state.overview = await api('GET', '/v1/admin/overview')
  state.accounts = state.overview.accounts
  // only the version: the server's address is not shown in the page (self-hosted, his decision)
  $('#host').textContent = state.overview.versionLabel || state.overview.version
  $('.subnav[data-for=settings] [data-sub=license]').hidden = !state.overview.license?.enabled
  renderAccounts()
  fillAccountSelects()
}

function renderAccounts() {
  const el = $('#accounts')
  if (!state.accounts.length) {
    el.innerHTML = `<div class="card"><p>${esc(t('numbers.empty'))}</p><p class="muted">${esc(t('numbers.emptyHint'))}</p></div>`
    return
  }
  el.innerHTML = state.accounts.map((a) => {
    const phone = a.me?.phone ?? (a.phone ? '+' + a.phone : '')
    const st = a.stats
    const linked = !!a.me
    return `<div class="card acc" data-id="${esc(a.id)}">
      <div class="top"><div class="who">${avatar(a)}<div><h4>${esc(a.name)} ${a.default ? `<span class="badge">${esc(t('acc.default'))}</span>` : ''}</h4>
        <div class="phone">${esc(phone || '—')}</div>${a.about ? `<div class="muted small about">${esc(a.about)}</div>` : ''}<div class="muted small">id <code>${esc(a.id)}</code></div></div></div>${badge(a.state)}</div>
      ${st ? `<div class="stats"><span><b>${num(st.chats)}</b> ${esc(t('acc.chats'))}</span><span><b>${num(st.messages)}</b> ${esc(t('acc.messages'))}</span><span><b>${num(st.contacts)}</b> ${esc(t('acc.contacts'))}</span><span><b>${num(st.groups)}</b> ${esc(t('acc.groups'))}</span></div>` : ''}
      ${a.lastDisconnect && a.state !== 'open' ? `<div class="muted small">${esc(t('acc.lastDisconnect', a.lastDisconnect.reason + (a.lastDisconnect.code ? ' (' + a.lastDisconnect.code + ')' : '')))}</div>` : ''}
      ${a.history && a.history.progress != null && a.history.progress < 100 ? `<div class="muted small">${esc(t('acc.history', a.history.progress, num(a.history.messages)))}</div>` : ''}
      <div class="actions">
        ${linked ? `<button class="small" data-act="profile">${esc(t('acc.profile'))}</button>` : ''}
        <button class="small${linked ? ' ghost' : ''}" data-act="pair">${esc(t(linked ? 'acc.relink' : 'acc.link'))}</button>
        ${linked && a.state !== 'open' ? `<button class="small ghost" data-act="restart">${esc(t('acc.reconnect'))}</button>` : ''}
        ${!a.default ? `<button class="small ghost" data-act="default">${esc(t('acc.makeDefault'))}</button>` : ''}
        <button class="small ghost" data-act="toggle">${esc(t(a.enabled ? 'acc.pause' : 'acc.resume'))}</button>
        <button class="small ghost" data-act="import">${esc(t('acc.import'))}</button>
        ${linked ? `<button class="small danger" data-act="logout">${esc(t('acc.logout'))}</button>` : ''}
        <button class="small danger" data-act="delete">${esc(t('acc.delete'))}</button>
      </div></div>`
  }).join('')
}

$('#accounts').addEventListener('click', run(async (e) => {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const id = b.closest('[data-id]').dataset.id
  const a = state.accounts.find((x) => x.id === id)
  switch (b.dataset.act) {
    case 'pair': return openPair(id)
    case 'profile': return openProfile(id)
    case 'restart': await api('POST', `/v1/accounts/${id}/restart`); toast(t('acc.reconnecting')); break
    case 'default': await api('PATCH', `/v1/accounts/${id}`, { isDefault: true }); break
    case 'toggle': await api('PATCH', `/v1/accounts/${id}`, { enabled: !a.enabled }); break
    case 'logout':
      if (!confirm(t('confirm.logout', a.name))) return
      await api('POST', `/v1/accounts/${id}/logout`); break
    case 'delete':
      if (!confirm(t('confirm.delete', a.name))) return
      await api('DELETE', `/v1/accounts/${id}`); break
    case 'import': return openImport(id)
  }
  await loadOverview()
}))

$('#addNumber').addEventListener('click', () => { $('#addForm').reset(); $('#addDlg').showModal() })
$('#addDlg').addEventListener('close', run(async () => {
  if ($('#addDlg').returnValue !== 'ok') return
  const f = new FormData($('#addForm'))
  const a = await api('POST', '/v1/accounts', { phone: f.get('phone') || undefined, syncHistory: f.get('sync') === 'on' })
  await loadOverview()
  openPair(a.id, f.get('phone'))
}))

// ---------------------------------------------------------------- profile (name · info · photo, edited on WhatsApp)
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() }
function avatar(a, big = false) {
  return a.photo
    ? `<img class="avatar${big ? ' big' : ''}" alt="" src="/v1/accounts/${encodeURIComponent(a.id)}/profile/photo?t=${Date.now() >> 16}">`
    : `<span class="avatar${big ? ' big' : ''}">${esc(initials(a.name))}</span>`
}
let profId = null
function openProfile(id) {
  const a = state.accounts.find((x) => x.id === id)
  if (!a) return
  if (a.state !== 'open') { toast(t('prof.offline'), true); return }
  profId = id
  $('#profForm').reset()
  $('#profAvatar').outerHTML = avatar(a, true).replace('class="avatar big"', 'class="avatar big" id="profAvatar"')
  $('#profPhone').textContent = a.me?.phone ?? ''
  $('#profForm').name.value = a.name
  $('#profForm').about.value = a.about ?? ''
  $('#profRemovePhoto').hidden = !a.photo
  $('#profDlg').showModal()
}
const fileToDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f) })
// preview the chosen photo before it is sent to WhatsApp
$('#profForm').photo.addEventListener('change', run(async (e) => {
  const f = e.target.files[0]
  if (!f) return
  $('#profAvatar').outerHTML = `<img class="avatar big" id="profAvatar" alt="" src="${await fileToDataUrl(f)}">`
}))
$('#profRemovePhoto').addEventListener('click', run(async () => {
  if (!confirm(t('prof.confirmRemove'))) return
  await api('DELETE', `/v1/accounts/${encodeURIComponent(profId)}/profile/photo`)
  $('#profDlg').close('cancel')
  toast(t('prof.saved'))
  await loadOverview()
}))
$('#profDlg').addEventListener('close', run(async () => {
  if ($('#profDlg').returnValue !== 'ok' || !profId) return
  const a = state.accounts.find((x) => x.id === profId)
  const f = $('#profForm')
  const body = {}
  if (f.name.value.trim() && f.name.value.trim() !== a.name) body.name = f.name.value.trim()
  if (f.about.value.trim() !== (a.about ?? '')) body.about = f.about.value.trim()
  if (Object.keys(body).length) await api('PATCH', `/v1/accounts/${encodeURIComponent(profId)}/profile`, body)
  const file = f.photo.files[0]
  if (file) await api('PUT', `/v1/accounts/${encodeURIComponent(profId)}/profile/photo`, { base64: await fileToDataUrl(file) })
  if (Object.keys(body).length || file) toast(t('prof.saved'))
  await loadOverview()
}))

// ---------------------------------------------------------------- pairing
function openPair(id, phone) {
  const a = state.accounts.find((x) => x.id === id)
  pairing = { id }
  $('#pairTitle').textContent = t('pair.title', a?.name ?? id)
  $('#pairChoose').hidden = false
  $('#pairShow').hidden = true
  $('#pairPhoneBox').hidden = true
  $('#pairPhone').value = phone || (a?.me?.phone ?? (a?.phone ? '+' + a.phone : ''))
  $('#pairDlg').showModal()
}
$('#pairDlg').addEventListener('close', () => {
  const p = pairing
  clearInterval(p?.timer)
  pairing = null
  if (!p) return
  // closing while a QR / code is still pending stops that pairing socket
  api('GET', `/v1/accounts/${p.id}/qr`)
    .then((r) => (['qr', 'pairing_code'].includes(r.state) ? api('POST', `/v1/accounts/${p.id}/restart`) : null))
    .catch(() => {})
    .finally(() => loadOverview().catch(() => {}))
})
$('#pairCodeBtn').addEventListener('click', () => { $('#pairPhoneBox').hidden = false; $('#pairPhone').focus() })
$('#pairQr').addEventListener('click', run(() => startPair('qr')))
$('#pairCodeGo').addEventListener('click', run(() => startPair('code', $('#pairPhone').value)))

async function startPair(method, phone) {
  const id = pairing.id
  const cur = state.accounts.find((x) => x.id === id)
  if (cur?.me && !confirm(t('pair.confirmRelink', cur.name, cur.me.phone))) return
  if (method === 'code' && !/\d{7,}/.test((phone || '').replace(/\D/g, ''))) throw new Error(t('pair.badPhone'))
  $('#pairChoose').hidden = true
  $('#pairShow').hidden = false
  $('#pairImg').hidden = true
  $('#pairCode').hidden = true
  $('#pairState').textContent = t('pair.starting')
  $('#pairHelp').innerHTML = t(method === 'qr' ? 'pair.helpQr' : 'pair.helpCode')
  const r = await api('POST', `/v1/accounts/${id}/login`, { method, phone, fresh: true })
  showPairState(r.state, r.qr, r.pairing?.code)
  clearInterval(pairing?.timer)
  if (pairing) pairing.timer = setInterval(pollPair, 2500)
}
async function pollPair() {
  if (!pairing) return
  const r = await api('GET', `/v1/accounts/${pairing.id}/qr`).catch(() => null)
  if (r) showPairState(r.state, r.qr, r.code)
}
function showPairState(s, qr, code) {
  if (qr) { $('#pairImg').src = qr; $('#pairImg').hidden = false }
  if (code) { $('#pairCode').textContent = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code; $('#pairCode').hidden = false }
  const key = 'pair.s.' + s
  const msg = t(key)
  $('#pairState').textContent = msg === key ? s : msg
  if (s === 'open') { $('#pairImg').hidden = true; $('#pairCode').hidden = true; clearInterval(pairing?.timer); setTimeout(() => $('#pairDlg').open && $('#pairDlg').close(), 1500) }
  if (['pairing_expired', 'logged_out', 'error'].includes(s)) { clearInterval(pairing?.timer); $('#pairImg').hidden = true; $('#pairChoose').hidden = false }
}

function openImport(id) { $('#importForm').reset(); $('#importDlg').dataset.id = id; $('#importDlg').showModal() }
$('#importDlg').addEventListener('close', run(async () => {
  if ($('#importDlg').returnValue !== 'ok') return
  const f = new FormData($('#importForm'))
  const body = { sessionDir: f.get('sessionDir') || undefined, historyDb: f.get('historyDb') || undefined }
  if (!body.sessionDir && !body.historyDb) return
  toast(t('import.running'))
  const r = await api('POST', `/v1/accounts/${$('#importDlg').dataset.id}/import`, body)
  const parts = []
  if (r.session) parts.push(t('import.keys', num(r.session.keys)))
  if (r.history) parts.push(t('import.msgs', num(r.history.messages), num(r.history.chats)))
  toast(t('import.done', parts.join(' · ')))
  await loadOverview()
}))

// ---------------------------------------------------------------- live events
function startEvents() {
  const es = new EventSource('/v1/events')
  let timer = null
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => loadOverview().catch(() => {}), 600) }
  es.addEventListener('connection.update', refresh)
  es.addEventListener('history.sync', refresh)
  es.addEventListener('profile.update', refresh)
  es.addEventListener('pairing.qr', (e) => { const d = JSON.parse(e.data); if (pairing && d.account === pairing.id) pollPair() })
  es.addEventListener('pairing.code', (e) => { const d = JSON.parse(e.data); if (pairing && d.account === pairing.id) pollPair() })
}

// ---------------------------------------------------------------- connectors
// connectors: square tiles (logo + name); the settings of each app open when you enter its tile
const MCP_CLIENTS = [
  { id: 'cursor', name: 'Cursor', logo: 'cursor.svg', mono: true, match: /cursor/i },
  { id: 'claude', name: 'Claude', logo: 'claude.svg', match: /claude|anthropic/i },
  { id: 'chatgpt', name: 'ChatGPT', logo: 'chatgpt.svg', mono: true, match: /chatgpt|openai/i },
  { id: 'grok', name: 'Grok', logo: 'grok.svg', mono: true, match: /^grok$|grok\.com|^grok[^-\s]/i },
  { id: 'grokbot', name: 'Grok Bot', logo: 'grokbot.png', match: /grok[-\s]?bot/i },
  { id: 'hermes', name: 'Hermes', logo: 'hermes.png', match: /hermes/i },
  { id: 'gemini', name: 'Gemini', logo: 'gemini.svg', match: /gemini/i },
  { id: 'other', nameKey: 'connect.other.title', logo: 'mcp.svg', mono: true },
]
let PLUGINS = [] // from GET /v1/plugins
const clientName = (c) => (c.nameKey ? t(c.nameKey) : c.name)
function logo(c, big = false) {
  const u = `/static/logos/${c.logo}`
  return c.mono
    ? `<span class="logo mono${big ? ' big' : ''}" style="-webkit-mask-image:url(${u});mask-image:url(${u})" role="img" aria-label="${esc(clientName(c))}"></span>`
    : `<img class="logo${big ? ' big' : ''}" src="${u}" alt="${esc(clientName(c))}">`
}
function tiles(list, sub) {
  return list.map((c) => `<button type="button" class="tile" data-tile="${esc(c.id)}" data-sub="${sub}">${logo(c)}<span class="tile-name">${esc(clientName(c))}</span><span class="chev" aria-hidden="true">›</span></button>`).join('')
}
function detailHead(c, sub) {
  return `${sub ? `<div class="detail-head"><button type="button" class="ghost small" data-back="${sub}">← ${esc(sub === 'mcp' ? 'MCP' : t('sub.plugins'))}</button></div>` : ''}
    <div class="detail-title">${logo(c, true)}<h2>${esc(clientName(c))}</h2></div>`
}
function endpointLine() {
  return `<p class="muted"><span>${esc(t('connect.endpoint'))}</span> <code>${esc(MCP)}</code> <button class="ghost small" data-copy="${esc(MCP)}">${esc(t('copy'))}</button></p>`
}
function mcpSetup(id) {
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=whatsops&config=${encodeURIComponent(btoa(JSON.stringify({ url: MCP })))}`
  switch (id) {
    case 'cursor': return `<p class="muted">${esc(t('connect.cursor.hint'))}</p><p><a href="${esc(cursorLink)}"><button type="button">${esc(t('connect.cursor.add'))}</button></a></p>
      <pre>${esc(JSON.stringify({ mcpServers: { whatsops: { url: MCP } } }, null, 2))}</pre><p class="muted small">${t('connect.cursor.plugin')}</p>`
    case 'claude': return `<p class="muted">${t('connect.claude.hint')}</p><pre>${esc(MCP)}</pre>
      <p class="muted">${esc(t('connect.claude.code'))}</p><pre>claude mcp add --transport http whatsops ${esc(MCP)}</pre>`
    case 'chatgpt': return `<p class="muted">${esc(t('connect.chatgpt.hint'))}</p><pre>${esc(MCP)}</pre>`
    case 'grok': return `<p class="muted">${esc(t('connect.grok.hint'))}</p><pre>Server URL: ${esc(MCP)}
Client ID: grok
Client Secret: ${esc(t('connect.empty'))}
Authorization Endpoint: ${esc(ORIGIN)}/oauth/authorize
Token Endpoint: ${esc(ORIGIN)}/oauth/token
Scopes: read send
Token Auth Method: none (PKCE)</pre>`
    case 'grokbot': return `<p class="muted">${esc(t('connect.grokbot.hint'))}</p><div id="grokBotOut"><button type="button" class="ghost" data-mk="grokbot">${esc(t('connect.grokbot.mk'))}</button></div>`
    case 'hermes': return `<p class="muted">${esc(t('connect.hermes.hint'))}</p><div id="hermesOut"><button type="button" class="ghost" data-mk="hermes">${esc(t('connect.hermes.mk'))}</button></div>`
    case 'gemini': return `<p class="muted">${esc(t('connect.gemini.hint'))}</p><pre>gemini mcp add --transport http whatsops ${esc(MCP)}</pre>
      <pre>${esc(JSON.stringify({ mcpServers: { whatsops: { httpUrl: MCP } } }, null, 2))}</pre><p class="muted small">${esc(t('connect.gemini.auth'))}</p>`
    default: return `<p class="muted">${esc(t('connect.other.hint'))}</p><pre>${esc(MCP)}</pre>
      <p class="muted">${esc(t('connect.other.stdio'))}</p><pre>WA_MCP_URL=${esc(MCP)} WA_API_KEY=wam_… mcp-mrg-whatsops stdio</pre>`
  }
}
const grantOf = (g) => MCP_CLIENTS.find((c) => c.match && (c.match.test(g.clientId) || c.match.test(g.clientName)))?.id ?? 'other'
async function loadConnect() {
  const item = routeItem
  const c = item && MCP_CLIENTS.find((x) => x.id === item)
  $('#mcpTiles').hidden = !!c
  $('#mcpBar').hidden = !!c
  $('#mcpDetail').hidden = !c
  if (!c) { $('#mcpTiles').innerHTML = tiles(MCP_CLIENTS, 'mcp'); return }
  $('#mcpDetail').innerHTML = `${detailHead(c, 'mcp')}<div class="card client">${endpointLine()}${mcpSetup(c.id)}</div>
    <div class="card"><h3>${esc(t('connect.appGrants'))}</h3><div id="grants"></div></div>`
  const o = await api('GET', '/v1/admin/oauth')
  const mine = o.grants.filter((g) => grantOf(g) === c.id)
  $('#grants').innerHTML = mine.length
    ? `<table><tr><th>${t('th.app')}</th><th>${t('th.scopes')}</th><th>${t('th.authorized')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${mine.map((g) => `<tr><td>${esc(g.clientName)}</td><td>${esc(g.scopes)}</td><td>${fmtDate(g.createdAt)}</td><td>${fmtDate(g.lastUsed)}</td><td><button class="small danger" data-revoke-grant="${esc(g.family)}">${esc(t('revoke'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('connect.noGrants'))}</p>`
}
async function loadPlugins() {
  PLUGINS = await api('GET', '/v1/plugins')
  let item = routeItem
  // a user with one plugin goes straight into it
  if (!item && isUser() && PLUGINS.length === 1) { item = routeItem = PLUGINS[0].id; history.replaceState(null, '', '#connect/plugins/' + item) }
  const c = item && PLUGINS.find((x) => x.id === item)
  $('#pluginTiles').hidden = !!c
  $('#pluginBar').hidden = !!c || !PLUGINS.length
  $('#pluginDetail').hidden = !c
  if (c) {
    if (c.id === 'currentrms') { const st = await api('GET', CRMS); $('#pluginDetail').innerHTML = (isUser() && PLUGINS.length === 1 ? detailHead(c, null) : detailHead(c, 'plugins')) + CRMS_HTML(st); await crmsLoad(st) }
    else if (c.id === 'rentman') { const st = await api('GET', RM); $('#pluginDetail').innerHTML = (isUser() && PLUGINS.length === 1 ? detailHead(c, null) : detailHead(c, 'plugins')) + RM_HTML(st); await rmLoad(st) }
    else $('#pluginDetail').innerHTML = detailHead(c, 'plugins')
    return
  }
  $('#pluginTiles').innerHTML = PLUGINS.length ? tiles(PLUGINS, 'plugins') : `<p class="muted">${esc(t(isUser() ? 'plugins.noneUser' : 'plugins.none'))}</p>`
}
const isUser = () => state.me?.role === 'user'

// ---------------------------------------------------------------- plugin: Current RMS
const CRMS = '/v1/plugins/currentrms'
let crmsTimer = null
const crmsCan = (st) => ({ manage: !st.me || st.me.manage, owner: !isUser() })
const CRMS_HTML = (st) => {
  const can = crmsCan(st)
  const mine = st.me ? `<div class="card"><p>${esc(t(st.me.scope === 'all' ? 'crms.me.all' : 'crms.me.owned'))}</p>${st.me.scope !== 'all' && !st.me.member ? `<p class="muted small">${esc(t('crms.me.noMember'))}</p>` : ''}</div>` : ''
  const discussions = `
  <div class="card">
    <div class="crms-bar"><h3>${esc(t('crms.discussions'))}</h3><input type="search" id="crmsQ" placeholder="${esc(t('crms.search'))}"><button type="button" class="ghost small" data-crms="refresh">${esc(t('crms.refresh'))}</button></div>
    <p class="muted small" id="crmsInfo"></p>
    <div id="crmsTree"></div>
  </div>`
  if (!can.manage) return mine + discussions
  return mine + `
  <form class="card form" id="crmsConn">
    <h3>${esc(t('crms.conn'))}</h3>
    <div class="row"><label><span>${esc(t('crms.subdomain'))}</span> <input name="subdomain" placeholder="${esc(t('crms.subdomainPh'))}" autocomplete="off" spellcheck="false"></label>
      <label><span>${esc(t('crms.apiKey'))}</span> <input name="apiKey" type="password" autocomplete="new-password" spellcheck="false"></label></div>
    <p class="muted small">${esc(t('crms.keyHint'))}</p>
    <div class="row"><button type="submit">${esc(t('save'))}</button><button type="button" class="ghost" data-crms="test">${esc(t('crms.test'))}</button></div>
    <p id="crmsConnState" class="small"></p>
  </form>
  <form class="card form" id="crmsSet">
    <h3>${esc(t('crms.settings'))}</h3>
    ${can.owner ? `<label><span>${esc(t('crms.account'))}</span> <select name="account"></select></label>
    <p class="muted small">${esc(t('crms.accountHint'))}</p>
    <label><span>${esc(t('crms.backup'))}</span> <select name="backupAccount"></select></label>
    <p class="muted small">${esc(t('crms.backupHint'))}</p>` : ''}
    <div><span class="muted small">${esc(t('crms.mode'))}</span><br><div class="seg" role="radiogroup">
      <label><input type="radio" name="mode" value="groups"><span>${esc(t('crms.mode.groups'))}</span></label>
      <label><input type="radio" name="mode" value="community"><span>${esc(t('crms.mode.community'))}</span></label></div>
      <p class="muted small" id="crmsModeHint"></p></div>
    <div class="crms-levels"><span class="muted small">${esc(t('crms.levels'))}</span>
      <div class="crms-lv-wrap"><table class="crms-lv"><thead><tr><th></th><th>${esc(t('crms.lv.objects'))}</th><th>${esc(t('crms.lv.discussions'))}</th><th>${esc(t('crms.lv.messages'))}</th></tr></thead>
      <tbody>${CRMS_LV.map((ty) => `<tr><th>${esc(t('crms.types.' + ty))}</th>${['objects', 'discussions', 'messages'].map((k) => `<td><input type="checkbox" data-lv="${ty}" data-lk="${k}" aria-label="${esc(t('crms.types.' + ty) + ' · ' + t('crms.lv.' + k))}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="muted small">${esc(t('crms.lv.hint'))}</p>
      <p class="muted small">${esc(t('crms.lv.cost'))}</p></div>
    <label class="inline"><input type="checkbox" name="ownerAdmin"> <span>${esc(t('crms.ownerAdmin'))}</span></label>
    <p class="muted small">${esc(t('crms.ownerAdminHint'))}</p>
    <label><span>${esc(t('crms.field'))}</span> <select name="whatsappField"></select></label>
    <p class="muted small">${esc(t('crms.fieldHint'))}</p>
    <label class="inline"><input type="checkbox" name="inviteFallback"> <span>${esc(t('crms.invite'))}</span></label>
    <button type="submit">${esc(t('save'))}</button>
  </form>
  <div class="card" id="crmsUsersCard">
    <h3>${esc(t('crms.u.title'))}</h3>
    <p class="muted small">${esc(t(can.owner ? 'crms.u.hintOwner' : 'crms.u.hint'))}</p>
    <div id="crmsUsers"></div>
  </div>
  <div class="card form">
    <h3>${esc(t('crms.hooks'))}</h3>
    <p id="crmsHookState"></p>
    <p class="muted small">${esc(t('crms.hooksHint'))}</p>
    <button type="button" class="ghost" data-crms="hooks">${esc(t('crms.hooksGo'))}</button>
    <div><span class="muted small">${esc(t('crms.poll'))}</span><br><div class="seg" role="radiogroup" id="crmsPoll">
      ${[2, 5, 15, 30].map((m) => `<label><input type="radio" name="pollMinutes" value="${m}"><span>${esc(t('crms.pollMin', m))}</span></label>`).join('')}</div>
      <p class="muted small" id="crmsPollHint"></p></div>
  </div>` + discussions
}
function crmsHookState(c) {
  const every = c.pollMinutes || 2
  const hookErr = c.hooksError === 'NO_PUBLIC_URL' ? t('crms.hooksNoPublic', every) : c.hooksError
  $('#crmsHookState').textContent = c.hooks?.length ? t('crms.hooksOn', c.hooks.length) + (hookErr ? ' · ' + hookErr : '') : hookErr || t('crms.hooksOff', every)
  $$('#crmsPoll input').forEach((i) => { i.checked = Number(i.value) === every })
  $('#crmsPollHint').textContent = t(c.hooks?.length ? 'crms.pollHintHooks' : 'crms.pollHint', every)
}
function crmsModeHint(mode) { const el = $('#crmsModeHint'); if (el) el.textContent = t(mode === 'community' ? 'crms.modeHint.community' : 'crms.modeHint.groups') }
async function crmsLoad(st) {
  const s = st ?? (await api('GET', CRMS))
  const c = s.config
  const f1 = $('#crmsConn'), f2 = $('#crmsSet')
  if (f1 && f2) {
    f1.subdomain.value = c.subdomain || ''
    f1.apiKey.placeholder = c.apiKeySet ? t('crms.keySaved') : ''
    if (f2.account) {
      const accs = state.accounts ?? []
      const opt = (a) => `<option value="${esc(a.id)}">${esc(a.name)} ${esc(a.me?.phone ?? '')}</option>`
      f2.account.innerHTML = accs.map(opt).join('')
      f2.account.value = c.account || (accs.find((a) => a.default)?.id ?? '')
      f2.backupAccount.innerHTML = `<option value="">${esc(t('crms.backupNone'))}</option>` + accs.filter((a) => a.id !== f2.account.value).map(opt).join('')
      f2.backupAccount.value = c.backupAccount || ''
    }
    $$('input[name=mode]', f2).forEach((i) => { i.checked = i.value === (c.mode || 'groups') })
    crmsModeHint(c.mode)
    $$('[data-lv]', f2).forEach((i) => { const l = c.levels?.[i.dataset.lv]; i.checked = l ? !!l[i.dataset.lk] : i.dataset.lk === 'messages' })
    f2.inviteFallback.checked = c.inviteFallback !== false
    f2.ownerAdmin.checked = c.ownerAdmin !== false
    f2.whatsappField.innerHTML = `<option value="">${esc(t('crms.fieldNone'))}</option>` + (c.whatsappField ? `<option value="${esc(c.whatsappField)}">${esc(c.whatsappField)}</option>` : '')
    f2.whatsappField.value = c.whatsappField || ''
    crmsHookState(c)
    $('#crmsConnState').textContent = s.configured ? t('crms.connected', c.subdomain) : t('crms.notConnected')
    if (s.configured) {
      api('GET', CRMS + '/custom-fields').then((fields) => {
        f2.whatsappField.innerHTML = `<option value="">${esc(t('crms.fieldNone'))}</option>` + fields.map((x) => `<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('')
        f2.whatsappField.value = c.whatsappField || ''
      }).catch(() => {})
      crmsUsers().catch((e) => { $('#crmsUsers').innerHTML = `<p class="small err-text">${esc(e.message)}</p>` })
    } else $('#crmsUsers').innerHTML = `<p class="muted">${esc(t('crms.u.connectFirst'))}</p>`
  }
  if (s.configured) await crmsTree()
  else $('#crmsTree').innerHTML = `<p class="muted">${esc(t(f1 ? 'crms.connectFirst' : 'crms.notConnected'))}</p>`
}
async function crmsUsers() {
  const el = $('#crmsUsers')
  if (!el) return
  const list = await api('GET', CRMS + '/users')
  const owner = !isUser()
  el.innerHTML = list.length ? list.map((u) => {
    const acc = u.access && u.access.active && u.access.access
    return `<div class="crms-user">
    <div class="crms-user-main"><b>${esc(u.name)}</b> <span class="muted small">${esc(u.email || '')}</span>
      <div class="small">${u.phone ? `${esc('+' + u.phone)} <span class="muted">· ${esc(t(u.phoneSource === 'confirmed' ? 'crms.u.confirmed' : 'crms.u.fromRms'))}</span>` : `<span class="muted">${esc(t('crms.u.noPhone'))}</span>`} <span class="muted">· ${esc(t('crms.u.records', u.records))}</span></div>
      ${u.invite ? `<div class="muted small">${esc(t('crms.u.inviteUntil', fmtDate(u.invite.expiresAt)))}</div>` : ''}
      <div class="crms-invite-out reveal" hidden></div>
    </div>
    <div class="crms-user-actions">
      <button type="button" class="ghost small" data-uinv="${esc(u.id)}" data-uname="${esc(u.name)}">${esc(t('crms.u.invite'))}</button>
      ${u.phoneSource === 'confirmed' ? `<button type="button" class="ghost small" data-uforget="${esc(u.id)}">${esc(t('crms.u.forget'))}</button>` : ''}
    </div>
    ${owner ? `<div class="crms-user-access">
      <label class="inline"><span class="switch"><input type="checkbox" data-uacc="${esc(u.id)}" ${acc ? 'checked' : ''}><span></span></span> <span>${esc(t('crms.u.access'))}</span></label>
      <select data-uscope="${esc(u.id)}" ${acc ? '' : 'disabled'}><option value="owned">${esc(t('crms.u.scope.owned'))}</option><option value="all">${esc(t('crms.u.scope.all'))}</option></select>
      <label class="inline small"><input type="checkbox" data-umanage="${esc(u.id)}" ${u.access?.manage ? 'checked' : ''} ${acc ? '' : 'disabled'}> <span>${esc(t('crms.u.manage'))}</span></label>
      ${u.access?.lastLogin ? `<span class="muted small">${esc(t('users.lastLogin', fmtDate(u.access.lastLogin)))}</span>` : ''}
    </div>` : ''}
  </div>` }).join('') : `<p class="muted">${esc(t('crms.u.none'))}</p>`
  for (const u of list) { const sel = el.querySelector(`[data-uscope="${CSS.escape(u.id)}"]`); if (sel) sel.value = u.access?.scope || 'owned' }
}
const CRMS_TYPES = ['Opportunity', 'Project', 'Member', 'Invoice', 'Item', 'Product', 'Service', 'Activity', 'Quarantine', 'PurchaseOrder']
const CRMS_LV = ['Opportunity', 'Project', 'Product', 'Service', 'Member', 'Invoice', 'Activity', 'Quarantine', 'PurchaseOrder']
const crmsBadge = (s) => (s === 'on' ? 'open' : s === 'error' ? 'bad' : s === 'creating' || s === 'queued' ? 'warn' : '')
async function crmsRefresh() {
  $('#crmsInfo').textContent = t('crms.reading')
  const s = await api('POST', CRMS + '/refresh')
  await crmsTree()
  if (s.refreshing) crmsWatch()
}
function crmsWatch() {
  setTimeout(async () => {
    if (routeItem !== 'currentrms') return
    const s = await api('GET', CRMS).catch(() => null)
    await crmsTree().catch(() => {})
    if (s?.refreshing) { $('#crmsInfo').textContent += ' · ' + t('crms.reading'); crmsWatch() }
  }, 5000)
}
async function crmsTree() {
  const q = $('#crmsQ')?.value ?? ''
  const tree = await api('GET', CRMS + '/discussions' + (q ? '?q=' + encodeURIComponent(q) : ''))
  const n = tree.reduce((a, g) => a + g.discussions.length, 0)
  const on = tree.reduce((a, g) => a + g.discussions.filter((d) => d.sync).length, 0)
  const recs = tree.filter((g) => g.group?.sync).length
  $('#crmsInfo').textContent = t('crms.count', num(tree.length), num(n), num(on), num(recs))
  $('#crmsTree').innerHTML = tree.length ? tree.map((g) => `<div class="crms-rec">
      <div class="crms-rec-head"><span class="badge">${esc(CRMS_TYPES.includes(g.type) ? t('crms.type.' + g.type) : g.type)}</span> <b>${esc(g.name)}</b>${g.owner ? ` <span class="muted small" title="${esc(t(g.owner.whatsapp ? 'crms.ownerOk' : 'crms.ownerNoPhone'))}">${esc(t('crms.owner', g.owner.name))}${g.owner.whatsapp ? ' ✓' : ''}</span>` : ''} <a class="small" href="${esc(g.url)}" target="_blank" rel="noopener">${esc(t('crms.open'))} ↗</a>
        <span class="crms-rec-group"><label class="switch" title="${esc(t('crms.recGroup'))}"><input type="checkbox" ${g.group?.sync ? 'checked' : ''} data-objsync="${esc(g.type)}" data-oid="${esc(g.id)}"><span></span></label> <span class="small">${esc(t('crms.recGroup'))}</span>${g.group ? ` <span class="badge ${crmsBadge(g.group.state)}">${esc(t(g.group.state === 'on' ? 'crms.state.group' : 'crms.state.' + (g.group.state || 'off')))}</span>` : ''}</span></div>
      ${g.group?.error ? `<div class="small err-text">${esc(g.group.error)}</div>` : ''}
      ${g.discussions.length ? '' : `<p class="muted small crms-nodisc">${esc(t('crms.noDisc'))}</p>`}
      ${g.discussions.map((d) => `<div class="crms-disc" data-disc="${esc(d.id)}">
        <label class="switch" title="${esc(t('crms.syncToggle'))}"><input type="checkbox" ${d.sync ? 'checked' : ''} data-sync="${esc(d.id)}" data-msg="${d.messages ? 1 : 0}"><span></span></label>
        <div class="crms-disc-main"><div><b>${esc(d.subject || '#' + d.id)}</b></div>
          <div class="muted small">${esc(t('crms.people', d.participants.length, d.participants.filter((p) => p.whatsapp).length))}${d.replies != null ? ' · ' + esc(t('crms.replies', d.replies)) : ''}${d.lastAt ? ' · ' + esc(fmtDate(d.lastAt)) : ''}</div>
          ${d.participants.length ? `<div class="muted small">${d.participants.map((p) => esc(p.name) + (p.whatsapp ? ' ✓' : '')).join(', ')}</div>` : ''}
          ${d.error ? `<div class="small err-text">${esc(d.error)}</div>` : ''}</div>
        <span class="badge ${crmsBadge(d.state)}">${esc(t(d.state === 'on' && !d.messages ? 'crms.state.onNoMsg' : 'crms.state.' + (d.state || 'off')))}</span>
      </div>`).join('')}</div>`).join('') : `<p class="muted">${esc(t(isUser() ? 'crms.noneMine' : 'crms.none'))}</p>`
  clearTimeout(crmsTimer)
  const busy = (s) => s === 'creating' || s === 'queued'
  if (tree.some((g) => busy(g.group?.state) || g.discussions.some((d) => busy(d.state)))) crmsTimer = setTimeout(() => routeItem === 'currentrms' && crmsTree().catch(() => {}), 4000)
}
document.addEventListener('submit', run(async (e) => {
  if (e.target.id === 'crmsConn') {
    e.preventDefault()
    const f = e.target
    await api('PUT', CRMS + '/config', { subdomain: f.subdomain.value, ...(f.apiKey.value ? { apiKey: f.apiKey.value } : {}) })
    f.apiKey.value = ''
    const r = await api('POST', CRMS + '/test')
    toast(t('crms.testOk', num(r.discussions)))
    await crmsLoad()
    await crmsRefresh()
  } else if (e.target.id === 'crmsSet') {
    e.preventDefault()
    const f = e.target
    await api('PUT', CRMS + '/config', {
      ...(f.account ? { account: f.account.value, backupAccount: f.backupAccount.value } : {}),
      mode: f.querySelector('input[name=mode]:checked')?.value ?? 'groups', whatsappField: f.whatsappField.value, inviteFallback: f.inviteFallback.checked, ownerAdmin: f.ownerAdmin.checked,
      levels: Object.fromEntries(CRMS_LV.map((ty) => [ty, Object.fromEntries(['objects', 'discussions', 'messages'].map((k) => [k, !!f.querySelector(`[data-lv="${ty}"][data-lk="${k}"]`)?.checked]))])),
    })
    toast(t('saved'))
  }
}))
document.addEventListener('change', run(async (e) => {
  if (e.target.name === 'mode' && e.target.closest('#crmsSet')) crmsModeHint(e.target.value)
  if (e.target.name === 'account' && e.target.closest('#crmsSet')) {
    const f = e.target.form, keep = f.backupAccount.value
    f.backupAccount.innerHTML = `<option value="">${esc(t('crms.backupNone'))}</option>` + (state.accounts ?? []).filter((a) => a.id !== f.account.value).map((a) => `<option value="${esc(a.id)}">${esc(a.name)} ${esc(a.me?.phone ?? '')}</option>`).join('')
    f.backupAccount.value = keep !== f.account.value ? keep : ''
  }
  if (e.target.name === 'pollMinutes' && e.target.closest('#crmsPoll')) {
    const s = await api('PUT', CRMS + '/config', { pollMinutes: Number(e.target.value) })
    crmsHookState(s.config)
    toast(t('saved'))
    return
  }
  const acc = e.target.closest('[data-uacc],[data-uscope],[data-umanage]')
  if (acc) {
    const id = acc.dataset.uacc ?? acc.dataset.uscope ?? acc.dataset.umanage
    const body = acc.dataset.uacc !== undefined ? { access: acc.checked } : acc.dataset.uscope !== undefined ? { scope: acc.value } : { manage: acc.checked }
    try { await api('PUT', `${CRMS}/users/${encodeURIComponent(id)}/access`, body) } finally { await crmsUsers() }
    toast(t('saved'))
    return
  }
  const ob = e.target.closest('[data-objsync]')
  if (ob) {
    const on = ob.checked
    if (on && !confirm(t('crms.confirmObj'))) { ob.checked = false; return }
    try { await api('PUT', `${CRMS}/records/${encodeURIComponent(ob.dataset.objsync)}/${encodeURIComponent(ob.dataset.oid)}`, { group: on }) } catch (x) { ob.checked = !on; throw x }
    await crmsTree()
    return
  }
  const sw = e.target.closest('[data-sync]')
  if (!sw) return
  const on = sw.checked
  if (on && !confirm(t(sw.dataset.msg === '0' ? 'crms.confirmOnNoMsg' : 'crms.confirmOn'))) { sw.checked = false; return }
  try { await api('PUT', `${CRMS}/discussions/${encodeURIComponent(sw.dataset.sync)}`, { sync: on }) } catch (x) { sw.checked = !on; throw x }
  await crmsTree()
}))
document.addEventListener('click', run(async (e) => {
  const inv = e.target.closest('[data-uinv]')
  if (inv) {
    const r = await api('POST', `${CRMS}/users/${encodeURIComponent(inv.dataset.uinv)}/invite`)
    const out = inv.closest('.crms-user').querySelector('.crms-invite-out')
    out.hidden = false
    out.innerHTML = `<code>${esc(r.url)}</code><button type="button" class="small" data-copy="${esc(r.url)}">${esc(t('copy'))}</button><p class="muted small">${esc(t('crms.u.inviteHint', inv.dataset.uname, fmtDate(r.expiresAt)))}</p>`
    return
  }
  const fg = e.target.closest('[data-uforget]')
  if (fg) {
    if (!confirm(t('crms.u.forgetConfirm'))) return
    await api('DELETE', `${CRMS}/users/${encodeURIComponent(fg.dataset.uforget)}/phone`)
    await crmsUsers()
    return
  }
  const b = e.target.closest('[data-crms]')
  if (!b) return
  b.disabled = true
  try {
    if (b.dataset.crms === 'test') { const r = await api('POST', CRMS + '/test'); toast(t('crms.testOk', num(r.discussions))) }
    if (b.dataset.crms === 'hooks') { const s = await api('POST', CRMS + '/webhooks'); crmsHookState(s.config) }
    if (b.dataset.crms === 'refresh') await crmsRefresh()
  } finally { b.disabled = false }
}))
let crmsQT = null
document.addEventListener('input', (e) => { if (e.target.id === 'crmsQ') { clearTimeout(crmsQT); crmsQT = setTimeout(() => crmsTree().catch(() => {}), 300) } })

// ---------------------------------------------------------------- plugin: Rentman
const RM = '/v1/plugins/rentman'
let rmTimer = null
const RM_MODES = ['project', 'subproject', 'department']
function RM_HTML(st) {
  const can = { manage: !st.me || st.me.manage, owner: !isUser() }
  const seg = (name, vals, label) => `<div class="seg" role="radiogroup">${vals.map((v) => `<label><input type="radio" name="${name}" value="${v}"><span>${esc(t(label + v))}</span></label>`).join('')}</div>`
  const mine = st.me ? `<div class="card"><p>${esc(t(st.me.scope === 'all' ? 'rm.me.all' : 'rm.me.owned'))}</p></div>` : ''
  return `${mine}
  <div class="card">
    <div class="crms-bar"><h3>${esc(t('rm.projects'))}</h3><input type="search" id="rmQ" placeholder="${esc(t('rm.search'))}"><button type="button" class="ghost small" data-rm="refresh">${esc(t('crms.refresh'))}</button></div>
    <p class="muted small" id="rmInfo"></p>
    <div id="rmList"></div>
  </div>
  ${can.manage ? `<form class="card form" id="rmConn">
    <h3>${esc(t('crms.conn'))}</h3>
    <label><span>${esc(t('rm.token'))}</span> <input name="token" type="password" autocomplete="new-password" spellcheck="false"></label>
    <p class="muted small">${esc(t('rm.tokenHint'))}</p>
    <div class="row"><button type="submit">${esc(t('save'))}</button><button type="button" class="ghost" data-rm="test">${esc(t('crms.test'))}</button></div>
    <p id="rmConnState" class="small"></p>
  </form>
  <form class="card form" id="rmSet">
    <h3>${esc(t('crms.settings'))}</h3>
    ${can.owner ? `<label><span>${esc(t('crms.account'))}</span> <select name="account"></select></label>
    <p class="muted small">${esc(t('rm.accountHint'))}</p>
    <label><span>${esc(t('crms.backup'))}</span> <select name="backupAccount"></select></label>
    <p class="muted small">${esc(t('rm.backupHint'))}</p>` : ''}
    <div><span class="muted small">${esc(t('rm.mode'))}</span><br>${seg('mode', RM_MODES, 'rm.mode.')}<p class="muted small" id="rmModeHint"></p></div>
    <label class="inline"><input type="checkbox" name="creatorAdmin"> <span>${esc(t('rm.creatorAdmin'))}</span></label>
    <p class="muted small">${esc(t('rm.creatorAdminHint'))}</p>
    <div><span class="muted small">${esc(t('rm.joinOn'))}</span><br>${seg('joinOn', ['accepted', 'planned'], 'rm.joinOn.')}<p class="muted small" id="rmJoinHint"></p></div>
    <label class="inline"><input type="checkbox" name="removeOnUnplan"> <span>${esc(t('rm.remove'))}</span></label>
    <p class="muted small">${esc(t('rm.removeHint'))}</p>
    <div><span class="muted small">${esc(t('rm.posts'))}</span><br>${seg('posts', ['updates', 'card', 'none'], 'rm.posts.')}<p class="muted small">${esc(t('rm.postsHint'))}</p></div>
    <div><span class="muted small">${esc(t('rm.auto'))}</span><div id="rmAuto" class="rm-auto"></div><p class="muted small">${esc(t('rm.autoHint'))}</p></div>
    <label><span>${esc(t('rm.cc'))}</span> <input name="countryCode" inputmode="numeric" maxlength="4" class="rm-cc"></label>
    <p class="muted small">${esc(t('rm.ccHint'))}</p>
    <label class="inline"><input type="checkbox" name="inviteFallback"> <span>${esc(t('crms.invite'))}</span></label>
    <div class="row"><button type="submit">${esc(t('save'))}</button></div>
  </form>
  <div class="card form" id="rmHooks">
    <h3>${esc(t('crms.hooks'))}</h3>
    <p class="small" id="rmHookState"></p>
    <p class="muted small">${esc(t('rm.hooksHint'))}</p>
    <div class="row rm-hookurl"><code id="rmHookUrl" class="small"></code><button type="button" class="small" id="rmHookCopy" data-copy="">${esc(t('copy'))}</button></div>
    <label><span>${esc(t('rm.hookToken'))}</span> <input id="rmHookTok" type="password" autocomplete="new-password" spellcheck="false"></label>
    <div class="row"><button type="button" class="ghost" data-rm="hooktok">${esc(t('save'))}</button></div>
    <div><span class="muted small">${esc(t('crms.poll'))}</span><br><div class="seg" role="radiogroup" id="rmPoll">
      ${[2, 5, 15, 30].map((m) => `<label><input type="radio" name="rmPollMinutes" value="${m}"><span>${esc(t('crms.pollMin', m))}</span></label>`).join('')}</div>
      <p class="muted small" id="rmPollHint"></p></div>
  </div>` : ''}`
}
function rmHints(f) {
  const mode = f?.querySelector('input[name=mode]:checked')?.value
  if ($('#rmModeHint')) $('#rmModeHint').textContent = mode ? t('rm.modeHint.' + mode) : ''
  const j = f?.querySelector('input[name=joinOn]:checked')?.value
  if ($('#rmJoinHint')) $('#rmJoinHint').textContent = j ? t('rm.joinHint.' + j) : ''
}
function rmHookState(c) {
  if (!$('#rmHooks')) return
  const url = c.hookUrl ? (state.overview?.publicUrl || location.origin).replace(/\/+$/, '') + c.hookUrl : ''
  $('#rmHookUrl').textContent = url
  $('#rmHookCopy').dataset.copy = url
  $('#rmHookTok').placeholder = c.webhookTokenSet ? t('rm.saved') : ''
  const every = c.pollMinutes || 2
  $('#rmHookState').textContent = c.lastHookAt ? t('rm.hookLast', fmtDate(new Date(c.lastHookAt).toISOString())) + (c.webhookTokenSet ? '' : ' · ' + t('rm.hookNoToken')) : t('crms.hooksOff', every)
  $$('#rmPoll input').forEach((i) => { i.checked = Number(i.value) === every })
  $('#rmPollHint').textContent = t('rm.pollHint', every)
}
let rmTz = ''
async function rmLoad(st) {
  const s = st ?? (await api('GET', RM))
  const c = s.config
  rmTz = c.timezone || ''
  const f1 = $('#rmConn'), f2 = $('#rmSet')
  if (f1 && f2) {
    f1.token.placeholder = c.tokenSet ? t('rm.saved') : ''
    $('#rmConnState').textContent = s.configured ? (c.workspace ? t('rm.connected', c.workspace + (c.company ? ' · ' + c.company : '')) : t('rm.tokenSaved')) : t('crms.notConnected')
    if (f2.account) {
      const accs = state.accounts ?? []
      const opt = (a) => `<option value="${esc(a.id)}">${esc(a.name)} ${esc(a.me?.phone ?? '')}</option>`
      f2.account.innerHTML = accs.map(opt).join('')
      f2.account.value = c.account || (accs.find((a) => a.default)?.id ?? '')
      f2.backupAccount.innerHTML = `<option value="">${esc(t('crms.backupNone'))}</option>` + accs.filter((a) => a.id !== f2.account.value).map(opt).join('')
      f2.backupAccount.value = c.backupAccount || ''
    }
    $$('input[name=mode]', f2).forEach((i) => { i.checked = i.value === (c.mode || 'project') })
    $$('input[name=joinOn]', f2).forEach((i) => { i.checked = i.value === (c.joinOn || 'accepted') })
    $$('input[name=posts]', f2).forEach((i) => { i.checked = i.value === (c.posts || 'updates') })
    f2.creatorAdmin.checked = c.creatorAdmin !== false
    f2.removeOnUnplan.checked = c.removeOnUnplan !== false
    f2.inviteFallback.checked = c.inviteFallback !== false
    f2.countryCode.value = c.countryCode || ''
    rmHints(f2)
    rmHookState(c)
    $('#rmAuto').innerHTML = `<span class="muted small">${esc(t(s.configured ? 'crms.reading' : 'crms.notConnected'))}</span>`
    if (s.configured) {
      api('GET', RM + '/statuses').then((list) => {
        $('#rmAuto').innerHTML = list.length ? list.map((x) => `<label class="inline small"><input type="checkbox" name="autoStatus" value="${esc(x.id)}" ${(c.autoStatuses || []).includes(x.id) ? 'checked' : ''}> <span>${esc(x.name)}</span></label>`).join('') : `<span class="muted small">—</span>`
      }).catch((e) => { $('#rmAuto').innerHTML = `<span class="small err-text">${esc(e.message)}</span>` })
    }
  }
  if (s.configured) await rmList()
  else $('#rmList').innerHTML = `<p class="muted">${esc(t(f1 ? 'rm.connectFirst' : 'crms.notConnected'))}</p>`
}
const rmDates = (p) => {
  if (!p.start && !p.end) return ''
  // in the Rentman account's time zone, like Rentman shows them
  const d = (x) => { try { return new Date(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: rmTz || undefined }) } catch { return new Date(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) } }
  return p.start && p.end && d(p.start) !== d(p.end) ? `${d(p.start)} → ${d(p.end)}` : d(p.start || p.end)
}
async function rmList() {
  const q = $('#rmQ')?.value ?? ''
  const list = await api('GET', RM + '/projects' + (q ? '?q=' + encodeURIComponent(q) : ''))
  $('#rmInfo').textContent = t('rm.count', num(list.length), num(list.filter((p) => p.sync).length))
  $('#rmList').innerHTML = list.length ? list.map((p) => `<div class="crms-rec">
      <div class="crms-rec-head">${p.statuses.map((x) => `<span class="badge">${esc(x)}</span>`).join(' ')} <b>${esc(p.name || '#' + p.id)}</b>${p.number ? ` <span class="muted small">${esc(p.number)}</span>` : ''} <span class="muted small">${esc(rmDates(p))}</span>${p.creator ? ` <span class="muted small" title="${esc(t(p.creator.whatsapp ? 'rm.creatorOk' : 'rm.creatorNoPhone'))}">${esc(t('rm.creator', p.creator.name))}${p.creator.whatsapp ? ' ✓' : ''}</span>` : ''}${p.url ? ` <a class="small" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(t('rm.open'))} ↗</a>` : ''}
        <span class="crms-rec-group"><label class="switch" title="${esc(t('rm.groups'))}"><input type="checkbox" ${p.sync ? 'checked' : ''} data-rmsync="${esc(p.id)}"><span></span></label> <span class="small">${esc(t('rm.groups'))}</span>${p.sync || p.groups.length ? ` <span class="badge ${crmsBadge(p.state)}">${esc(t('rm.state.' + (p.state || 'off')))}</span>` : ''}</span></div>
      ${p.error ? `<div class="small err-text">${esc(p.error)}</div>` : ''}
      ${p.crew ? `<div class="muted small rm-crew">${esc(t('rm.crewCount', p.crew.planned, p.crew.confirmed))}${p.crew.noPhone.length ? ' · ' + esc(t('rm.noPhone', p.crew.noPhone.join(', '))) : ''}</div>` : ''}
      ${p.groups.map((g) => `<div class="crms-disc"><div class="crms-disc-main"><b>${esc(g.name || '')}</b> <span class="muted small">${esc(t('rm.kind.' + g.kind))} · ${esc(t('rm.members', g.members))}</span>${g.error ? `<div class="small err-text">${esc(g.error)}</div>` : ''}</div><span class="badge ${crmsBadge(g.state)}">${esc(t('rm.gstate.' + (g.state || 'on')))}</span></div>`).join('')}
    </div>`).join('') : `<p class="muted">${esc(t(isUser() ? 'rm.noneMine' : 'rm.none'))}</p>`
  clearTimeout(rmTimer)
  if (list.some((p) => p.state === 'creating' || p.state === 'queued')) rmTimer = setTimeout(() => routeItem === 'rentman' && rmList().catch(() => {}), 4000)
}
async function rmRefresh() {
  $('#rmInfo').textContent = t('rm.reading')
  const s = await api('POST', RM + '/refresh')
  await rmList()
  if (s.refreshing) setTimeout(() => routeItem === 'rentman' && rmList().catch(() => {}), 5000)
}
document.addEventListener('submit', run(async (e) => {
  if (e.target.id === 'rmConn') {
    e.preventDefault()
    const f = e.target
    if (f.token.value) await api('PUT', RM + '/config', { token: f.token.value })
    f.token.value = ''
    const r = await api('POST', RM + '/test')
    toast(t('rm.testOk', r.workspace || r.company || ''))
    await rmLoad()
    await rmRefresh()
  } else if (e.target.id === 'rmSet') {
    e.preventDefault()
    const f = e.target
    const val = (n) => f.querySelector(`input[name=${n}]:checked`)?.value
    await api('PUT', RM + '/config', {
      ...(f.account ? { account: f.account.value, backupAccount: f.backupAccount.value } : {}),
      mode: val('mode') ?? 'project', joinOn: val('joinOn') ?? 'accepted', posts: val('posts') ?? 'updates',
      creatorAdmin: f.creatorAdmin.checked, removeOnUnplan: f.removeOnUnplan.checked, inviteFallback: f.inviteFallback.checked,
      countryCode: f.countryCode.value.trim(),
      ...($('#rmAuto input') ? { autoStatuses: $$('input[name=autoStatus]:checked', f).map((i) => i.value) } : {}),
    })
    toast(t('saved'))
  }
}))
document.addEventListener('change', run(async (e) => {
  const f = e.target.closest('#rmSet')
  if (f && (e.target.name === 'mode' || e.target.name === 'joinOn')) rmHints(f)
  if (f && e.target.name === 'account') {
    const keep = f.backupAccount.value
    f.backupAccount.innerHTML = `<option value="">${esc(t('crms.backupNone'))}</option>` + (state.accounts ?? []).filter((a) => a.id !== f.account.value).map((a) => `<option value="${esc(a.id)}">${esc(a.name)} ${esc(a.me?.phone ?? '')}</option>`).join('')
    f.backupAccount.value = keep !== f.account.value ? keep : ''
  }
  if (e.target.name === 'rmPollMinutes') {
    const s = await api('PUT', RM + '/config', { pollMinutes: Number(e.target.value) })
    rmHookState(s.config)
    toast(t('saved'))
    return
  }
  const sw = e.target.closest('[data-rmsync]')
  if (!sw) return
  const on = sw.checked
  if (on && !confirm(t('rm.confirmOn'))) { sw.checked = false; return }
  try { await api('PUT', `${RM}/projects/${encodeURIComponent(sw.dataset.rmsync)}`, { group: on }) } catch (x) { sw.checked = !on; throw x }
  await rmList()
}))
document.addEventListener('click', run(async (e) => {
  const b = e.target.closest('[data-rm]')
  if (!b) return
  b.disabled = true
  try {
    if (b.dataset.rm === 'test') { const r = await api('POST', RM + '/test'); toast(t('rm.testOk', r.workspace || r.company || '')); await rmLoad() }
    if (b.dataset.rm === 'refresh') await rmRefresh()
    if (b.dataset.rm === 'hooktok') {
      const tok = $('#rmHookTok')
      const s = await api('PUT', RM + '/config', { webhookToken: tok.value })
      tok.value = ''
      rmHookState(s.config)
      toast(t('saved'))
    }
  } finally { b.disabled = false }
}))
let rmQT = null
document.addEventListener('input', (e) => { if (e.target.id === 'rmQ') { clearTimeout(rmQT); rmQT = setTimeout(() => rmList().catch(() => {}), 300) } })

// ---------------------------------------------------------------- users (Settings → Users): who signs in besides the owner
let USERS = []
async function loadUsersAdmin() {
  const [list, plugins] = await Promise.all([api('GET', '/v1/admin/users'), api('GET', '/v1/plugins')])
  USERS = list
  $('#userAddPlugins').innerHTML = plugins.map((p) => `<label class="inline"><input type="checkbox" name="plugin" value="${esc(p.id)}"> <span>${esc(p.name)}</span></label>`).join('') || `<span class="muted small">${esc(t('plugins.none'))}</span>`
  $('#userList').innerHTML = list.length ? list.map((u) => `<div class="user-row" data-uid="${esc(u.id)}">
    <div class="user-main"><b>${esc(u.name)}</b> ${u.source?.startsWith('currentrms:') ? '<span class="badge">Current RMS</span>' : ''} ${u.active ? '' : `<span class="badge bad">${esc(t('users.off'))}</span>`}
      <div class="small">${u.phone ? esc('+' + u.phone) : `<span class="muted">${esc(t('users.noPhone'))}</span>`} <span class="muted">· ${esc(u.lastLogin ? t('users.lastLogin', fmtDate(u.lastLogin)) : t('users.never'))}</span></div>
      <div class="user-plugins">${plugins.map((p) => { const pp = u.perms.plugins[p.id]; return `<label class="inline small"><input type="checkbox" data-uplug="${esc(p.id)}" ${pp?.access ? 'checked' : ''}> <span>${esc(p.name)}</span>${pp?.access ? ` <span class="muted">(${esc(t('users.scope.' + (pp.scope || 'owned')))}${pp.manage ? ', ' + esc(t('users.manage')) : ''})</span>` : ''}</label>` }).join('')}</div>
      <div class="user-link reveal" hidden></div>
    </div>
    <div class="user-actions">
      <label class="switch" title="${esc(t('users.active'))}"><input type="checkbox" data-uactive ${u.active ? 'checked' : ''}><span></span></label>
      <button type="button" class="ghost small" data-ulink>${esc(t('users.loginLink'))}</button>
      <button type="button" class="ghost small danger" data-udel>${esc(t('users.remove'))}</button>
    </div>
  </div>`).join('') : `<p class="muted">${esc(t('users.none'))}</p>`
}
$('#userAdd').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const plugins = {}
  for (const c of $$('input[name=plugin]:checked', f)) plugins[c.value] = { access: true, scope: 'all', manage: false }
  await api('POST', '/v1/admin/users', { name: f.elements.name.value, phone: f.elements.phone.value || null, perms: { plugins } })
  f.reset()
  toast(t('saved'))
  await loadUsersAdmin()
}))
$('#userList').addEventListener('change', run(async (e) => {
  const row = e.target.closest('[data-uid]')
  if (!row) return
  const u = USERS.find((x) => x.id === row.dataset.uid)
  if (e.target.matches('[data-uactive]')) await api('PUT', `/v1/admin/users/${encodeURIComponent(u.id)}`, { active: e.target.checked })
  if (e.target.matches('[data-uplug]')) {
    const id = e.target.dataset.uplug
    // a new plugin opens on all its records; "only their own records" is set inside the plugin
    const cur = u.perms.plugins[id] ?? { scope: u.source?.startsWith(id + ':') ? 'owned' : 'all', manage: false }
    await api('PUT', `/v1/admin/users/${encodeURIComponent(u.id)}`, { perms: { plugins: { ...u.perms.plugins, [id]: { ...cur, access: e.target.checked } } } })
  }
  toast(t('saved'))
  await loadUsersAdmin()
}))
$('#userList').addEventListener('click', run(async (e) => {
  const row = e.target.closest('[data-uid]')
  if (!row) return
  const u = USERS.find((x) => x.id === row.dataset.uid)
  if (e.target.closest('[data-ulink]')) {
    const r = await api('POST', `/v1/admin/users/${encodeURIComponent(u.id)}/login-link`)
    const out = row.querySelector('.user-link')
    out.hidden = false
    out.innerHTML = `<code>${esc(r.url)}</code><button type="button" class="small" data-copy="${esc(r.url)}">${esc(t('copy'))}</button><p class="muted small">${esc(t('users.linkHint', u.name))}</p>`
  }
  if (e.target.closest('[data-udel]')) {
    if (!confirm(t('users.removeConfirm', u.name))) return
    await api('DELETE', `/v1/admin/users/${encodeURIComponent(u.id)}`)
    await loadUsersAdmin()
  }
}))
async function loadSessions() {
  const s = await api('GET', '/v1/admin/sessions')
  $('#sessions').innerHTML = `<table><tr><th>${t('th.access')}</th><th>${t('th.created')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${s.map((x) => `<tr><td>${esc(x.label)}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.last_seen)}</td><td><button class="small danger" data-revoke-sess="${esc(x.id_hash)}">${esc(t('revoke'))}</button></td></tr>`).join('')}</table>`
}
document.addEventListener('click', run(async (e) => {
  const tile = e.target.closest('[data-tile]')
  if (tile) return showTab('connect', tile.dataset.sub, tile.dataset.tile)
  const back = e.target.closest('[data-back]')
  if (back) return showTab('connect', back.dataset.back)
  const mk = e.target.closest('[data-mk]')
  if (mk) {
    const which = mk.dataset.mk
    const k = await api('POST', '/v1/admin/api-keys', { name: which === 'grokbot' ? 'Grok Bot' : 'Hermes', scopes: ['read', 'send'] })
    if (which === 'grokbot') $('#grokBotOut').innerHTML = `<pre>${esc(MCP)}?token=${esc(k.key)}</pre><button class="small" data-copy="${esc(MCP + '?token=' + k.key)}">${esc(t('copyUrl'))}</button> <span class="muted small">${esc(t('shownOnce'))}</span>`
    else {
      const y = `mcp_servers:\n  whatsops:\n    url: "${MCP}"\n    headers:\n      Authorization: "Bearer ${k.key}"\n    timeout: 120`
      $('#hermesOut').innerHTML = `<pre>${esc(y)}</pre><button class="small" data-copy="${esc(y)}">${esc(t('copy'))}</button> <span class="muted small">${esc(t('shownOnce'))}</span>`
    }
    return
  }
  const g = e.target.closest('[data-revoke-grant]')
  if (g && confirm(t('confirm.revokeApp'))) { await api('DELETE', `/v1/admin/oauth/grants/${g.dataset.revokeGrant}`); await loadConnect() }
  const s = e.target.closest('[data-revoke-sess]')
  if (s && confirm(t('confirm.revokeSession'))) { await api('DELETE', `/v1/admin/sessions/${s.dataset.revokeSess}`); await loadSessions() }
}))

// ---------------------------------------------------------------- API keys
function fillAccountSelects() {
  const opts = state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label)} ${esc(a.me?.phone ?? '')}</option>`).join('')
  $('#keyForm select[name=accounts]').innerHTML = opts
  $('#hookForm select[name=account]').innerHTML = `<option value="*">${esc(t('all'))}</option>` + opts
}
async function loadKeys() {
  const keys = await api('GET', '/v1/admin/api-keys')
  $('#keyList').innerHTML = keys.length
    ? `<table><tr><th>${t('th.name')}</th><th>${t('th.prefix')}</th><th>${t('th.scopes')}</th><th>${t('th.numbers')}</th><th>${t('th.created')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${keys.map((k) => `<tr style="${k.revoked ? 'opacity:.45' : ''}"><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.scopes)}</td><td>${esc(k.accounts === '*' ? t('all') : k.accounts)}</td><td>${fmtDate(k.created_at)}</td><td>${fmtDate(k.last_used)}</td><td>${k.revoked ? esc(t('keys.revoked')) : `<button class="small danger" data-revoke-key="${esc(k.id)}">${esc(t('revoke'))}</button>`}</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('keys.none'))}</p>`
}
$('#keyForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const scopes = ['read', 'send', 'admin'].filter((s) => f[s].checked)
  const accounts = [...f.accounts.selectedOptions].map((o) => o.value)
  const k = await api('POST', '/v1/admin/api-keys', { name: f.elements.name.value, scopes, accounts: accounts.length ? accounts : '*' })
  $('#newKey').hidden = false
  $('#newKey').innerHTML = `<b>${esc(t('keys.created'))}</b><code>${esc(k.key)}</code><button class="small" data-copy="${esc(k.key)}">${esc(t('copy'))}</button>`
  f.reset()
  await loadKeys()
}))
$('#keyList').addEventListener('click', run(async (e) => {
  const b = e.target.closest('[data-revoke-key]')
  if (b && confirm(t('confirm.revokeKey'))) { await api('DELETE', `/v1/admin/api-keys/${b.dataset.revokeKey}`); await loadKeys() }
}))

// ---------------------------------------------------------------- database
const DIALECT = { sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB' }
async function loadDb() {
  const d = await api('GET', '/v1/admin/database')
  $('#dbCurrent').innerHTML = `<div class="muted small">${esc(t('db.inUse'))}</div><b>${esc(DIALECT[d.dialect])}</b><div><code>${esc(d.url)}</code></div>
    ${d.envOverride ? `<p class="muted">${esc(t('db.env'))}</p>` : ''}
    ${d.previous.length ? `<p class="muted small">${esc(t('db.previous'))} ${d.previous.map((p) => `<code>${esc(p.url)}</code> (${fmtDate(p.at)})`).join(', ')}</p>` : ''}`
  $('#dbForm [name=path]').placeholder = d.defaultSqlite.replace('sqlite://', '')
}
function dbType() { return $('#dbForm [name=type]').value }
$('#dbForm [name=type]').addEventListener('change', () => {
  const ty = dbType()
  $('#dbForm [data-for=sqlite]').hidden = ty !== 'sqlite'
  $('#dbForm [data-for=net]').hidden = ty === 'sqlite'
  $('#dbForm [name=port]').placeholder = ty === 'mysql' ? '3306' : '5432'
})
function dbUrl() {
  const f = $('#dbForm')
  if (f.url.value.trim()) return f.url.value.trim()
  const ty = dbType()
  if (ty === 'sqlite') return 'sqlite://' + (f.path.value.trim() || f.path.placeholder)
  const host = f.host.value.trim() || '127.0.0.1'
  const port = f.port.value.trim() || (ty === 'mysql' ? '3306' : '5432')
  const cred = f.user.value ? encodeURIComponent(f.user.value) + (f.password.value ? ':' + encodeURIComponent(f.password.value) : '') + '@' : ''
  let u = `${ty === 'mysql' ? 'mysql' : 'postgres'}://${cred}${host}:${port}/${encodeURIComponent(f.database.value.trim() || 'whatsapp')}`
  if (f.ssl.checked) u += ty === 'mysql' ? '?ssl={"rejectUnauthorized":true}' : '?sslmode=require'
  return u
}
$('#dbTest').addEventListener('click', run(async () => {
  $('#dbResult').textContent = t('db.testing')
  const r = await api('POST', '/v1/admin/database/test', { url: dbUrl() })
  $('#dbResult').textContent = t('db.ok', DIALECT[r.dialect], r.latencyMs) + (r.existingAccounts != null ? t('db.hasAccounts', r.existingAccounts) : t('db.empty'))
}))
$('#dbForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const copyData = $('#dbForm [name=copy]').checked
  if (!confirm(t(copyData ? 'db.confirmCopy' : 'db.confirmNoCopy'))) return
  $('#dbResult').textContent = t('db.moving')
  const r = await api('POST', '/v1/admin/database/switch', { url: dbUrl(), copyData })
  $('#dbResult').textContent = t('db.done') + (r.copied ? t('db.copied', Object.entries(r.copied).filter(([, n]) => n).map(([tb, n]) => `${tb} ${num(n)}`).join(', ')) : '')
  setTimeout(() => location.reload(), 6000)
}))

// ---------------------------------------------------------------- webhooks
async function loadHooks() {
  const [hooks, del] = await Promise.all([api('GET', '/v1/admin/webhooks'), api('GET', '/v1/admin/webhooks/deliveries')])
  $('#hookList').innerHTML = hooks.length
    ? `<table><tr><th>URL</th><th>${t('th.events')}</th><th>${t('th.number')}</th><th>${t('th.auth')}</th><th>${t('th.status')}</th><th></th></tr>${hooks.map((h) => `<tr data-hook-row="${esc(h.id)}"><td><code>${esc(h.url)}</code></td><td>${esc(h.events)}</td><td>${esc(h.account_id === '*' ? t('all') : h.account_id)}</td><td class="small">${Object.keys(h.headers || {}).length ? Object.entries(h.headers).map(([k, v]) => `<code>${esc(k)}: ${esc(v)}</code>`).join('<br>') : '<span class="muted">—</span>'}</td><td>${esc(t(h.active ? 'hooks.active' : 'hooks.paused'))}</td><td class="actions"><button class="small ghost" data-hook-test="${esc(h.id)}">${esc(t('hooks.test'))}</button><button class="small ghost" data-hook-auth="${esc(h.id)}" data-has="${Object.keys(h.headers || {}).length ? 1 : 0}">${esc(t('hooks.key'))}</button><button class="small ghost" data-hook-toggle="${esc(h.id)}" data-active="${h.active}">${esc(t(h.active ? 'hooks.pause' : 'hooks.enable'))}</button><button class="small danger" data-hook-del="${esc(h.id)}">${esc(t('hooks.delete'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('hooks.none'))}</p>`
  $('#deliveries').innerHTML = del.length
    ? `<table><tr><th>${t('th.when')}</th><th>${t('th.event')}</th><th>${t('th.result')}</th><th>${t('th.attempts')}</th><th>${t('th.http')}</th></tr>${del.slice(0, 30).map((d) => `<tr><td>${fmtDate(d.created_at)}</td><td>${esc(d.event)}</td><td>${esc(d.state)}${d.last_error ? ' · ' + esc(d.last_error) : ''}</td><td>${d.attempts}</td><td>${d.last_status || '—'}</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('hooks.noDeliveries'))}</p>`
}
$('#hookForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const h = await api('POST', '/v1/admin/webhooks', { url: f.url.value, events: f.events.value || '*', account: f.account.value, ...(f.auth.value.trim() ? { headers: f.auth.value } : {}) })
  $('#newHook').hidden = false
  $('#newHook').innerHTML = `<b>${esc(t('hooks.created'))}</b><code>${esc(h.secret)}</code><button class="small" data-copy="${esc(h.secret)}">${esc(t('copy'))}</button>`
  f.reset()
  await loadHooks()
}))
$('#hookList').addEventListener('submit', run(async (e) => {
  const f = e.target.closest('[data-hook-auth-form]')
  if (!f) return
  e.preventDefault()
  await api('PATCH', `/v1/admin/webhooks/${f.dataset.hookAuthForm}`, { headers: f.auth.value })
  toast(t('hooks.keySaved'))
  await loadHooks()
}))
$('#hookList').addEventListener('click', run(async (e) => {
  const tb = e.target.closest('[data-hook-test]')
  if (tb) {
    tb.disabled = true
    try {
      const r = await api('POST', `/v1/admin/webhooks/${tb.dataset.hookTest}/test`)
      if (r.ok) toast(t('hooks.testOk', r.status)); else toast(t('hooks.testFail', r.error || 'HTTP ' + r.status), true)
    } finally { tb.disabled = false }
    await loadHooks()
  }
  const ka = e.target.closest('[data-hook-auth]')
  if (ka) {
    const row = ka.closest('tr')
    if (row.nextElementSibling?.classList.contains('hook-edit')) { row.nextElementSibling.remove(); return }
    row.insertAdjacentHTML('afterend', `<tr class="hook-edit"><td colspan="6"><form class="row hook-auth" data-hook-auth-form="${esc(ka.dataset.hookAuth)}">
      <input name="auth" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(t('hooks.authPh'))}" required>
      <button type="submit" class="small">${esc(t('save'))}</button>${ka.dataset.has === '1' ? `<button type="button" class="small danger" data-hook-auth-del="${esc(ka.dataset.hookAuth)}">${esc(t('hooks.keyRemove'))}</button>` : ''}</form></td></tr>`)
    row.nextElementSibling.querySelector('input').focus()
  }
  const kd = e.target.closest('[data-hook-auth-del]')
  if (kd && confirm(t('hooks.keyRemoveConfirm'))) { await api('PATCH', `/v1/admin/webhooks/${kd.dataset.hookAuthDel}`, { headers: '' }); toast(t('hooks.keyRemoved')); await loadHooks() }
  const g = e.target.closest('[data-hook-toggle]'); if (g) { await api('PATCH', `/v1/admin/webhooks/${g.dataset.hookToggle}`, { active: g.dataset.active !== '1' }); await loadHooks() }
  const d = e.target.closest('[data-hook-del]'); if (d && confirm(t('confirm.deleteHook'))) { await api('DELETE', `/v1/admin/webhooks/${d.dataset.hookDel}`); await loadHooks() }
}))

// ---------------------------------------------------------------- api vocabulary
let vocab = null
const VOCAB_METHODS = ['get', 'post', 'put', 'patch', 'delete']
const VOCAB_ORDER = ['Send', 'Messages', 'Accounts', 'Contacts', 'Groups', 'Events', 'Webhooks', 'Plugins', 'Admin']
async function loadApi() {
  $('#apiBase').textContent = ORIGIN + '/v1'
  await loadKeys()
  if (!vocab) { const r = await fetch('/openapi.json', { credentials: 'same-origin' }); vocab = await r.json() }
  renderVocab()
}
const vt = (s) => (WA_LANG === 'it' && WA_API_IT[s]) || s
function renderVocab() {
  const q = $('#apiFilter').value.trim().toLowerCase()
  const groups = {}
  let n = 0
  for (const [path, ops] of Object.entries(vocab.paths || {})) {
    for (const [m, op] of Object.entries(ops)) {
      if (!VOCAB_METHODS.includes(m)) continue
      if (!op.tags || !op.tags.length) continue // OAuth / discovery plumbing is not part of the API
      const tag = op.tags[0]
      const sum = vt(op.summary || '')
      if (q && !`${m} ${path} ${sum} ${op.summary || ''} ${vt(tag)}`.toLowerCase().includes(q)) continue
      ;(groups[tag] ||= []).push({ m, path, sum })
      n++
    }
  }
  $('#apiCount').textContent = t('api.count', n)
  const order = (g) => { const i = VOCAB_ORDER.indexOf(g); return i < 0 ? 99 : i }
  $('#apiVocab').innerHTML = Object.entries(groups).sort(([a], [b]) => order(a) - order(b)).map(([tag, ops]) => `<div class="card"><h4>${esc(vt(tag))} <span class="muted small">${ops.length}</span></h4><table>${ops.map((o) => `<tr><td class="m m-${o.m}">${o.m.toUpperCase()}</td><td><code>${esc(o.path)}</code><div class="muted small">${esc(o.sum)}</div></td></tr>`).join('')}</table></div>`).join('') || `<p class="muted">${esc(t('api.none'))}</p>`
}
$('#apiFilter').addEventListener('input', () => vocab && renderVocab())

// ---------------------------------------------------------------- service log (terminal)
const LEVEL_NAME = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
const LEVEL_MIN = { all: 0, info: 30, warn: 40, error: 50 }
const TERM_MAX = 2000
let logES = null
let logLive = true
let logEntries = []
let logPending = 0
const pad2 = (n) => String(n).padStart(2, '0')
function termTime(t) {
  const d = new Date(t)
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  return d.toDateString() === new Date().toDateString() ? hms : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hms}`
}
function termKv(data) {
  if (!data) return ''
  return Object.entries(data).map(([k, v]) => {
    const s = typeof v === 'string' ? v.split('\n')[0] : JSON.stringify(v)
    return `<span class="tk">${esc(k)}</span>=<span class="tv">${esc(s.length > 160 ? s.slice(0, 160) + '…' : s)}</span>`
  }).join(' ')
}
function termLine(e, idx) {
  const lv = Math.min(60, Math.floor(e.level / 10) * 10)
  const name = String(LEVEL_NAME[e.level] ?? e.level).padEnd(5)
  const mod = (e.mod ?? '').padEnd(7)
  return `<div class="tl lv-${lv}${e.data ? ' has' : ''}" data-i="${idx}"><span class="tt">${esc(termTime(e.t))}</span> <span class="tlv">${esc(name)}</span> <span class="tm">${esc(mod)}</span> <span class="tx">${esc(e.msg)}</span>${e.data ? ' ' + termKv(e.data) : ''}</div>`
}
function logMatches(e) {
  if (e.level < LEVEL_MIN[$('#logLevel').value]) return false
  const q = $('#logQ').value.trim().toLowerCase()
  return !q || `${e.mod ?? ''} ${e.msg} ${e.data ? JSON.stringify(e.data) : ''}`.toLowerCase().includes(q)
}
const termEl = () => $('#logList')
const termAtBottom = () => { const el = termEl(); return el.scrollHeight - el.scrollTop - el.clientHeight < 30 }
function termToBottom() { const el = termEl(); el.scrollTop = el.scrollHeight; logPending = 0; $('#logJump').hidden = true }
function termCount() { $('#logCount').textContent = logEntries.length ? t('log.count', num(logEntries.length)) : t('log.empty') }
function termRender() {
  termEl().innerHTML = logEntries.map(termLine).join('')
  termCount()
  termToBottom()
}
function termAppend(e) {
  const stick = termAtBottom()
  logEntries.push(e)
  termEl().insertAdjacentHTML('beforeend', termLine(e, logEntries.length - 1))
  if (logEntries.length > TERM_MAX) {
    // drop the oldest lines; re-render keeps data-i indexes consistent
    logEntries = logEntries.slice(-TERM_MAX)
    termEl().innerHTML = logEntries.map(termLine).join('')
  }
  termCount()
  if (stick) termToBottom()
  else { logPending++; $('#logJump').hidden = false; $('#logJump').textContent = t('log.jump', logPending) }
}
async function loadLogs() {
  const qs = new URLSearchParams({ level: $('#logLevel').value, limit: '1000' })
  const q = $('#logQ').value.trim()
  if (q) qs.set('q', q)
  const r = await api('GET', '/v1/admin/logs?' + qs)
  logEntries = r.entries
  termRender()
  if (logLive) startLogLive(); else stopLogLive()
}
function startLogLive() {
  if (logES) return
  logES = new EventSource('/v1/admin/logs/stream')
  logES.onmessage = (m) => {
    let e
    try { e = JSON.parse(m.data) } catch { return }
    if (logMatches(e)) termAppend(e)
  }
}
function stopLogLive() { if (logES) { logES.close(); logES = null } }
function setLive(on) {
  logLive = on
  $('#logLive').classList.toggle('on', on)
  $('#term').classList.toggle('live', on)
  if (on) { startLogLive(); termToBottom() } else stopLogLive()
}
termEl().addEventListener('click', (ev) => {
  const line = ev.target.closest('.tl.has')
  if (!line || window.getSelection()?.toString()) return
  const next = line.nextElementSibling
  if (next && next.classList.contains('tdet')) { next.remove(); line.classList.remove('open'); return }
  const e = logEntries[Number(line.dataset.i)]
  if (!e) return
  line.insertAdjacentHTML('afterend', `<pre class="tdet">${esc(JSON.stringify(e.data, null, 2))}</pre>`)
  line.classList.add('open')
})
termEl().addEventListener('scroll', () => { if (termAtBottom()) { logPending = 0; $('#logJump').hidden = true } })
$('#logJump').addEventListener('click', termToBottom)
let logQTimer = null
$('#logLevel').addEventListener('change', run(loadLogs))
$('#logQ').addEventListener('input', () => { clearTimeout(logQTimer); logQTimer = setTimeout(run(loadLogs), 300) })
$('#logLive').addEventListener('click', () => setLive(!logLive))
$('#logClear').addEventListener('click', () => { logEntries = []; termRender() })

// ---------------------------------------------------------------- updates (GitHub releases)
let updTimer = null
function renderUpdates(u) {
  $('#updCur').textContent = u.currentLabel || u.current
  $('#updLatest').textContent = u.latest ? u.latest.version : u.lastError ? t('upd.unknown') : t('upd.none')
  $('#updAuto').checked = !!u.auto
  $('#updAuto').disabled = u.mode === 'manual'
  let st = u.busy ? t('upd.installing') : u.restartNeeded ? t('upd.restartNeeded') : u.available ? t('upd.available', u.latest.version) : u.lastError ? '' : t('upd.uptodate')
  if (u.lastResult) st += (st ? ' · ' : '') + t('upd.last', `${fmtDate(u.lastResult.at)} — ${u.lastResult.message}`)
  if (u.lastError) st += (st ? ' · ' : '') + t('upd.error', u.lastError)
  $('#updState').textContent = st
  $('#updHint').textContent = u.mode !== 'manual' ? t('upd.hintGit', u.intervalMin, u.lastCheck ? fmtDate(u.lastCheck) : '—') : t('upd.hintManual')
  $('#updApply').hidden = !(u.available && u.mode !== 'manual' && !u.busy)
  $('#updNotes').hidden = !(u.latest && u.latest.notes)
  $('#updNotesText').textContent = u.latest?.notes ?? ''
  clearTimeout(updTimer)
  if (u.busy) updTimer = setTimeout(() => loadUpdates().catch(() => location.reload()), 3000)
}
async function loadUpdates() { renderUpdates(await api('GET', '/v1/admin/update')) }
$('#updCheck').addEventListener('click', run(async () => renderUpdates(await api('POST', '/v1/admin/update/check'))))
$('#updApply').addEventListener('click', run(async () => { renderUpdates(await api('POST', '/v1/admin/update/apply')); toast(t('upd.done')) }))
$('#updAuto').addEventListener('change', run(async (e) => { await api('PUT', '/v1/admin/settings', { autoUpdate: e.target.checked }); toast(t('saved')) }))

// ---------------------------------------------------------------- feedback · crash & malfunction reports
async function loadFeedback() {
  const r = await api('GET', '/v1/admin/feedback')
  $('#fbHint').innerHTML = esc(t('fb.hint', '')).replace('()', `(<a href="https://github.com/${esc(r.repo)}/issues" target="_blank" rel="noopener">${esc(r.repo)}</a>)`)
  $('#fbCode').textContent = r.installCode
  $$('input[name=crashReports]').forEach((i) => { i.checked = i.value === r.mode })
  $('#repList').innerHTML = r.pending.length
    ? r.pending.map((p) => `<div class="rep" data-id="${esc(p.id)}"><div class="rep-top"><span class="badge ${p.type === 'crash' ? 'bad' : 'warn'}">${esc(t('rep.' + p.type))}</span> <b>${esc(p.title)}</b> <span class="muted small">${p.count > 1 ? esc(t('rep.times', p.count)) + ' · ' : ''}${esc(fmtDate(p.last))}</span></div>
        <details><summary>${esc(t('rep.view'))}</summary><pre>${esc(p.detail)}</pre></details>
        <div class="row"><button type="button" class="small" data-rep="send">${esc(t('rep.send'))}</button><button type="button" class="small ghost" data-rep="discard">${esc(t('rep.discard'))}</button></div></div>`).join('')
    : `<p class="muted">${esc(t('rep.none'))}</p>`
  $('#fbSent').innerHTML = r.sent.length
    ? `<ul class="sent">${r.sent.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">#${s.number}</a> ${esc(s.type === 'feedback' ? t('fb.' + (s.kind || 'other')) : t('rep.' + s.type))} — ${esc(s.title)} <span class="muted small">${esc(fmtDate(s.at))} · ${esc(t('fb.via.' + s.via))}${s.comment ? ' · ' + esc(t('fb.comment')) : ''}</span></li>`).join('')}</ul>`
    : `<p class="muted">${esc(t('fb.none'))}</p>`
}
$('#fbForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const btn = f.querySelector('button[type=submit]')
  btn.disabled = true
  try {
    const s = await api('POST', '/v1/admin/feedback', { kind: f.kind.value, title: f.title.value, message: f.message.value, diagnostics: f.diagnostics.checked })
    f.reset()
    toast(t('fb.sentOk', s.number))
    await loadFeedback()
  } finally { btn.disabled = false }
}))
$$('input[name=crashReports]').forEach((i) => i.addEventListener('change', run(async () => { await api('PUT', '/v1/admin/settings', { crashReports: i.value }); toast(t('saved')); await loadFeedback() })))
$('#repList').addEventListener('click', run(async (e) => {
  const b = e.target.closest('button[data-rep]')
  if (!b) return
  const id = b.closest('[data-id]').dataset.id
  b.disabled = true
  try {
    if (b.dataset.rep === 'send') { const s = await api('POST', `/v1/admin/reports/${id}/send`); toast(t(s.already ? 'rep.already' : 'fb.sentOk', s.number)) }
    else await api('DELETE', `/v1/admin/reports/${id}`)
  } finally { await loadFeedback().catch(() => {}) }
}))

// ---------------------------------------------------------------- license (Polar) — hidden while WhatsOps is free
function renderLicense(l) {
  $('#licState').textContent = !l.enabled ? '' : l.plan === 'licensed' ? `${t('lic.ok')} · ${l.key}${l.customer ? ' · ' + l.customer : ''}${l.expiresAt ? ' · ' + fmtDate(l.expiresAt) : ''}` : t('lic.no')
  $('#licRemove').hidden = !(l.enabled && l.key)
}
async function loadLicense() { renderLicense(await api('GET', '/v1/admin/license')) }
$('#licForm').addEventListener('submit', run(async (e) => { e.preventDefault(); renderLicense(await api('POST', '/v1/admin/license', { key: e.target.key.value })); e.target.reset(); toast(t('lic.ok')) }))
$('#licRemove').addEventListener('click', run(async () => renderLicense(await api('DELETE', '/v1/admin/license'))))

// ---------------------------------------------------------------- settings
// ---------------------------------------------------------------- voice messages → text (Settings → Voice)
let voiceCfg = null
let voiceTimer = null
function voiceShow() {
  const f = $('#voiceForm')
  const e = f.querySelector('input[name=engine]:checked')?.value || 'off'
  $$('[data-voice]', f).forEach((d) => { d.hidden = d.dataset.voice === 'on' ? e === 'off' : d.dataset.voice !== e })
  $('#voiceEngineHint').textContent = t('voice.eh.' + e)
  const p = voiceCfg?.providers?.[f.provider.value]
  f.apiUrl.placeholder = p?.url || 'https://…/v1'
  f.apiModel.placeholder = p?.model || ''
  const all = f.querySelector('input[name=autoMode]:checked')?.value !== 'asked'
  $('#voiceWhichHint').textContent = t(all ? 'voice.whichAllHint' : 'voice.whichAskedHint')
}
function voiceLocalRender(c) {
  const L = c.local
  const ins = L.install || {}
  const m = L.model
  let html
  if (ins.state === 'running') html = `<span class="muted">⏳ ${esc(t('voice.installing', t('voice.step.' + (ins.step || 'uv'))))}</span>`
  else if (L.available) html = `<span class="ok-text">✓ ${esc(t('voice.localOk', L.version || '', t('voice.src.' + (L.source || 'system'), L.python)))}</span> <span class="muted">${esc(t('voice.localModel'))}</span>`
  else if (L.installable) html = `<span class="err-text">${esc(t('voice.localMissing'))}</span> <span class="muted">${esc(t('voice.installHint'))}</span>`
  else html = `<span class="err-text">${esc(t('voice.installNo', c.platform))}</span>`
  if (ins.state === 'error') html += `<br><span class="err-text">${esc(ins.error || '')}</span>`
  if (ins.state !== 'running' && m && m.name === c.model) {
    if (m.state === 'loading') html += `<br><span class="muted">⏳ ${esc(t('voice.modelLoading', m.name))}</span>`
    else if (m.state === 'ready') html += `<br><span class="ok-text">✓ ${esc(t('voice.modelReady', m.name))}</span>`
    else if (m.state === 'error') html += `<br><span class="err-text">${esc(t('voice.modelError', m.name, m.error || ''))}</span>`
  }
  $('#voiceLocal').innerHTML = html
  const btn = $('#voiceInstall')
  $('#voiceInstallRow').hidden = !L.installable || (L.available && ins.state !== 'running')
  btn.disabled = ins.state === 'running'
  btn.textContent = t(ins.state === 'error' ? 'voice.installRetry' : 'voice.install')
  // follow the install and the model download
  clearTimeout(voiceTimer)
  if (ins.state === 'running' || m?.state === 'loading') {
    voiceTimer = setTimeout(async () => {
      if (!location.hash.startsWith('#settings/voice')) return
      try {
        const x = await api('GET', '/v1/admin/voice')
        if (ins.state === 'running' && x.local.install?.state !== 'running') return loadVoice() // finished: the engine switched to faster-whisper
        voiceCfg = x
        voiceLocalRender(x)
      } catch {}
    }, 2500)
  }
}
async function loadVoice() {
  const c = (voiceCfg = await api('GET', '/v1/admin/voice'))
  const f = $('#voiceForm')
  $$('input[name=engine]', f).forEach((r) => { r.checked = r.value === c.engine })
  f.model.innerHTML = c.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
  if (!c.models.includes(c.model)) f.model.insertAdjacentHTML('beforeend', `<option value="${esc(c.model)}">${esc(c.model)}</option>`)
  f.model.value = c.model
  f.provider.value = c.provider
  f.apiUrl.value = c.apiUrl || ''
  f.apiModel.value = c.apiModel || ''
  f.apiKey.value = ''
  f.apiKey.placeholder = c.apiKeySet ? t('rm.saved') : ''
  f.command.value = c.command || ''
  f.language.value = c.language || 'auto'
  if (!f.language.value) f.language.value = 'auto'
  $$('input[name=autoMode]', f).forEach((r) => { r.checked = r.value === (c.auto ? 'all' : 'asked') })
  voiceLocalRender(c)
  $('#voiceTestOut').textContent = ''
  voiceShow()
}
$('#voiceForm').addEventListener('change', (e) => { if (['engine', 'provider', 'autoMode'].includes(e.target.name)) voiceShow() })
$('#voiceForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const engine = f.querySelector('input[name=engine]:checked')?.value || 'off'
  const body = {
    engine, model: f.model.value, provider: f.provider.value, apiUrl: f.apiUrl.value.trim(), apiModel: f.apiModel.value.trim(), command: f.command.value.trim(), language: f.language.value,
    auto: f.querySelector('input[name=autoMode]:checked')?.value !== 'asked',
  }
  if (f.apiKey.value.trim()) body.apiKey = f.apiKey.value.trim()
  await api('PUT', '/v1/admin/voice', body)
  toast(t('saved'))
  await loadVoice()
}))
// one click: WhatsOps installs faster-whisper in its own folder, then uses it with the chosen model
$('#voiceInstall').addEventListener('click', run(async () => {
  const c = (voiceCfg = await api('POST', '/v1/admin/voice/install', { model: $('#voiceForm').model.value }))
  voiceLocalRender(c)
}))
$('#voiceTest').addEventListener('click', run(async () => {
  const b = $('#voiceTest'), out = $('#voiceTestOut')
  b.disabled = true
  out.className = 'small muted'
  out.textContent = t('voice.testing')
  try {
    const r = await api('POST', '/v1/admin/voice/test')
    out.className = 'small'
    out.innerHTML = r.sample
      ? `<span class="ok-text">✓ ${esc(t('voice.testOk', r.engine, r.sample.chat, r.sample.seconds ?? '?', (r.sample.ms / 1000).toFixed(1)))}</span><br>“${esc(r.sample.text || t('voice.noWords'))}”`
      : `<span class="ok-text">✓ ${esc(t('voice.testReady', r.engine))}</span>`
  } catch (x) {
    out.className = 'small err-text'
    out.textContent = x.message
  } finally { b.disabled = false; if (voiceCfg?.engine === 'local') loadVoice().catch(() => {}) }
}))
// ---------------------------------------------------------------- backup (Settings → Backup)
let bakPickPath = null
const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB')
function bakRender(c) {
  const f = $('#bakForm')
  $$('input[name=every]', f).forEach((r) => { r.checked = r.value === c.every })
  f.folder.value = c.folder
  f.keep.value = c.keep
  f.password.value = ''
  f.password.placeholder = c.passwordSet ? t('rm.saved') : ''
  $('#bakNewName').placeholder = t('bak.newName')
  $('#bakFilePw').placeholder = t('bak.filePw')
  $('#bakPwRemove').hidden = !c.passwordSet
  $('#bakPwHint').textContent = t(c.passwordSet ? 'bak.pwOn' : 'bak.pwOff')
  $('#bakFolderHint').textContent = c.folder === c.defaultFolder ? t('bak.folderDefault') : ''
  const s = c.state
  const lines = []
  if (s.busy) lines.push(`<span class="muted">⏳ ${esc(t(s.busy === 'restore' ? 'bak.restoring' : 'bak.working'))}</span>`)
  lines.push(s.lastAt ? `<span class="ok-text">✓ ${esc(t('bak.last', fmtDate(s.lastAt), s.lastSize ? fmtSize(s.lastSize) : '?'))}</span>` : `<span class="muted">${esc(t('bak.never'))}</span>`)
  if (s.lastError && (!s.lastAt || s.lastErrorAt > s.lastAt)) lines.push(`<span class="err-text">${esc(t('bak.error', fmtDate(s.lastErrorAt), s.lastError))}</span>`)
  lines.push(`<span class="muted">${esc(c.every === 'off' ? t('bak.autoOff') : t('bak.next', fmtDate(Math.max(s.nextAt || 0, Date.now()))))}</span>`)
  $('#bakStatus').innerHTML = lines.join('<br>')
  $('#bakFiles').innerHTML = c.files.length
    ? `<table><tr><th>${esc(t('bak.th.date'))}</th><th>${esc(t('bak.th.kind'))}</th><th>${esc(t('bak.th.size'))}</th><th></th></tr>${c.files.map((x) => `<tr><td>${esc(fmtDate(x.createdAt))}${x.encrypted ? ` <span title="${esc(t('bak.locked'))}">🔒</span>` : ''}</td><td>${esc(t('bak.kind.' + (x.kind || 'manual')))}</td><td>${esc(fmtSize(x.size))}</td><td class="nowrap"><button type="button" class="small ghost" data-bak-dl="${esc(x.name)}">${esc(t('bak.dl'))}</button> <button type="button" class="small danger" data-bak-restore="${esc(x.name)}">${esc(t('bak.restoreOne'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted small">${esc(t('bak.none'))}</p>`
}
async function loadBackup() { bakRender(await api('GET', '/v1/admin/backup')) }
// downloads go through fetch so an error shows here instead of an error page
async function bakFetchFile(url, btn) {
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = t('bak.preparing')
  try {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'accept-language': WA_LANG } })
    if (!r.ok) { let j = null; try { j = await r.json() } catch {} ; throw new Error(j?.error?.message || `HTTP ${r.status}`) }
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'whatsops-backup.whatsops'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(await r.blob())
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
  } finally { btn.disabled = false; btn.textContent = label }
}
function bakRestored(r) {
  const out = $('#bakOut')
  out.className = 'small'
  out.innerHTML = `<span class="ok-text">✓ ${esc(t('bak.restored', fmtDate(r.manifest.createdAt), r.counts.accounts ?? 0, r.counts.messages ?? 0, r.safetyCopy))}</span><br>${esc(t(r.restarting ? 'bak.restarting' : 'bak.restartNeeded'))}`
  if (!r.restarting) return
  // the old process answers for a moment: wait, then until the new one is up
  const t0 = Date.now()
  const poll = () => fetch('/healthz', { cache: 'no-store' }).then((x) => (x.ok ? location.reload() : Promise.reject())).catch(() => { if (Date.now() - t0 < 180_000) setTimeout(poll, 2000) })
  setTimeout(poll, 5000)
}
function bakBusy(on) { $$('#bakForm button').forEach((b) => { b.disabled = on }) }
$('#bakForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const body = { every: f.querySelector('input[name=every]:checked')?.value || 'off', folder: f.folder.value.trim(), keep: Number(f.keep.value) || 10 }
  if (f.password.value) body.password = f.password.value
  bakRender(await api('PUT', '/v1/admin/backup', body))
  toast(t('saved'))
}))
$('#bakPwRemove').addEventListener('click', run(async () => { bakRender(await api('PUT', '/v1/admin/backup', { removePassword: true })); toast(t('saved')) }))
$('#bakNow').addEventListener('click', run(async () => {
  bakBusy(true)
  try { const r = await api('POST', '/v1/admin/backup/now'); bakRender(r); toast(t('bak.saved', r.file)) } finally { bakBusy(false) }
}))
$('#bakDownload').addEventListener('click', run(async () => { await bakFetchFile('/v1/admin/backup/download', $('#bakDownload')); loadBackup().catch(() => {}) }))
$('#bakFiles').addEventListener('click', run(async (e) => {
  const dl = e.target.closest('[data-bak-dl]')
  if (dl) return bakFetchFile('/v1/admin/backup/files/' + encodeURIComponent(dl.dataset.bakDl), dl)
  const rs = e.target.closest('[data-bak-restore]')
  if (!rs || !confirm(t('bak.confirm'))) return
  bakBusy(true)
  try { bakRestored(await api('POST', '/v1/admin/backup/files/' + encodeURIComponent(rs.dataset.bakRestore) + '/restore', { password: $('#bakFilePw').value })) } finally { bakBusy(false) }
}))
$('#bakRestore').addEventListener('click', run(async () => {
  const file = $('#bakFile').files[0]
  if (!file) throw new Error(t('bak.pickFile'))
  if (!confirm(t('bak.confirm'))) return
  bakBusy(true)
  const out = $('#bakOut')
  out.className = 'small muted'
  out.textContent = t('bak.restoring')
  try {
    const r = await fetch('/v1/admin/backup/restore', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'accept-language': WA_LANG, 'x-backup-password': encodeURIComponent($('#bakFilePw').value) }, body: file })
    let j = null
    try { j = await r.json() } catch {}
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`)
    bakRestored(j)
  } catch (x) { out.className = 'small err-text'; out.textContent = x.message; throw x } finally { bakBusy(false) }
}))
// folder picker: the folders of the server
async function bakPick(p) {
  const l = await api('GET', '/v1/admin/backup/folders' + (p ? '?path=' + encodeURIComponent(p) : ''))
  bakPickPath = l.path
  $('#bakPath').textContent = l.path
  $('#bakUp').disabled = !l.parent
  $('#bakUp').dataset.to = l.parent || ''
  $('#bakRoots').innerHTML = l.roots.length > 1 ? l.roots.map((r) => `<button type="button" class="ghost small" data-pick="${esc(r)}">${esc(r)}</button>`).join('') : ''
  $('#bakDirs').innerHTML = l.dirs.length ? l.dirs.map((d) => `<li><button type="button" data-pick-sub="${esc(d)}">📁 ${esc(d)}</button></li>`).join('') : `<li class="muted">${esc(t('bak.empty'))}</li>`
}
$('#bakBrowse').addEventListener('click', run(async () => {
  const pk = $('#bakPicker')
  if (!pk.hidden) { pk.hidden = true; return }
  await bakPick($('#bakForm').folder.value.trim()).catch(() => bakPick(''))
  pk.hidden = false
}))
$('#bakUp').addEventListener('click', run(async (e) => { if (e.currentTarget.dataset.to) await bakPick(e.currentTarget.dataset.to) }))
$('#bakPicker').addEventListener('click', run(async (e) => {
  const sub = e.target.closest('[data-pick-sub]')
  if (sub) return bakPick(bakPickPath.replace(/[\\/]+$/, '') + (bakPickPath.includes('\\') ? '\\' : '/') + sub.dataset.pickSub)
  const root = e.target.closest('[data-pick]')
  if (root) return bakPick(root.dataset.pick)
}))
$('#bakMkdir').addEventListener('click', run(async () => {
  const name = $('#bakNewName').value.trim()
  if (!name) return
  const l = await api('POST', '/v1/admin/backup/folders', { parent: bakPickPath, name })
  $('#bakNewName').value = ''
  await bakPick(l.path)
}))
$('#bakUse').addEventListener('click', run(async () => {
  bakRender(await api('PUT', '/v1/admin/backup', { folder: bakPickPath }))
  $('#bakPicker').hidden = true
  toast(t('bak.folderSet', bakPickPath))
}))
async function loadSettings() {
  loadSessions().catch(() => {})
  const s = await api('GET', '/v1/admin/settings')
  const f = $('#setForm')
  for (const [k, v] of Object.entries(s)) { const el = f.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v }
  const me = await api('GET', '/auth/me')
  $('#pwState').textContent = t(me.passwordSet ? 'pw.set' : 'pw.unset')
  if (!state.overview) await loadOverview()
  const o = state.overview
  showAppearance(s.appearance, o.theme)
  $('#svcInfo').textContent = t('svc.info', o.versionLabel || o.version, Math.round(o.uptimeSec / 60), o.database.dialect, o.language?.server === 'it' ? 'Italiano' : 'English')
}
function showAppearance(value, th) {
  $$('#appearCard input[name=appearance]').forEach((r) => { r.checked = r.value === value })
  $('#appearInfo').innerHTML = th && th.desktop ? t('appear.sysDesktop', esc(th.desktop)) : t('appear.sysOs')
}
$$('#appearCard input[name=appearance]').forEach((r) => r.addEventListener('change', run(async () => {
  const s = await api('PUT', '/v1/admin/settings', { appearance: r.value })
  window.WA_THEME_CHECK?.()
  state.overview = null
  await loadOverview()
  showAppearance(s.appearance, state.overview.theme)
  toast(t('saved'))
})))
$('#setForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const body = {}
  for (const el of f.elements) { if (!el.name) continue; body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value }
  await api('PUT', '/v1/admin/settings', body)
  toast(t('saved'))
  await loadOverview()
  loadSettings()
}))
$('#pwForm').addEventListener('submit', run(async (e) => { e.preventDefault(); await api('PUT', '/v1/admin/password', { password: e.target.password.value }); e.target.reset(); toast(t('pw.done')); loadSettings() }))
$('#pwClear').addEventListener('click', run(async () => { if (!confirm(t('confirm.pwClear'))) return; await api('DELETE', '/v1/admin/password'); loadSettings() }))
$('#mkLink').addEventListener('click', run(async () => { const r = await api('POST', '/v1/admin/login-link'); $('#linkOut').hidden = false; $('#linkOut').innerHTML = `<code>${esc(r.url)}</code><button class="small" data-copy="${esc(r.url)}">${esc(t('copy'))}</button>` }))
$('#restart').addEventListener('click', run(async () => { if (!confirm(t('confirm.restart'))) return; await api('POST', '/v1/admin/restart'); toast(t('svc.restarting')); setTimeout(() => location.reload(), 5000) }))

// ---------------------------------------------------------------- boot
const loaders = { numbers: loadOverview, 'connect/plugins': loadPlugins, 'connect/mcp': loadConnect, 'connect/api': loadApi, 'connect/hooks': loadHooks, 'settings/general': loadSettings, 'settings/users': loadUsersAdmin, 'settings/db': loadDb, 'settings/log': loadLogs, 'settings/voice': () => loadVoice().catch((e) => { $('#voiceTestOut').textContent = e.message }), 'settings/updates': loadUpdates, 'settings/feedback': loadFeedback, 'settings/backup': loadBackup, 'settings/license': loadLicense }
;(async () => {
  try { state.me = await api('GET', '/v1/me') } catch { state.me = { role: 'owner' } }
  if (isUser()) userMode()
  else {
    try { await loadOverview() } catch (e) { toast(e.message, true) }
    startEvents()
  }
  let route = location.hash.slice(1)
  route = LEGACY[route] ?? route
  const [tab, sub, item] = route.split('/')
  if (tab && $('#' + tab)?.classList.contains('tab')) showTab(tab, sub, item)
  else if (isUser()) showTab('connect', 'plugins')
})()
/** A signed-in user sees only the plugins enabled for them: no numbers, no other connectors, no settings. */
function userMode() {
  document.body.classList.add('user-mode')
  $$('#tabs [data-tab=numbers], #tabs [data-tab=settings]').forEach((b) => b.remove())
  $$('.subnav[data-for=connect] [data-sub=mcp], .subnav[data-for=connect] [data-sub=api], .subnav[data-for=connect] [data-sub=hooks]').forEach((b) => b.remove())
  $('#numbers')?.remove()
  $('#settings')?.remove()
  SUBS.connect = ['plugins']
  $('#host').textContent = state.me.name + (state.me.phone ? ' · ' + state.me.phone : '')
}
