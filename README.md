<p align="center"><img src="assets/logo.svg" width="96" alt="WhatsOps"></p>

# WhatsOps

WhatsApp **REST API + MCP server** for your own numbers, built on [Baileys](https://baileys.wiki) v7 (WhatsApp Web linked device).

One process holds one linked-device connection per number and exposes it three ways:

- **MCP** (`/mcp`, Streamable HTTP) for AI agents: Claude, ChatGPT, Grok, Gemini, Cursor, Hermes… with OAuth 2.1 or API keys, plus a stdio proxy for stdio-only clients.
- **REST API** (`/v1`) with OpenAPI docs at `/docs`, Server-Sent Events and signed webhooks.
- **Config page** (`/`) to link numbers (QR code or phone-number pairing code) and edit their WhatsApp profile, connect plugins and MCP clients, create API keys, manage webhooks, choose the database and the appearance (Light / Dark / System), read the service log, send feedback and get updates.

English and Italian: the config page follows the browser language, the server (MCP tool texts, errors) follows the operating system language.

## Features

- Several WhatsApp numbers in one server, each with its own session; a default number for calls that do not name one.
- Chats, messages, contacts and groups stored in SQL: **SQLite** by default, **PostgreSQL** or **MySQL/MariaDB** selectable from the config page (with optional copy of all data and automatic restart).
- Full history import when a number is linked (optional), media download, search.
- Send text, media (URL or base64), location, reactions; edit / delete own messages; mark as read. Idempotency keys, per-number rate limit, per-chat pause, optional recipient allow-list.
- OAuth 2.1 (PKCE, dynamic client registration, static client ids) with 24 h access tokens and 90-day sliding refresh tokens; scoped API keys (`read`, `send`, `admin`) limited to chosen numbers.
- Admin sign-in with a one-time code sent to the number's own "Message yourself" chat, a one-time login link, or a password.
- Each number's id is its **phone number** and its name is its **WhatsApp profile name**, kept live. Name, info and photo can be edited from the config page, the API or MCP: the change is made on WhatsApp itself, so the two never differ.
- **Feedback** (Settings → Feedback, or the `whatsops_feedback` MCP tool) opens an issue in this repository without any GitHub login: every installation signs with its own installation code (`WO-XXXX-XXXX`).
- **Crash and malfunction reports**: crashes and errors are kept (scrubbed of numbers, names, keys and paths) and sent only if you choose: ask first (default), send automatically, or don't collect. The same problem becomes one issue.
- **Auto-update**: a `git clone` installation checks this repository's releases every 5 minutes, installs a new version by itself (fetch, `npm ci`, build, restart) and goes back to the previous one if the new one does not start. Installations with local changes are never touched.
- **Plugins** (Connectors → Plugins). First one: **Current RMS** — see below.
- Service log in **Settings → Log**, terminal style (`tail -f`): live, searchable, filterable by level, downloadable; every API change and MCP tool call is listed (never message bodies). Also kept as a rotating file in `<data>/logs/`.

## MCP tools

`whatsapp_accounts`, `whatsapp_get_profile`, `whatsapp_update_profile`, `whatsops_feedback`, `currentrms_discussions`, `currentrms_set_sync`, `whatsapp_list_chats`, `whatsapp_get_messages`, `whatsapp_search_messages`, `whatsapp_find_contact`, `whatsapp_check_number`, `whatsapp_list_groups`, `whatsapp_get_group`, `whatsapp_send_text`, `whatsapp_send_media`, `whatsapp_send_location`, `whatsapp_react`, `whatsapp_mark_read`, `whatsapp_edit_message`, `whatsapp_delete_message`, `whatsapp_download_media`.

## Install (from source)

Requirements: **Node.js 24+** and git.

```bash
git clone https://github.com/emrgim/mcp-mrg-whatsops.git
cd mcp-mrg-whatsops
npm ci
npm run build
npm start                      # listens on http://127.0.0.1:8810
```

First sign-in (no number is linked yet, so no WhatsApp code can be sent):

```bash
node dist/cli.js login-link    # prints a one-time admin URL, valid 30 minutes
```

Open it, go to **Numbers → Add number**, and link the phone with the QR code or with a pairing code (WhatsApp → Linked devices → Link with phone number).

Run it as a service: `deploy/mcp-mrg-whatsops.service` is a systemd user unit (adjust the paths, see the comments inside). Auto-update restarts the service by itself, so keep a service manager with automatic restart (systemd `Restart=always`, launchd `KeepAlive`).

### Expose it

WhatsOps listens on loopback only. Put it behind a reverse proxy or tunnel (Caddy, nginx, Cloudflare Tunnel…) with HTTPS and set the public URL (`WA_PUBLIC_URL` or Settings → General). OAuth and the MCP connectors need the public HTTPS URL.

## Connect

The config page, **Connectors**, lists plugins and MCP clients as tiles (Cursor, Claude, ChatGPT, Grok, Grok Bot, Hermes, Gemini, any other MCP client); open a tile for its ready-to-paste settings.

- **OAuth clients** (Claude, ChatGPT, Gemini, Grok): add a remote MCP connector with `https://<your-host>/mcp`; the client registers itself and you approve it in the browser.
- **API key clients** (Hermes, scripts): create a key in **Connectors → API** and send `Authorization: Bearer wam_…` (or `?token=wam_…`).
- **stdio-only clients**: `WA_MCP_URL=https://<your-host>/mcp WA_API_KEY=wam_… node dist/cli.js stdio`.

REST example:

```bash
curl -H "Authorization: Bearer wam_…" \
     -H "Content-Type: application/json" \
     -d '{"to":"+15551234567","text":"Hello","idempotencyKey":"hello-1"}' \
     http://127.0.0.1:8810/v1/messages/text
```

The full API vocabulary is in **Connectors → API** and at `/docs`.

### Webhooks

Events: `message.received`, `message.sent`, `message.update`, `connection.update`, `history.sync`, `chat.update`, `profile.update` (or `*`). Each delivery is a JSON `POST` signed with
`X-WA-Signature: sha256=HMAC(secret, X-WA-Timestamp + "." + body)` and retried up to 5 times (1 min → 12 h). Live events are also available as SSE at `/v1/events`.

## CLI

```
node dist/cli.js serve                         start the server (same as npm start)
node dist/cli.js stdio                         stdio MCP proxy (env WA_MCP_URL, WA_API_KEY, WA_LANG)
node dist/cli.js login-link [--minutes 30]     one-time admin login URL
node dist/cli.js key --name N --scopes read,send[,admin] [--accounts id1,id2]
node dist/cli.js db show | db set <sqlite:///path|postgres://…|mysql://…>
node dist/cli.js status
```

## Plugin: Current RMS

Links the discussions of [Current RMS](https://www.current-rms.com) (OnRent Events) to a WhatsApp number. Connectors → Plugins → Current RMS:

1. **Connection**: your subdomain (`yourcompany` from `yourcompany.current-rms.com`) and an API key (System Setup → Integrations → API). The key is stored on the server and never shown again.
2. **Settings**:
   - **WhatsApp number** that owns the groups.
   - **Structure on WhatsApp**: *Single groups* — one group per discussion, fully isolated, nobody sees the other discussions; or *Community per record* — one Community per record (opportunity, project, contact…) with a group per discussion: messages stay sealed in each group and new members need approval, but Community members can see the names of all its groups.
   - **Contacts custom field** that holds the WhatsApp number: only participants with a number there are added.
   - People who can't be added (privacy settings) get the **invite link** privately (can be turned off).
3. **Discussions**: listed by record, with participants and replies. Turning a discussion on creates the WhatsApp group (closed: only admins add people and change settings, approval on), adds the participants, posts the whole discussion grouped by day, then mirrors both ways: a new comment in Current RMS → a message in the group (`*Name*` + text); a message in the group → a comment in the discussion (as the matching contact when possible, otherwise `Name (WhatsApp): text`).
4. **Instant updates**: turn webhooks on in Current RMS (System Setup → Company Information), then *Register webhooks*. WhatsOps must have a public HTTPS address (`WA_PUBLIC_URL`). Without webhooks, synced discussions are checked every 2 minutes.

Groups are created one at a time with a pause between them, so WhatsApp does not see a burst. API calls stay under Current RMS' limit of 60 per minute. The same is available from the API (`/v1/plugins/currentrms/…`) and MCP (`currentrms_discussions`, `currentrms_set_sync`).

## Configuration

Everything is configured from the config page. Optional environment variables are listed in [`.env.example`](.env.example) (`WA_HOST`, `WA_PORT`, `WA_PUBLIC_URL`, `WA_DATA_DIR`, `WA_DB_URL`, `WA_LANG`, `WA_LOG_LEVEL`, `WA_THEME`).

Forks: point feedback, reports and updates to your own repository with `WA_FEEDBACK_REPO=owner/repo`, `WA_FEEDBACK_TOKEN` (a fine-grained token with only *Issues: read & write* on that repository) and `WA_UPDATE_REPO`; `WA_UPDATE_INTERVAL_MIN` changes the update check interval.

Licenses: WhatsOps is free. A [Polar](https://polar.sh) license check is built in but off; it turns on only when a Polar organization is set (`WA_POLAR_ORG_ID`).

Data (database, media, backups) lives in `~/.local/share/mcp-mrg-whatsops/` (macOS: `~/Library/Application Support/mcp-mrg-whatsops/`), never in the repository.

## Notes

- WhatsOps is an unofficial WhatsApp Web client. Use it with your own numbers and follow WhatsApp's terms.
- WhatsApp unlinks linked devices when the main phone stays offline for more than 14 days.
- One server per number: do not link the same device to two programs at once.
- The key in `src/issues-key.ts` can only open issues in this repository and nothing else; it is scrambled only so that secret scanners don't revoke it.

## Development

```bash
npm run typecheck
npm test
```
