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

// ---------------------------------------------------------------- tabs
// top tabs: numbers · connectors (mcp / api / hooks) · settings (general / db)
const SUBS = { connect: ['mcp', 'api', 'hooks'], settings: ['general', 'db', 'log'] }
const LEGACY = { keys: 'connect/api', hooks: 'connect/hooks', db: 'settings/db' }
const lastSub = { connect: 'mcp', settings: 'general' }
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))
$$('.subnav button').forEach((b) => b.addEventListener('click', () => showTab(b.closest('.subnav').dataset.for, b.dataset.sub)))
function showTab(tab, sub) {
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
  history.replaceState(null, '', '#' + route)
  loaders[route]?.()
}
$('#logout').addEventListener('click', run(async () => { await api('POST', '/auth/logout'); location.reload() }))

// ---------------------------------------------------------------- numbers
const STATE_CLASS = { open: 'open', connecting: 'warn', reconnecting: 'warn', qr: 'warn', pairing_code: 'warn', not_linked: 'bad', logged_out: 'bad', replaced: 'bad', pairing_expired: 'bad', error: 'bad', stopped: '' }
function badge(s) { return `<span class="badge ${STATE_CLASS[s] ?? ''}">${esc(t('state.' + s))}</span>` }

async function loadOverview() {
  state.overview = await api('GET', '/v1/admin/overview')
  state.accounts = state.overview.accounts
  $('#host').textContent = new URL(state.overview.publicUrl).host + ' · v' + state.overview.version
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
      <div class="top"><div><h4>${esc(a.label)} ${a.default ? `<span class="badge">${esc(t('acc.default'))}</span>` : ''}</h4>
        <div class="phone">${esc(phone || '—')}</div><div class="muted small">${esc(a.me?.name ?? '')} · id <code>${esc(a.id)}</code></div></div>${badge(a.state)}</div>
      ${st ? `<div class="stats"><span><b>${num(st.chats)}</b> ${esc(t('acc.chats'))}</span><span><b>${num(st.messages)}</b> ${esc(t('acc.messages'))}</span><span><b>${num(st.contacts)}</b> ${esc(t('acc.contacts'))}</span><span><b>${num(st.groups)}</b> ${esc(t('acc.groups'))}</span></div>` : ''}
      ${a.lastDisconnect && a.state !== 'open' ? `<div class="muted small">${esc(t('acc.lastDisconnect', a.lastDisconnect.reason + (a.lastDisconnect.code ? ' (' + a.lastDisconnect.code + ')' : '')))}</div>` : ''}
      ${a.history && a.history.progress != null && a.history.progress < 100 ? `<div class="muted small">${esc(t('acc.history', a.history.progress, num(a.history.messages)))}</div>` : ''}
      <div class="actions">
        <button class="small" data-act="pair">${esc(t(linked ? 'acc.relink' : 'acc.link'))}</button>
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
    case 'restart': await api('POST', `/v1/accounts/${id}/restart`); toast(t('acc.reconnecting')); break
    case 'default': await api('PATCH', `/v1/accounts/${id}`, { isDefault: true }); break
    case 'toggle': await api('PATCH', `/v1/accounts/${id}`, { enabled: !a.enabled }); break
    case 'logout':
      if (!confirm(t('confirm.logout', a.label))) return
      await api('POST', `/v1/accounts/${id}/logout`); break
    case 'delete':
      if (!confirm(t('confirm.delete', a.label))) return
      await api('DELETE', `/v1/accounts/${id}`); break
    case 'import': return openImport(id)
  }
  await loadOverview()
}))

$('#addNumber').addEventListener('click', () => { $('#addForm').reset(); $('#addDlg').showModal() })
$('#addDlg').addEventListener('close', run(async () => {
  if ($('#addDlg').returnValue !== 'ok') return
  const f = new FormData($('#addForm'))
  const a = await api('POST', '/v1/accounts', { label: f.get('label'), phone: f.get('phone') || undefined, syncHistory: f.get('sync') === 'on' })
  await loadOverview()
  openPair(a.id, f.get('phone'))
}))

// ---------------------------------------------------------------- pairing
function openPair(id, phone) {
  const a = state.accounts.find((x) => x.id === id)
  pairing = { id }
  $('#pairTitle').textContent = t('pair.title', a?.label ?? id)
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
  if (cur?.me && !confirm(t('pair.confirmRelink', cur.label, cur.me.phone))) return
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
  es.addEventListener('pairing.qr', (e) => { const d = JSON.parse(e.data); if (pairing && d.account === pairing.id) pollPair() })
  es.addEventListener('pairing.code', (e) => { const d = JSON.parse(e.data); if (pairing && d.account === pairing.id) pollPair() })
}

// ---------------------------------------------------------------- connectors
function clientCard(title, body) { return `<div class="card client"><h4>${title}</h4>${body}</div>` }
async function loadConnect() {
  $('#mcpUrl').textContent = MCP
  const cursorCfg = btoa(JSON.stringify({ url: MCP }))
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=whatsops&config=${encodeURIComponent(cursorCfg)}`
  $('#clients').innerHTML = [
    clientCard('Cursor', `<p class="muted">${esc(t('connect.cursor.hint'))}</p><p><a href="${esc(cursorLink)}"><button type="button">${esc(t('connect.cursor.add'))}</button></a></p>
      <pre>${esc(JSON.stringify({ mcpServers: { whatsops: { url: MCP } } }, null, 2))}</pre><p class="muted small">${t('connect.cursor.plugin')}</p>`),
    clientCard('Claude', `<p class="muted">${t('connect.claude.hint')}</p><pre>${esc(MCP)}</pre>
      <p class="muted">${esc(t('connect.claude.code'))}</p><pre>claude mcp add --transport http whatsops ${esc(MCP)}</pre>`),
    clientCard('Grok (grok.com)', `<p class="muted">${esc(t('connect.grok.hint'))}</p><pre>Server URL: ${esc(MCP)}
Client ID: grok
Client Secret: ${esc(t('connect.empty'))}
Authorization Endpoint: ${esc(ORIGIN)}/oauth/authorize
Token Endpoint: ${esc(ORIGIN)}/oauth/token
Scopes: read send
Token Auth Method: none (PKCE)</pre>`),
    clientCard('Grok Bot', `<p class="muted">${esc(t('connect.grokbot.hint'))}</p><div id="grokBotOut"><button type="button" class="ghost" data-mk="grokbot">${esc(t('connect.grokbot.mk'))}</button></div>`),
    clientCard('Hermes', `<p class="muted">${esc(t('connect.hermes.hint'))}</p><div id="hermesOut"><button type="button" class="ghost" data-mk="hermes">${esc(t('connect.hermes.mk'))}</button></div>`),
    clientCard(esc(t('connect.other.title')), `<p class="muted">${esc(t('connect.other.hint'))}</p><pre>${esc(MCP)}</pre>
      <p class="muted">${esc(t('connect.other.stdio'))}</p><pre>WA_MCP_URL=${esc(MCP)} WA_API_KEY=wam_… mcp-mrg-whatsops stdio</pre>`),
  ].join('')
  const [o, s] = await Promise.all([api('GET', '/v1/admin/oauth'), api('GET', '/v1/admin/sessions')])
  $('#grants').innerHTML = o.grants.length
    ? `<table><tr><th>${t('th.app')}</th><th>${t('th.scopes')}</th><th>${t('th.authorized')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${o.grants.map((g) => `<tr><td>${esc(g.clientName)}</td><td>${esc(g.scopes)}</td><td>${fmtDate(g.createdAt)}</td><td>${fmtDate(g.lastUsed)}</td><td><button class="small danger" data-revoke-grant="${esc(g.family)}">${esc(t('revoke'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('connect.noGrants'))}</p>`
  $('#sessions').innerHTML = `<table><tr><th>${t('th.access')}</th><th>${t('th.created')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${s.map((x) => `<tr><td>${esc(x.label)}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.last_seen)}</td><td><button class="small danger" data-revoke-sess="${esc(x.id_hash)}">${esc(t('revoke'))}</button></td></tr>`).join('')}</table>`
}
$('#connect').addEventListener('click', run(async (e) => {
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
  if (s && confirm(t('confirm.revokeSession'))) { await api('DELETE', `/v1/admin/sessions/${s.dataset.revokeSess}`); await loadConnect() }
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
    ? `<table><tr><th>URL</th><th>${t('th.events')}</th><th>${t('th.number')}</th><th>${t('th.status')}</th><th></th></tr>${hooks.map((h) => `<tr><td><code>${esc(h.url)}</code></td><td>${esc(h.events)}</td><td>${esc(h.account_id === '*' ? t('all') : h.account_id)}</td><td>${esc(t(h.active ? 'hooks.active' : 'hooks.paused'))}</td><td class="actions"><button class="small ghost" data-hook-test="${esc(h.id)}">${esc(t('hooks.test'))}</button><button class="small ghost" data-hook-toggle="${esc(h.id)}" data-active="${h.active}">${esc(t(h.active ? 'hooks.pause' : 'hooks.enable'))}</button><button class="small danger" data-hook-del="${esc(h.id)}">${esc(t('hooks.delete'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('hooks.none'))}</p>`
  $('#deliveries').innerHTML = del.length
    ? `<table><tr><th>${t('th.when')}</th><th>${t('th.event')}</th><th>${t('th.result')}</th><th>${t('th.attempts')}</th><th>${t('th.http')}</th></tr>${del.slice(0, 30).map((d) => `<tr><td>${fmtDate(d.created_at)}</td><td>${esc(d.event)}</td><td>${esc(d.state)}${d.last_error ? ' · ' + esc(d.last_error) : ''}</td><td>${d.attempts}</td><td>${d.last_status || '—'}</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('hooks.noDeliveries'))}</p>`
}
$('#hookForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const h = await api('POST', '/v1/admin/webhooks', { url: f.url.value, events: f.events.value || '*', account: f.account.value })
  $('#newHook').hidden = false
  $('#newHook').innerHTML = `<b>${esc(t('hooks.created'))}</b><code>${esc(h.secret)}</code><button class="small" data-copy="${esc(h.secret)}">${esc(t('copy'))}</button>`
  f.reset()
  await loadHooks()
}))
$('#hookList').addEventListener('click', run(async (e) => {
  const tb = e.target.closest('[data-hook-test]'); if (tb) { await api('POST', `/v1/admin/webhooks/${tb.dataset.hookTest}/test`); toast(t('hooks.testSent')); setTimeout(() => loadHooks(), 2500) }
  const g = e.target.closest('[data-hook-toggle]'); if (g) { await api('PATCH', `/v1/admin/webhooks/${g.dataset.hookToggle}`, { active: g.dataset.active !== '1' }); await loadHooks() }
  const d = e.target.closest('[data-hook-del]'); if (d && confirm(t('confirm.deleteHook'))) { await api('DELETE', `/v1/admin/webhooks/${d.dataset.hookDel}`); await loadHooks() }
}))

// ---------------------------------------------------------------- api vocabulary
let vocab = null
const VOCAB_METHODS = ['get', 'post', 'put', 'patch', 'delete']
const VOCAB_ORDER = ['Send', 'Messages', 'Accounts', 'Contacts', 'Groups', 'Events', 'Webhooks', 'Admin']
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

// ---------------------------------------------------------------- service log
const LEVEL_NAME = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
const LEVEL_MIN = { all: 0, info: 30, warn: 40, error: 50 }
let logES = null
let logShown = 0
function logTime(t) {
  const d = new Date(t)
  const today = d.toDateString() === new Date().toDateString()
  return today ? d.toLocaleTimeString(LOCALE, { hour12: false }) : d.toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium', hour12: false })
}
function logSummary(data) {
  if (!data) return ''
  return Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? v.split('\n')[0] : JSON.stringify(v)}`).join(' ').slice(0, 220)
}
function logRow(e) {
  const lvl = LEVEL_NAME[e.level] ?? e.level
  const head = `<span class="lt">${esc(logTime(e.t))}</span><span class="ll">${esc(lvl)}</span><span class="lm">${esc(e.mod ?? '')}</span><span class="lx">${esc(e.msg)}${e.data ? ` <span class="ld">${esc(logSummary(e.data))}</span>` : ''}</span>`
  const cls = `lg lvl-${Math.min(60, Math.floor(e.level / 10) * 10)}`
  return e.data ? `<details class="${cls}"><summary>${head}</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>` : `<div class="${cls}"><div class="row">${head}</div></div>`
}
function logMatches(e) {
  if (e.level < LEVEL_MIN[$('#logLevel').value]) return false
  const q = $('#logQ').value.trim().toLowerCase()
  return !q || `${e.mod ?? ''} ${e.msg} ${e.data ? JSON.stringify(e.data) : ''}`.toLowerCase().includes(q)
}
function logCount() { $('#logCount').textContent = logShown ? t('log.count', num(logShown)) : t('log.empty') }
async function loadLogs() {
  const qs = new URLSearchParams({ level: $('#logLevel').value, limit: '1000' })
  const q = $('#logQ').value.trim()
  if (q) qs.set('q', q)
  const r = await api('GET', '/v1/admin/logs?' + qs)
  const rows = r.entries.slice().reverse()
  logShown = rows.length
  $('#logList').innerHTML = rows.map(logRow).join('')
  logCount()
  if ($('#logLive').checked) startLogLive(); else stopLogLive()
}
function startLogLive() {
  if (logES) return
  logES = new EventSource('/v1/admin/logs/stream')
  logES.onmessage = (m) => {
    let e
    try { e = JSON.parse(m.data) } catch { return }
    if (!logMatches(e)) return
    $('#logList').insertAdjacentHTML('afterbegin', logRow(e))
    logShown++
    const list = $('#logList')
    while (list.children.length > 1000) list.lastElementChild.remove()
    logCount()
  }
}
function stopLogLive() { if (logES) { logES.close(); logES = null } }
let logQTimer = null
$('#logLevel').addEventListener('change', run(loadLogs))
$('#logQ').addEventListener('input', () => { clearTimeout(logQTimer); logQTimer = setTimeout(run(loadLogs), 300) })
$('#logLive').addEventListener('change', (e) => (e.target.checked ? startLogLive() : stopLogLive()))

// ---------------------------------------------------------------- settings
async function loadSettings() {
  const s = await api('GET', '/v1/admin/settings')
  const f = $('#setForm')
  for (const [k, v] of Object.entries(s)) { const el = f.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v }
  const me = await api('GET', '/auth/me')
  $('#pwState').textContent = t(me.passwordSet ? 'pw.set' : 'pw.unset')
  if (!state.overview) await loadOverview()
  const o = state.overview
  showAppearance(s.appearance, o.theme)
  $('#svcInfo').textContent = t('svc.info', o.version, Math.round(o.uptimeSec / 60), o.database.dialect, o.language?.server === 'it' ? 'Italiano' : 'English')
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
const loaders = { numbers: loadOverview, 'connect/mcp': loadConnect, 'connect/api': loadApi, 'connect/hooks': loadHooks, 'settings/general': loadSettings, 'settings/db': loadDb, 'settings/log': loadLogs }
;(async () => {
  try { await loadOverview() } catch (e) { toast(e.message, true) }
  startEvents()
  let route = location.hash.slice(1)
  route = LEGACY[route] ?? route
  const [tab, sub] = route.split('/')
  if (tab && $('#' + tab)?.classList.contains('tab')) showTab(tab, sub)
})()
