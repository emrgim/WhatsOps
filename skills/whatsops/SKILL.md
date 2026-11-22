---
name: whatsops
description: Use when the user wants to read, search, send or organise WhatsApp messages, chats, contacts, groups, labels or statuses on their own WhatsApp numbers through a WhatsOps MCP server, or to install WhatsOps and connect an agent to it. Explains every WhatsOps tool, the rules for using them and how to chain them.
license: See the WhatsOps repository
metadata:
  repository: https://github.com/emrgim/WhatsOps
  skill: https://github.com/emrgim/WhatsOps/tree/main/skills/whatsops
---

# WhatsOps

WhatsOps is a self-hosted server. It links the owner's own WhatsApp numbers as a linked device (the same way WhatsApp Web does) and gives them to agents through MCP, a REST API and webhooks. Everything you send goes out **as the owner**, from their real number.

- Repository: https://github.com/emrgim/WhatsOps
- This skill: https://github.com/emrgim/WhatsOps/tree/main/skills/whatsops
- Skill file to upload: https://github.com/emrgim/WhatsOps/raw/main/skills/whatsops.skill
- Every tool with all its parameters: [references/tools.md](references/tools.md)

In the examples, `whatsops.example.com` stands for the owner's own WhatsOps address.

## 1. Install the server (once, by the owner)

1. Download the installer from https://github.com/emrgim/WhatsOps/releases/latest: `.dmg` (macOS, Intel `x64` or Apple Silicon `arm64`), `-setup.exe` (Windows), `.deb` / `.rpm` (Linux). Node.js is included. On any Linux without root:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/emrgim/WhatsOps/main/install/linux.sh | bash
   ```
   From source (Node.js 24+): `git clone https://github.com/emrgim/WhatsOps.git && cd WhatsOps && npm ci && npm run build && npm start`.
2. WhatsOps runs in the background and opens **http://127.0.0.1:8810** already signed in.
3. **Numbers → Add number**: link the phone with the QR code, or with a pairing code (WhatsApp → Linked devices → Link with phone number).
4. For agents on other machines or in the cloud (Claude, ChatGPT, Gemini, Grok): put WhatsOps behind HTTPS (a reverse proxy or a tunnel: Caddy, nginx, Cloudflare Tunnel…) and set that address in **Settings → General → Public URL** (or `WA_PUBLIC_URL`). OAuth needs it.

## 2. Connect the agent

MCP endpoint: `https://whatsops.example.com/mcp`. On the same machine you can also use `http://127.0.0.1:8810/mcp`. In WhatsOps, **Connectors → MCP** has a tile with ready-to-paste settings for each app.

| Agent | How |
|---|---|
| Claude (web, desktop) | Settings → Connectors → Add custom connector → the endpoint. Sign in to WhatsOps and allow. |
| Claude Code | `claude mcp add --transport http whatsops https://whatsops.example.com/mcp` |
| ChatGPT | Settings → Apps & Connectors → Advanced settings → Developer mode, then Create a connector with the endpoint and OAuth. |
| Gemini CLI | `gemini mcp add --transport http whatsops https://whatsops.example.com/mcp`, then `/mcp auth whatsops` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"whatsops": {"url": "https://whatsops.example.com/mcp"}}}`; it signs in with OAuth on first use. |
| Grok | Server URL = the endpoint, Client ID `grok`, no secret, authorization `/oauth/authorize`, token `/oauth/token`, scopes `read send`, PKCE. |
| Hermes, scripts | **Connectors → API** → create a key (`wam_…`) with the scopes it needs; send `Authorization: Bearer wam_…`. |
| Grok Bot | The Grok Bot tile makes a key and gives the endpoint with `?token=wam_…` (no OAuth). |
| stdio-only clients | `WA_MCP_URL=https://whatsops.example.com/mcp WA_API_KEY=wam_… mcp-mrg-whatsops stdio` (from source: `node dist/cli.js stdio`) |

Scopes: `read` (chats, messages, contacts, groups, labels) and `send` (everything that changes WhatsApp). A credential without `send` gets `This credential lacks the "send" scope`.

**Check:** call `whatsapp_accounts`. Each connected number has state `open`. Any other state means the owner must open WhatsOps → Numbers and link the phone again.

## 3. Install this skill

The skill is the folder `skills/whatsops` of the repository. `whatsops.skill` is the same folder as a ZIP.

| Agent | Where |
|---|---|
| Claude (web, desktop) | Customize → Skills → upload `whatsops.skill` (needs code execution on in Settings → Capabilities; rename it `.zip` if a ZIP is asked for) |
| Claude Code | `~/.claude/skills/whatsops/` |
| Cursor | `~/.cursor/skills/whatsops/` |
| Codex | `~/.agents/skills/whatsops/` |
| Gemini CLI | `~/.gemini/skills/whatsops/` |
| Hermes | `~/.hermes/skills/whatsops/` |

macOS / Linux (change the folder for your agent):
```bash
curl -fsSL https://github.com/emrgim/WhatsOps/raw/main/skills/whatsops.skill -o /tmp/whatsops.zip
mkdir -p ~/.claude/skills && unzip -o /tmp/whatsops.zip -d ~/.claude/skills
```
Windows (PowerShell):
```powershell
Invoke-WebRequest https://github.com/emrgim/WhatsOps/raw/main/skills/whatsops.skill -OutFile $env:TEMP\whatsops.zip
Expand-Archive -Force $env:TEMP\whatsops.zip "$HOME\.claude\skills"
```

## 4. Rules

1. **You speak as the owner.** Before any tool that changes WhatsApp (send, reply, react, edit, delete, status, profile, labels, disappearing messages, plugin groups), confirm the recipient and the exact text with the user, unless they explicitly asked for exactly that. Delete for everyone and profile changes cannot be undone.
2. **Pick the number.** The owner may have several numbers. Call `whatsapp_accounts` and pass `account` (phone number or id) when it is not the default one.
3. **Never guess a phone number.** With only a name, call `whatsapp_find_contact` and use the phone or JID it returns. If a name matches several chats you get `AMBIGUOUS_CHAT` with the candidates: ask the user which one.
4. **Chat and recipient forms:** `+971501234567` (international format), a JID (`…@s.whatsapp.net` person, `…@g.us` group, `…@lid` hidden id of a person), or the exact chat or contact name. A `…@lid` and a phone number can be the same person: WhatsOps merges them.
5. **Retries:** pass the same `idempotency_key` when you retry a send. The message then goes out at most once.
6. **Voice messages** (`audioMessage`): the message carries its `transcript` when it is ready. If it is null, call `whatsapp_transcribe_voice`.
7. **Media:** `whatsapp_download_media` gives a link valid 1 hour, plus the image itself when it is small. Send files with `url` (http/https) or `base64`.
8. **Labels** can be changed only on WhatsApp Business numbers. To change a chat's label, remove the old one and add the new one in the same `whatsapp_label_chat` call.
9. **Statuses** (`whatsapp_post_status`) are seen only by the people in `audience` (people, not groups) and by the owner's own devices, for 24 hours. `whatsapp_status_views` tells who opened each one, who liked it (contact and emoji), the replies it got and who did not open it yet.
10. **Sending to someone new** can be switched off (`COLD_CONTACT`) or limited to an allowlist (`NOT_ALLOWED`): these are the owner's settings. Tell the user; do not try another way round.
11. **`whatsops_feedback` becomes a public GitHub issue.** Never put phone numbers, names or message text in it.
12. Reply to the user in their language.

## 5. Recipes

| The user asks | Do |
|---|---|
| "What did Mario write to me today?" | `whatsapp_find_contact` `Mario` → `whatsapp_get_messages` with `chat` and `after` = today 00:00 (ISO) |
| "Who wrote to me?" / "what is unread?" | `whatsapp_list_chats` (has unread counts), then `whatsapp_get_messages` on the chats that matter |
| "Find the message about the invoice" | `whatsapp_search_messages` `query: "invoice"` (it also searches voice transcripts) |
| "Reply to her last message" | `whatsapp_get_messages` (oldest → newest: the last one is the newest) → confirm → `whatsapp_send_text` with `reply_to` = its id |
| "Send him the PDF" | confirm → `whatsapp_send_media` `type: "document"`, `url` or `base64`, `file_name` |
| "Send my position" | `whatsapp_send_location` `latitude`, `longitude`, optional `name`, `address` |
| "What did the voice note say?" | `whatsapp_transcribe_voice` `message_id` (+ `chat`) |
| "Who is in the group X?" | `whatsapp_get_group` `group: "X"` (or `whatsapp_list_groups` to find it) |
| "Which chats are labelled Follow up?" | `whatsapp_list_labels` `label: "Follow up"` (or `whatsapp_list_chats` `label`) |
| "Move this chat from Lead to New customer" | `whatsapp_label_chat` `remove: ["Lead"]`, `add: ["New customer"]` |
| "Post a status only for Anna and Luca" | confirm → `whatsapp_post_status` `audience: ["Anna", "Luca"]`, `type`, `text` or `url` |
| "Who saw my story?" / "who liked it?" | `whatsapp_status_views` (`people` = who saw and liked how many of its statuses; each status has `viewers`, `likedBy`, `replies` and `notViewed`) |
| "Make this chat's messages disappear after a week" | confirm → `whatsapp_set_disappearing` `chat`, `seconds: 604800` |
| "Is +39… on WhatsApp?" | `whatsapp_check_number` |

The Current RMS and Rentman tools work only after the owner connects that plugin in **Connectors → Plugins**. Before that they answer `Connect Current RMS first` / `Connect Rentman first`.

## 6. Tools at a glance

Scope `read` = reads only; `send` = changes WhatsApp or another system. The parameters of every tool are in [references/tools.md](references/tools.md).

<!-- tools:start (generated by `npm run skill`) -->
**Numbers and profile**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_accounts` | read | List the WhatsApp numbers (accounts) configured on this server with their connection state. |
| `whatsapp_get_profile` | read | Read the WhatsApp profile of one of the owner's numbers: name (the same name WhatsOps shows), info/about text and profile photo. |
| `whatsapp_update_profile` | send | Change the WhatsApp profile of one of the owner's numbers ON WHATSAPP ITSELF (all contacts see it): name (1–25 characters, also the name in WhatsOps), info/about text (max 139) and/or profile photo (an http(s) image URL or a data: URL / base64), or remove the photo. |

**Read chats and messages**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_list_chats` | read | List recent chats (most recent first) with the last message preview, unread count and labels. |
| `whatsapp_get_messages` | read | Get messages of one chat in chronological order (oldest → newest). |
| `whatsapp_search_messages` | read | Full-text search across stored WhatsApp messages (newest first), including what was said in transcribed voice messages. |
| `whatsapp_download_media` | read | Get the media of a message: returns a temporary download link (1 h) and, for small images, the image itself. |
| `whatsapp_transcribe_voice` | read | Transcribe a WhatsApp voice or audio message (type audioMessage) to text, so you know what was said. |

**Contacts and groups**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_find_contact` | read | Find contacts, chats and groups by name or (partial) phone number. |
| `whatsapp_check_number` | read | Check whether a phone number has WhatsApp. |
| `whatsapp_list_groups` | read | List the WhatsApp groups this number participates in. |
| `whatsapp_get_group` | read | Group metadata with participants (names, phone numbers, admins). |

**Send**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_send_text` | send | Send a WhatsApp text message as the owner. |
| `whatsapp_send_media` | send | Send an image, video, audio/voice note, document or sticker from a public URL or base64. |
| `whatsapp_send_location` | send | Send a location pin. |

**Statuses (stories)**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_post_status` | send | Post a WhatsApp status (story: text, image or video, gone after 24 hours) that ONLY the people in audience can see, whatever the status privacy set on the phone. |
| `whatsapp_status_views` | read | My WhatsApp statuses (stories) and who saw and liked them: for each status who opened it and when, who liked it (likedBy: the contact and the emoji), the replies it got (an emoji or a text sent from the status) and who of its audience did not open it yet; people = who saw and liked how many of the statuses listed (the whole story). |

**Act on messages and chats**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_react` | send | React to a message with an emoji (empty emoji removes the reaction). |
| `whatsapp_mark_read` | send | Mark a chat (or specific messages) as read — sends blue ticks. |
| `whatsapp_edit_message` | send | Edit the text of a message previously sent by this number. |
| `whatsapp_delete_message` | send | Delete (revoke) a message for everyone. |
| `whatsapp_set_disappearing` | send | Set the disappearing-messages duration for a chat (this posts a system notice in that chat) and/or the account default for new chats. |

**Labels (WhatsApp Business)**

| Tool | Scope | What it does |
|---|---|---|
| `whatsapp_list_labels` | read | WhatsApp labels of the number (WhatsApp Business labels such as New customer or Paid; on regular WhatsApp the chat lists) with how many chats and messages carry each. |
| `whatsapp_label_chat` | send | Put WhatsApp Business labels on a chat, or one of its messages, or take them off (labels by name or id, see whatsapp_list_labels). |

**Plugin: Current RMS**

| Tool | Scope | What it does |
|---|---|---|
| `currentrms_discussions` | read | List the discussions of Current RMS (OnRent Events) grouped by the record they belong to (opportunity, project, contact, invoice…), with whether each one is synced with a WhatsApp group. |
| `currentrms_set_sync` | send | Turn the WhatsApp sync of a Current RMS discussion on or off. |
| `currentrms_record_group` | send | Create the WhatsApp group of a Current RMS record (e.g. |
| `currentrms_users` | read | List the Current RMS users with their WhatsApp number (confirmed through their invite link, or from the contacts custom field), the records they own and their access to WhatsOps. |
| `currentrms_user_invite` | send | Create the personal link (valid 14 days) where a Current RMS user registers their WhatsApp number with a code sent on WhatsApp. |

**Plugin: Rentman**

| Tool | Scope | What it does |
|---|---|---|
| `rentman_projects` | read | List the current and upcoming Rentman projects (or the ones matching a search) with their WhatsApp groups: state, structure, crew planned and confirmed, crew without a phone number. |
| `rentman_project_group` | send | Create the WhatsApp groups of a Rentman project (structure from the plugin settings: one group, or a Community with a group per subproject or per department) with the crew that accepted the invitation, or stop managing them (the groups stay on WhatsApp). |

**WhatsOps itself**

| Tool | Scope | What it does |
|---|---|---|
| `whatsops_feedback` | read | Send feedback about WhatsOps itself (a bug, an idea, anything else) to its developers. |
<!-- tools:end -->

## 7. Errors you can meet

| Error | Meaning | Do |
|---|---|---|
| `NOT_CONNECTED` | The number is not linked right now | Tell the user: WhatsOps → Numbers, link the phone again |
| `ACCOUNT_NOT_FOUND`, `NO_ACCOUNT` | Wrong `account`, or no number yet | `whatsapp_accounts` |
| `CHAT_NOT_FOUND`, `AMBIGUOUS_CHAT` | No chat, or several chats, with that name | `whatsapp_find_contact`, then the phone number or JID |
| `NOT_ON_WHATSAPP` | That phone number has no WhatsApp | Tell the user |
| `FORBIDDEN` | The key or grant lacks a scope, or cannot use that number | The owner changes it in **Connectors** |
| `COLD_CONTACT`, `NOT_ALLOWED` | The owner's sending settings block this recipient | Tell the user |
| `NOT_OWN_MESSAGE` | Only the number's own messages can be edited or deleted for everyone | — |
| `LABELS_BUSINESS_ONLY` | Labels need a WhatsApp Business number | — |
| `STT_OFF`, `STT_LOCAL_MISSING` | Voice transcription is off or not installed | The owner: **Settings → Voice** |
| `MEDIA_TOO_LARGE`, `MEDIA_FETCH_FAILED` | The file is too big, or its URL could not be read | A smaller file, or `base64` |

## 8. Beyond MCP

- REST API with the same functions: `https://whatsops.example.com/docs`.
- Webhooks (**Connectors → Webhooks**) for automations: `message.received`, `message.sent`, `message.transcribed`, `message.update`, `chat.update`, `label.update`, `status.view`, `status.like`, `connection.update`, `history.sync`, `profile.update`. Each body has `context`, one line in plain words that an agent can read as it is.
- Live events as SSE: `GET /v1/events`.
