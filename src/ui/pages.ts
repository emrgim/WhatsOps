import { tr, type Lang } from '../i18n.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const BASE_CSS = `
.wrap{max-width:470px;margin:10vh auto;padding:0 14px}
.card{background:var(--card);border:2px solid var(--accent);padding:22px}
h1{font-size:17px;margin:0 0 2px;letter-spacing:.6px}p{margin:8px 0}.muted{color:var(--muted);font-size:12px}
.brand{display:flex;gap:12px;align-items:center;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border)}.brand img{width:40px;height:40px;display:block}
button,.btn{appearance:none;border:1px solid var(--accent);padding:9px 14px;font-weight:700;cursor:pointer;background:var(--accent);color:var(--accent-fg);width:100%;margin-top:10px;display:block;text-align:center;text-decoration:none}
button:hover,.btn:hover{background:transparent;color:var(--accent)}
button.secondary{background:transparent;border-color:var(--border);color:var(--fg);font-weight:400}button.secondary:hover{border-color:var(--accent);color:var(--accent)}
button.danger{background:transparent;border-color:var(--danger);color:var(--danger)}button.danger:hover{background:var(--danger);color:var(--accent-fg)}
input{width:100%;padding:9px 10px;border:1px solid var(--border);background:var(--card2);color:var(--fg);margin-top:8px}input:focus{outline:none;border-color:var(--accent)}
.code{font-weight:700;font-size:26px;line-height:1.2;letter-spacing:6px;text-align:center}
ul.scopes{padding-left:18px;margin:10px 0}ul.scopes li::marker{color:var(--accent)}hr{border:0;border-top:1px solid var(--border);margin:16px 0}
.err{color:var(--danger);font-size:12px;min-height:18px;margin-top:6px}.row{display:flex;gap:10px}.row>*{flex:1}
`

function layout(lang: Lang, title: string, body: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=2" sizes="any">
<link id="omTheme" rel="stylesheet" href="/theme.css?v=23"><link rel="stylesheet" href="/static/base.css?v=23"><script src="/static/theme.js?v=23" defer></script>
<style>${BASE_CSS}</style></head><body><div class="wrap"><div class="card">
<div class="brand"><img src="/favicon.svg?v=2" alt="" width="44" height="44"><div><h1>WhatsOps</h1><div class="muted">MCP · REST API · Baileys</div></div></div>
${body}</div></div></body></html>`
}

/** Shared login widget (WhatsApp code / password). Reloads the page on success. */
function loginWidget(lang: Lang, o: { otpEnabled: boolean; passwordSet: boolean }): string {
  const L = (s: string) => tr(lang, s)
  return `
<div id="login">
 ${o.otpEnabled ? `<div id="otp">
  <p>${L('Get a login code in the <b>“Message yourself”</b> chat of the linked WhatsApp number.')}</p>
  <button id="otpReq" type="button">${esc(L('Send me the code on WhatsApp'))}</button>
  <div id="otpBox" style="display:none"><input id="otpCode" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
  <button id="otpGo" type="button">${esc(L('Sign in'))}</button></div></div>` : ''}
 ${o.passwordSet ? `${o.otpEnabled ? '<hr>' : ''}<form id="pwf"><input id="pw" type="password" autocomplete="current-password" placeholder="${esc(L('Admin password'))}"><button type="submit" class="${o.otpEnabled ? 'secondary' : ''}">${esc(L('Sign in with password'))}</button></form>` : ''}
 <div class="err" id="err"></div>
 <p class="muted">${L('@login_hint')}</p>
</div>
<script>
const SENT=${JSON.stringify(L('Code sent to {0} · resend'))};
const $=s=>document.querySelector(s);const err=m=>{$('#err').textContent=m||''};
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),credentials:'same-origin'});let j={};try{j=await r.json()}catch{};if(!r.ok)throw new Error((j.error&&j.error.message)||j.error_description||('HTTP '+r.status));return j}
const done=()=>location.reload();
$('#otpReq')&&$('#otpReq').addEventListener('click',async()=>{err();try{const j=await post('/auth/otp/request');$('#otpBox').style.display='block';$('#otpReq').textContent=SENT.replace('{0}',j.sentTo||'WhatsApp');$('#otpCode').focus()}catch(e){err(e.message)}});
$('#otpGo')&&$('#otpGo').addEventListener('click',async()=>{err();try{await post('/auth/otp/verify',{code:$('#otpCode').value});done()}catch(e){err(e.message)}});
$('#otpCode')&&$('#otpCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('#otpGo').click()});
$('#pwf')&&$('#pwf').addEventListener('submit',async e=>{e.preventDefault();err();try{await post('/auth/password',{password:$('#pw').value});done()}catch(x){err(x.message)}});
</script>`
}

export function loginPage(lang: Lang, o: { otpEnabled: boolean; passwordSet: boolean }): string {
  return layout(lang, tr(lang, 'Sign in · WhatsOps'), `<p>${esc(tr(lang, 'Configuration of the WhatsApp server (numbers, database, API keys, MCP connectors).'))}</p>${loginWidget(lang, o)}`)
}

export function authorizePage(
  lang: Lang,
  o: {
    loggedIn: boolean
    clientName: string
    redirectHost: string
    scopes: string[]
    action: string
    params: Record<string, string>
    otpEnabled: boolean
    passwordSet: boolean
  },
): string {
  const L = (s: string, p: unknown[] = []) => tr(lang, s, p)
  const labels: Record<string, string> = { read: L('Read chats, messages, contacts and groups'), send: L('Send messages, media and reactions on your behalf') }
  if (!o.loggedIn) {
    return layout(
      lang,
      L('Authorize · WhatsOps'),
      `<p>${L('<b>{0}</b> is asking for access to your WhatsApp.', [esc(o.clientName)])}</p><p class="muted">${esc(L('Sign in as the owner first.'))}</p>${loginWidget(lang, { otpEnabled: o.otpEnabled, passwordSet: o.passwordSet })}`,
    )
  }
  const hidden = Object.entries(o.params)
    .filter(([k]) => k !== 'decision')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')
  return layout(
    lang,
    L('Authorize · WhatsOps'),
    `<p>${L('<b>{0}</b> wants to connect to your WhatsApp server.', [esc(o.clientName)])}</p>
<ul class="scopes">${o.scopes.map((s) => `<li>${esc(labels[s] ?? s)}</li>`).join('')}</ul>
<p class="muted">${L('After authorizing you will be sent back to <b>{0}</b>. You can revoke access at any time from the config page → Connectors.', [esc(o.redirectHost)])}</p>
<form method="post" action="${esc(o.action)}">${hidden}
<div class="row"><button class="secondary" name="decision" value="deny" type="submit">${esc(L('Deny'))}</button><button name="decision" value="approve" type="submit">${esc(L('Authorize'))}</button></div></form>`,
  )
}

export function incompleteAuthorizePage(lang: Lang, origin: string, detail?: string): string {
  const L = (s: string) => tr(lang, s)
  return layout(
    lang,
    L('Authorization · WhatsOps'),
    `<p><b>${esc(L('Incomplete authorization URL.'))}</b></p><p class="muted">${esc(detail ?? L('client_id, redirect_uri or code_challenge (PKCE) is missing. Start the connection from your MCP client (Cursor, Claude, Grok…) using the server address:'))}</p>
<p><code>${esc(origin)}/mcp</code></p><p class="muted">${esc(L('For clients without OAuth, create an API key on the config page.'))}</p><a class="btn" href="/" style="display:block;text-align:center;text-decoration:none">${esc(L('Open config page'))}</a>`,
  )
}

export function messagePage(lang: Lang, title: string, msg: string): string {
  return layout(lang, title, `<p>${esc(msg)}</p><a class="btn" href="/" style="display:block;text-align:center;text-decoration:none">${esc(tr(lang, 'Continue'))}</a>`)
}
