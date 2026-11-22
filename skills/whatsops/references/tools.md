# WhatsOps MCP tools (reference)

<!-- Generated from the MCP server by `npm run skill`: do not edit by hand. -->

32 tools. Scope = what the credential (API key or OAuth grant) needs: `read` or `send` (`admin` includes both). The WhatsApp tools take `account` (phone number or id of one of the owner's numbers; the default number when omitted).

## What the server tells every agent on connect

> WhatsApp (Baileys linked device) for the owner's own WhatsApp numbers.
> - Recipients/chats accept a phone number in international format (+971501234567), a JID (…@s.whatsapp.net, …@g.us, …@lid) or an exact chat/contact name.
> - Resolve people with whatsapp_find_contact before sending when you only have a name.
> - Messages are sent as the owner: confirm wording and recipient with the user before calling a send tool unless they explicitly asked you to send.
> - Use whatsapp_accounts to see which numbers are connected; pass "account" to pick a non-default number.
> - Voice messages (type audioMessage): read their transcript, or call whatsapp_transcribe_voice to know what was said.
> - Every tool explained, with examples (Agent Skill): https://raw.githubusercontent.com/emrgim/WhatsOps/main/skills/whatsops/SKILL.md
> - Reply to the user in their language.

## Numbers and profile

### `whatsapp_accounts` — List WhatsApp numbers

Scope `read` · reads only

List the WhatsApp numbers (accounts) configured on this server with their connection state.

No parameters.

### `whatsapp_get_profile` — Get a number's profile

Scope `read` · reads only

Read the WhatsApp profile of one of the owner's numbers: name (the same name WhatsOps shows), info/about text and profile photo.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |
| `include_photo` | boolean | no | Also return the profile photo as an image (default false) |

### `whatsapp_update_profile` — Edit a number's profile

Scope `send` · changes WhatsApp

Change the WhatsApp profile of one of the owner's numbers ON WHATSAPP ITSELF (all contacts see it): name (1–25 characters, also the name in WhatsOps), info/about text (max 139) and/or profile photo (an http(s) image URL or a data: URL / base64), or remove the photo. Confirm the change with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |
| `name` | string (1–25 chars) | no | New profile name |
| `about` | string (max 139 chars) | no | New info/about text (empty string clears it) |
| `photo` | string | no | New profile photo: http(s) image URL, data: URL or base64 |
| `remove_photo` | boolean | no | Remove the profile photo |

## Read chats and messages

### `whatsapp_list_chats` — List chats

Scope `read` · reads only

List recent chats (most recent first) with the last message preview, unread count and labels.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |
| `limit` | integer 1–200 | no | Max chats (default 30) |
| `offset` | integer ≥ 0 | no | Skip this many chats (paging) |
| `unread_only` | boolean | no | Only chats with unread messages |
| `query` | string | no | Filter by chat name |
| `type` | "all" \| "groups" \| "direct" | no | Chat type: all, groups or direct |
| `label` | string | no | Only chats with this label (name or id, see whatsapp_list_labels) |

### `whatsapp_get_messages` — Read chat messages

Scope `read` · reads only

Get messages of one chat in chronological order (oldest → newest). Use before/after (ISO date) to page. Voice messages (type audioMessage, with seconds) carry their transcript when it is ready; when transcript is null, call whatsapp_transcribe_voice to get what was said.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Phone number (+971…), JID or exact chat/contact name |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |
| `limit` | integer 1–500 | no | Max messages (default 30) |
| `before` | string | no | Only messages before this ISO timestamp |
| `after` | string | no | Only messages after this ISO timestamp |

### `whatsapp_search_messages` — Search messages

Scope `read` · reads only

Full-text search across stored WhatsApp messages (newest first), including what was said in transcribed voice messages.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `query` | string (not empty) | yes | Text to search for |
| `chat` | string | no | Restrict to one chat (number, JID or name) |
| `since` | string | no | ISO date lower bound |
| `limit` | integer 1–200 | no | Max results (default 30) |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_download_media` — Download media

Scope `read` · reads only

Get the media of a message: returns a temporary download link (1 h) and, for small images, the image itself. For a voice or audio message it also returns what was said (transcript) and, with include_audio, the audio itself.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `message_id` | string | yes | Message id |
| `chat` | string | no | Chat: phone number, JID or exact chat name |
| `include_audio` | boolean | no | For voice / audio messages: also return the audio itself (only for clients that can play or process audio; default false) |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_transcribe_voice` — Listen to a voice message

Scope `read` · reads only

Transcribe a WhatsApp voice or audio message (type audioMessage) to text, so you know what was said. Returns the transcript, the language and the length in seconds. Transcripts are kept: asking again is instant. Use force to transcribe again.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `message_id` | string | yes | Message id |
| `chat` | string | no | Chat: phone number, JID or exact chat name |
| `force` | boolean | no | Transcribe again even if a transcript is already stored |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

## Contacts and groups

### `whatsapp_find_contact` — Find contact

Scope `read` · reads only

Find contacts, chats and groups by name or (partial) phone number. Returns JIDs and phone numbers to use with other tools.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `query` | string (not empty) | yes | Name or phone number |
| `limit` | integer 1–100 | no | Max results (default 20) |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_check_number` — Check number on WhatsApp

Scope `read` · reads only

Check whether a phone number has WhatsApp.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `phone` | string | yes | Phone number in international format |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_list_groups` — List groups

Scope `read` · reads only

List the WhatsApp groups this number participates in.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `query` | string | no | Filter by group name |
| `refresh` | boolean | no | Re-fetch from WhatsApp first |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_get_group` — Group details

Scope `read` · reads only

Group metadata with participants (names, phone numbers, admins).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `group` | string | yes | Group JID (…@g.us) or exact group name |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

## Send

### `whatsapp_send_text` — Send text message

Scope `send` · changes WhatsApp

Send a WhatsApp text message as the owner. Confirm recipient and text with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Phone number (+971…), JID, group JID or exact chat name |
| `text` | string (1–65000 chars) | yes | Message text |
| `reply_to` | string | no | Message id to quote |
| `mentions` | string[] | no | Phone numbers/JIDs to @mention (groups) |
| `idempotency_key` | string | no | Same key = sent at most once |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_send_media` — Send media

Scope `send` · changes WhatsApp

Send an image, video, audio/voice note, document or sticker from a public URL or base64.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Recipient: phone number, JID or exact chat name |
| `type` | "image" \| "video" \| "audio" \| "document" \| "sticker" | yes | Media type |
| `url` | string | no | http(s) URL of the file |
| `base64` | string | no | File content as base64 (or data: URL) |
| `mimetype` | string | no | MIME type, e.g. image/jpeg |
| `file_name` | string | no | File name (documents) |
| `caption` | string | no | Caption |
| `ptt` | boolean | no | Send audio as a voice note |
| `reply_to` | string | no | Message id to quote |
| `idempotency_key` | string | no | Same key = sent at most once |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_send_location` — Send location

Scope `send` · changes WhatsApp

Send a location pin.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Recipient: phone number, JID or exact chat name |
| `latitude` | number | yes | Latitude |
| `longitude` | number | yes | Longitude |
| `name` | string | no | Place name |
| `address` | string | no | Address |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

## Statuses (stories)

### `whatsapp_post_status` — Post status

Scope `send` · changes WhatsApp

Post a WhatsApp status (story: text, image or video, gone after 24 hours) that ONLY the people in audience can see, whatever the status privacy set on the phone. Image/video from a public URL or base64.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `audience` | string[] (at least 1) | yes | Who may see it: phone numbers, JIDs or exact contact names |
| `type` | "text" \| "image" \| "video" | yes | Status type |
| `text` | string | no | Text of a text status |
| `url` | string | no | http(s) URL of the file |
| `base64` | string | no | File content as base64 (or data: URL) |
| `mimetype` | string | no | MIME type, e.g. image/jpeg |
| `caption` | string | no | Caption |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_status_views` — Who saw and liked my statuses

Scope `read` · reads only

My WhatsApp statuses (stories) and who saw and liked them: for each status who opened it and when, who liked it (likedBy: the contact and the emoji), the replies it got (an emoji or a text sent from the status) and who of its audience did not open it yet; people = who saw and liked how many of the statuses listed (the whole story). Default: the statuses still visible (last 24 hours). Views and likes are known for statuses posted since WhatsOps keeps them; the phone shows them too.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `status_id` | string | no | One status only (id from whatsapp_post_status or from this list) |
| `since` | string | no | Statuses posted since this ISO date (default: the last 24 hours) |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

## Act on messages and chats

### `whatsapp_react` — React to message

Scope `send` · changes WhatsApp

React to a message with an emoji (empty emoji removes the reaction).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: phone number, JID or exact chat name |
| `message_id` | string | yes | Message id |
| `emoji` | string | yes | e.g. 👍 — empty string removes |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_mark_read` — Mark as read

Scope `send` · changes WhatsApp

Mark a chat (or specific messages) as read — sends blue ticks.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: phone number, JID or exact chat name |
| `message_ids` | string[] | no | Message ids (default: latest received) |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_edit_message` — Edit message

Scope `send` · changes WhatsApp

Edit the text of a message previously sent by this number.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: phone number, JID or exact chat name |
| `message_id` | string | yes | Message id |
| `text` | string (not empty) | yes | New text |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_delete_message` — Delete message for everyone

Scope `send` · changes WhatsApp, cannot be undone

Delete (revoke) a message for everyone.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: phone number, JID or exact chat name |
| `message_id` | string | yes | Message id |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

### `whatsapp_set_disappearing` — Set disappearing messages

Scope `send` · changes WhatsApp

Set the disappearing-messages duration for a chat (this posts a system notice in that chat) and/or the account default for new chats. 0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days. Confirm with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | no | Chat: phone number, JID or exact chat name |
| `seconds` | integer ≥ 0 | yes | Duration in seconds: 0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days |
| `account_default` | boolean | no | If true, set the account default for new chats (can be combined with chat) |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

## Labels (WhatsApp Business)

### `whatsapp_list_labels` — List labels

Scope `read` · reads only

WhatsApp labels of the number (WhatsApp Business labels such as New customer or Paid; on regular WhatsApp the chat lists) with how many chats and messages carry each. With label (name or id): the chats and the messages that carry it.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |
| `label` | string | no | A label (name or id): its chats and messages |

### `whatsapp_label_chat` — Label a chat

Scope `send` · changes WhatsApp

Put WhatsApp Business labels on a chat, or one of its messages, or take them off (labels by name or id, see whatsapp_list_labels). To change a label, remove the old one and add the new one in the same call. The phone and WhatsApp Web show the change too.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Phone number (+971…), JID or exact chat/contact name |
| `add` | string[] | no | Labels to put on (name or id) |
| `remove` | string[] | no | Labels to take off (name or id) |
| `message_id` | string | no | A message of the chat to label instead of the whole chat |
| `account` | string | no | WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts). |

## Plugin: Current RMS

### `currentrms_discussions` — Current RMS discussions

Scope `read` · reads only

List the discussions of Current RMS (OnRent Events) grouped by the record they belong to (opportunity, project, contact, invoice…), with whether each one is synced with a WhatsApp group.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `search` | string (max 200 chars) | no | Filter by record name or discussion subject |

### `currentrms_set_sync` — Sync a Current RMS discussion

Scope `send` · changes WhatsApp

Turn the WhatsApp sync of a Current RMS discussion on or off. On: WhatsOps creates the WhatsApp group (or a group in the record's Community, per the plugin settings) and adds the participants that have a WhatsApp number; when the plugin mirrors messages for that kind of record, it also posts the whole discussion and then mirrors new messages both ways. Confirm with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `discussion_id` | string | yes | Discussion id (from currentrms_discussions) |
| `sync` | boolean | yes | true = sync on, false = sync off |

### `currentrms_record_group` — WhatsApp group of a Current RMS record

Scope `send` · changes WhatsApp

Create the WhatsApp group of a Current RMS record (e.g. an opportunity or a product), or stop managing it (the group stays on WhatsApp). The plugin's main number creates it, inside the record's Community when the plugin uses Communities; the record's owner and the backup number become admins. New records get their group by themselves when the plugin settings say so. Confirm with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `type` | "Opportunity" \| "Project" \| "Product" \| "Service" \| "Member" \| "Invoice" \| "Activity" \| "Quarantine" \| "PurchaseOrder" | yes | Record type in Current RMS |
| `record_id` | string (max 40 chars) | yes | Record id in Current RMS (from currentrms_discussions) |
| `group` | boolean | yes | true = create the group, false = stop managing it |

### `currentrms_users` — Current RMS users

Scope `read` · reads only

List the Current RMS users with their WhatsApp number (confirmed through their invite link, or from the contacts custom field), the records they own and their access to WhatsOps.

No parameters.

### `currentrms_user_invite` — Invite a Current RMS user

Scope `send` · changes WhatsApp

Create the personal link (valid 14 days) where a Current RMS user registers their WhatsApp number with a code sent on WhatsApp. They then become admin of the groups of the records they own. Give the link only to that user: a new link cancels the previous one.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `user_id` | string | yes | Current RMS user id (from currentrms_users) |

## Plugin: Rentman

### `rentman_projects` — Rentman projects

Scope `read` · reads only

List the current and upcoming Rentman projects (or the ones matching a search) with their WhatsApp groups: state, structure, crew planned and confirmed, crew without a phone number.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `search` | string (max 200 chars) | no | Filter by project name, number or id |

### `rentman_project_group` — WhatsApp groups of a Rentman project

Scope `send` · changes WhatsApp

Create the WhatsApp groups of a Rentman project (structure from the plugin settings: one group, or a Community with a group per subproject or per department) with the crew that accepted the invitation, or stop managing them (the groups stay on WhatsApp). WhatsOps then keeps the crew in line with the planning and posts the project card and its updates. Confirm with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `project_id` | string (max 20 chars) | yes | Rentman project id (from rentman_projects) |
| `group` | boolean | yes | true = create the groups, false = stop managing them |

## WhatsOps itself

### `whatsops_feedback` — Send feedback about WhatsOps

Scope `read` · changes WhatsApp

Send feedback about WhatsOps itself (a bug, an idea, anything else) to its developers. It opens a PUBLIC issue in the GitHub repository emrgim/WhatsOps, signed only with this installation code: never put phone numbers, names, message contents or keys in it. Show the text to the user and get their OK before sending.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `kind` | "bug" \| "idea" \| "other" | yes | bug = something does not work, idea = a request or an improvement, other = anything else |
| `title` | string (3–120 chars) | yes | Short title (3–120 characters) |
| `message` | string (5–8000 chars) | yes | What happened or what you would like, in detail |
| `include_diagnostics` | boolean | no | Attach technical info: WhatsOps version, operating system, database type, how many numbers are linked (no phone numbers, no messages). Default true. |
