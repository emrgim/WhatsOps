import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { VERSION } from '../config.js'
import { logger } from '../log.js'
import { accountFor, authenticate, requireScope, visibleAccounts, type App } from '../app.js'
import type { Principal } from '../security/auth.js'
import { publicOrigin } from '../security/auth.js'
import { localizeError, reqLang, tr, type Lang } from '../i18n.js'
import { AppError } from '../util.js'
import { LEVEL_TYPES } from '../plugins/currentrms.js'

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/** Build a per-request MCP server; titles, descriptions and errors follow `lang`. */
export function buildMcpServer(app: App, p: Principal, origin: string, lang: Lang): McpServer {
  const L = (s: string) => tr(lang, s)
  const server = new McpServer(
    {
      name: 'mcp-mrg-whatsops',
      title: 'WhatsOps',
      version: VERSION,
      description: L('Read and send WhatsApp messages from your own numbers (multi-account, Baileys).'),
      websiteUrl: origin,
      icons: [
        { src: `${origin}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
        { src: `${origin}/favicon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
      ],
    },
    { capabilities: { tools: {}, logging: {} }, instructions: L('@instructions') },
  )

  const account = z.string().optional().describe(L('WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts).'))
  const chatArg = z.string().describe(L('Chat: phone number, JID or exact chat name'))

  const tool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    scope: 'read' | 'send',
    shape: S,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean },
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown | ToolResult>,
  ) => {
    const t = L(title)
    server.registerTool(name, { title: t, description: L(description), inputSchema: shape, annotations: { title: t, ...annotations } }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        requireScope(p, scope)
        const r = await fn(args)
        if (r && typeof r === 'object' && 'content' in (r as object) && Array.isArray((r as ToolResult).content)) return r
        return ok(r)
      } catch (e) {
        const msg = e instanceof AppError ? `${e.code}: ${localizeError(e, lang)}` : `ERROR: ${String((e as Error)?.message ?? e)}`
        if (!(e instanceof AppError)) logger.warn({ tool: name, err: String((e as Error)?.stack ?? e) }, 'tool failed')
        return { isError: true, content: [{ type: 'text', text: msg }] }
      }
    }) as never)
  }

  const acc = (id?: string) => accountFor(app, p, id)

  tool('whatsapp_accounts', 'List WhatsApp numbers', 'List the WhatsApp numbers (accounts) configured on this server with their connection state.', 'read', {}, { readOnlyHint: true }, async () =>
    visibleAccounts(app, p).map((a) => {
      const s = a.status()
      return { id: s.id, name: s.name, phone: s.me?.phone ?? (s.phone ? '+' + s.phone : null), about: s.about, state: s.state, default: s.default }
    }),
  )

  tool(
    'whatsapp_get_profile',
    'Get a number\'s profile',
    'Read the WhatsApp profile of one of the owner\'s numbers: name (the same name WhatsOps shows), info/about text and profile photo.',
    'read',
    { account, include_photo: z.boolean().optional().describe(L('Also return the profile photo as an image (default false)')) },
    { readOnlyHint: true },
    async (a) => {
      const ac = acc(a.account)
      const p = await ac.profile()
      const photo = a.include_photo ? ac.photoData() : null
      if (!photo) return p
      return { content: [{ type: 'text', text: JSON.stringify(p, null, 2) }, { type: 'image', data: photo.data.toString('base64'), mimeType: photo.type }] }
    },
  )

  tool(
    'whatsapp_update_profile',
    'Edit a number\'s profile',
    'Change the WhatsApp profile of one of the owner\'s numbers ON WHATSAPP ITSELF (all contacts see it): name (1–25 characters, also the name in WhatsOps), info/about text (max 139) and/or profile photo (an http(s) image URL or a data: URL / base64), or remove the photo. Confirm the change with the user first.',
    'send',
    {
      account,
      name: z.string().min(1).max(25).optional().describe(L('New profile name')),
      about: z.string().max(139).optional().describe(L('New info/about text (empty string clears it)')),
      photo: z.string().optional().describe(L('New profile photo: http(s) image URL, data: URL or base64')),
      remove_photo: z.boolean().optional().describe(L('Remove the profile photo')),
    },
    { destructiveHint: false, idempotentHint: true },
    async (a) => {
      const ac = acc(a.account)
      let photo: Buffer | null | undefined
      if (a.remove_photo) photo = null
      else if (a.photo) photo = /^https?:\/\//i.test(a.photo) ? (await app.svc.fetchMedia(a.photo)).buf : Buffer.from(a.photo.replace(/^data:[^;]+;base64,/, ''), 'base64')
      if (a.name === undefined && a.about === undefined && photo === undefined) throw new AppError('PROFILE_EMPTY', 'Nothing to change: give a name, an info text or a photo', 400)
      return ac.editProfile({ name: a.name, about: a.about, photo })
    },
  )

  tool(
    'currentrms_discussions',
    'Current RMS discussions',
    'List the discussions of Current RMS (OnRent Events) grouped by the record they belong to (opportunity, project, contact, invoice…), with whether each one is synced with a WhatsApp group.',
    'read',
    { search: z.string().max(200).optional().describe(L('Filter by record name or discussion subject')) },
    { readOnlyHint: true },
    async (a) => {
      const pl = app.plugins.currentrms
      if (!pl.configured()) throw new AppError('CRMS_NOT_CONFIGURED', 'Connect Current RMS first (subdomain and API key)', 409)
      return pl.tree(a.search)
    },
  )

  tool(
    'currentrms_set_sync',
    'Sync a Current RMS discussion',
    'Turn the WhatsApp sync of a Current RMS discussion on or off. On: WhatsOps creates the WhatsApp group (or a group in the record\'s Community, per the plugin settings) and adds the participants that have a WhatsApp number; when the plugin mirrors messages for that kind of record, it also posts the whole discussion and then mirrors new messages both ways. Confirm with the user first.',
    'send',
    { discussion_id: z.string().describe(L('Discussion id (from currentrms_discussions)')), sync: z.boolean().describe(L('true = sync on, false = sync off')) },
    { openWorldHint: true },
    async (a) => app.plugins.currentrms.setSync(a.discussion_id, a.sync),
  )

  tool(
    'currentrms_record_group',
    'WhatsApp group of a Current RMS record',
    'Create the WhatsApp group of a Current RMS record (e.g. an opportunity or a product), or stop managing it (the group stays on WhatsApp). The plugin\'s main number creates it, inside the record\'s Community when the plugin uses Communities; the record\'s owner and the backup number become admins. New records get their group by themselves when the plugin settings say so. Confirm with the user first.',
    'send',
    {
      type: z.enum(LEVEL_TYPES).describe(L('Record type in Current RMS')),
      record_id: z.string().max(40).describe(L('Record id in Current RMS (from currentrms_discussions)')),
      group: z.boolean().describe(L('true = create the group, false = stop managing it')),
    },
    { openWorldHint: true },
    async (a) => app.plugins.currentrms.setObjectGroup(a.type, a.record_id, a.group),
  )

  tool(
    'currentrms_users',
    'Current RMS users',
    'List the Current RMS users with their WhatsApp number (confirmed through their invite link, or from the contacts custom field), the records they own and their access to WhatsOps.',
    'read',
    {},
    { readOnlyHint: true },
    async () => {
      const pl = app.plugins.currentrms
      if (!pl.configured()) throw new AppError('CRMS_NOT_CONFIGURED', 'Connect Current RMS first (subdomain and API key)', 409)
      return pl.users()
    },
  )

  tool(
    'currentrms_user_invite',
    'Invite a Current RMS user',
    'Create the personal link (valid 14 days) where a Current RMS user registers their WhatsApp number with a code sent on WhatsApp. They then become admin of the groups of the records they own. Give the link only to that user: a new link cancels the previous one.',
    'send',
    { user_id: z.string().describe(L('Current RMS user id (from currentrms_users)')) },
    { openWorldHint: false },
    async (a) => app.plugins.currentrms.invite(a.user_id, origin),
  )

  tool(
    'whatsops_feedback',
    'Send feedback about WhatsOps',
    'Send feedback about WhatsOps itself (a bug, an idea, anything else) to its developers. It opens a PUBLIC issue in the GitHub repository emrgim/WhatsOps, signed only with this installation code: never put phone numbers, names, message contents or keys in it. Show the text to the user and get their OK before sending.',
    'read',
    {
      kind: z.enum(['bug', 'idea', 'other']).describe(L('bug = something does not work, idea = a request or an improvement, other = anything else')),
      title: z.string().min(3).max(120).describe(L('Short title (3–120 characters)')),
      message: z.string().min(5).max(8000).describe(L('What happened or what you would like, in detail')),
      include_diagnostics: z.boolean().optional().describe(L('Attach technical info: WhatsOps version, operating system, database type, how many numbers are linked (no phone numbers, no messages). Default true.')),
    },
    { openWorldHint: true },
    async (a) => {
      const r = await app.reports.sendFeedback({ kind: a.kind, title: a.title, message: a.message, diagnostics: a.include_diagnostics ?? true }, 'mcp')
      return { issue: r.number, url: r.url, installation: app.reports.code }
    },
  )

  tool(
    'whatsapp_list_chats',
    'List chats',
    'List recent chats (most recent first) with the last message preview and unread count.',
    'read',
    {
      account,
      limit: z.number().int().min(1).max(200).optional().describe(L('Max chats (default 30)')),
      offset: z.number().int().min(0).optional().describe(L('Skip this many chats (paging)')),
      unread_only: z.boolean().optional().describe(L('Only chats with unread messages')),
      query: z.string().optional().describe(L('Filter by chat name')),
      type: z.enum(['all', 'groups', 'direct']).optional().describe(L('Chat type: all, groups or direct')),
    },
    { readOnlyHint: true },
    async (a) => app.svc.listChats(acc(a.account), { limit: a.limit, offset: a.offset, unreadOnly: a.unread_only, query: a.query, type: a.type }),
  )

  tool(
    'whatsapp_get_messages',
    'Read chat messages',
    'Get messages of one chat in chronological order (oldest → newest). Use before/after (ISO date) to page.',
    'read',
    {
      chat: z.string().describe(L('Phone number (+971…), JID or exact chat/contact name')),
      account,
      limit: z.number().int().min(1).max(500).optional().describe(L('Max messages (default 30)')),
      before: z.string().optional().describe(L('Only messages before this ISO timestamp')),
      after: z.string().optional().describe(L('Only messages after this ISO timestamp')),
    },
    { readOnlyHint: true },
    async (a) => app.svc.getMessages(acc(a.account), a.chat, { limit: a.limit, before: a.before, after: a.after }),
  )

  tool(
    'whatsapp_search_messages',
    'Search messages',
    'Full-text search across stored WhatsApp messages (newest first).',
    'read',
    {
      query: z.string().min(1).describe(L('Text to search for')),
      chat: z.string().optional().describe(L('Restrict to one chat (number, JID or name)')),
      since: z.string().optional().describe(L('ISO date lower bound')),
      limit: z.number().int().min(1).max(200).optional().describe(L('Max results (default 30)')),
      account,
    },
    { readOnlyHint: true },
    async (a) => app.svc.searchMessages(acc(a.account), a.query, { chat: a.chat, since: a.since, limit: a.limit }),
  )

  tool(
    'whatsapp_find_contact',
    'Find contact',
    'Find contacts, chats and groups by name or (partial) phone number. Returns JIDs and phone numbers to use with other tools.',
    'read',
    { query: z.string().min(1).describe(L('Name or phone number')), limit: z.number().int().min(1).max(100).optional().describe(L('Max results (default 20)')), account },
    { readOnlyHint: true },
    async (a) => app.svc.findContacts(acc(a.account), a.query, a.limit ?? 20),
  )

  tool(
    'whatsapp_check_number',
    'Check number on WhatsApp',
    'Check whether a phone number has WhatsApp.',
    'read',
    { phone: z.string().describe(L('Phone number in international format')), account },
    { readOnlyHint: true, openWorldHint: true },
    async (a) => acc(a.account).checkNumber(a.phone),
  )

  tool(
    'whatsapp_list_groups',
    'List groups',
    'List the WhatsApp groups this number participates in.',
    'read',
    { query: z.string().optional().describe(L('Filter by group name')), refresh: z.boolean().optional().describe(L('Re-fetch from WhatsApp first')), account },
    { readOnlyHint: true },
    async (a) => app.svc.listGroups(acc(a.account), { query: a.query, refresh: a.refresh }),
  )

  tool(
    'whatsapp_get_group',
    'Group details',
    'Group metadata with participants (names, phone numbers, admins).',
    'read',
    { group: z.string().describe(L('Group JID (…@g.us) or exact group name')), account },
    { readOnlyHint: true },
    async (a) => app.svc.getGroup(acc(a.account), a.group),
  )

  tool(
    'whatsapp_send_text',
    'Send text message',
    'Send a WhatsApp text message as the owner. Confirm recipient and text with the user first.',
    'send',
    {
      to: z.string().describe(L('Phone number (+971…), JID, group JID or exact chat name')),
      text: z.string().min(1).max(65000).describe(L('Message text')),
      reply_to: z.string().optional().describe(L('Message id to quote')),
      mentions: z.array(z.string()).optional().describe(L('Phone numbers/JIDs to @mention (groups)')),
      idempotency_key: z.string().optional().describe(L('Same key = sent at most once')),
      account,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) => app.svc.sendText(acc(a.account), { to: a.to, text: a.text, replyTo: a.reply_to, mentions: a.mentions, idempotencyKey: a.idempotency_key }),
  )

  tool(
    'whatsapp_send_media',
    'Send media',
    'Send an image, video, audio/voice note, document or sticker from a public URL or base64.',
    'send',
    {
      to: z.string().describe(L('Recipient: phone number, JID or exact chat name')),
      type: z.enum(['image', 'video', 'audio', 'document', 'sticker']).describe(L('Media type')),
      url: z.string().optional().describe(L('http(s) URL of the file')),
      base64: z.string().optional().describe(L('File content as base64 (or data: URL)')),
      mimetype: z.string().optional().describe(L('MIME type, e.g. image/jpeg')),
      file_name: z.string().optional().describe(L('File name (documents)')),
      caption: z.string().optional().describe(L('Caption')),
      ptt: z.boolean().optional().describe(L('Send audio as a voice note')),
      reply_to: z.string().optional().describe(L('Message id to quote')),
      idempotency_key: z.string().optional().describe(L('Same key = sent at most once')),
      account,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) =>
      app.svc.sendMedia(acc(a.account), {
        to: a.to,
        type: a.type,
        url: a.url,
        base64: a.base64,
        mimetype: a.mimetype,
        fileName: a.file_name,
        caption: a.caption,
        ptt: a.ptt,
        replyTo: a.reply_to,
        idempotencyKey: a.idempotency_key,
      }),
  )

  tool(
    'whatsapp_send_location',
    'Send location',
    'Send a location pin.',
    'send',
    {
      to: z.string().describe(L('Recipient: phone number, JID or exact chat name')),
      latitude: z.number().describe(L('Latitude')),
      longitude: z.number().describe(L('Longitude')),
      name: z.string().optional().describe(L('Place name')),
      address: z.string().optional().describe(L('Address')),
      account,
    },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.sendLocation(acc(a.account), a),
  )

  tool(
    'whatsapp_react',
    'React to message',
    'React to a message with an emoji (empty emoji removes the reaction).',
    'send',
    { chat: chatArg, message_id: z.string().describe(L('Message id')), emoji: z.string().describe(L('e.g. 👍 — empty string removes')), account },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.react(acc(a.account), { chat: a.chat, messageId: a.message_id, emoji: a.emoji }),
  )

  tool(
    'whatsapp_mark_read',
    'Mark as read',
    'Mark a chat (or specific messages) as read — sends blue ticks.',
    'send',
    { chat: chatArg, message_ids: z.array(z.string()).optional().describe(L('Message ids (default: latest received)')), account },
    { readOnlyHint: false, idempotentHint: true },
    async (a) => app.svc.markRead(acc(a.account), { chat: a.chat, messageIds: a.message_ids }),
  )

  tool(
    'whatsapp_edit_message',
    'Edit message',
    'Edit the text of a message previously sent by this number.',
    'send',
    { chat: chatArg, message_id: z.string().describe(L('Message id')), text: z.string().min(1).describe(L('New text')), account },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.editMessage(acc(a.account), { chat: a.chat, messageId: a.message_id, text: a.text }),
  )

  tool(
    'whatsapp_delete_message',
    'Delete message for everyone',
    'Delete (revoke) a message for everyone.',
    'send',
    { chat: chatArg, message_id: z.string().describe(L('Message id')), account },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (a) => app.svc.deleteMessage(acc(a.account), { chat: a.chat, messageId: a.message_id }),
  )

  tool(
    'whatsapp_download_media',
    'Download media',
    'Get the media of a message: returns a temporary download link (1 h) and, for small images, the image itself.',
    'read',
    { message_id: z.string().describe(L('Message id')), chat: z.string().optional().describe(L('Chat: phone number, JID or exact chat name')), account },
    { readOnlyHint: true },
    async (a) => {
      const ac = acc(a.account)
      const m = await app.svc.downloadMedia(ac, a.chat, a.message_id)
      const row = a.chat ? await ac.store.loadRow(await app.svc.resolveChat(ac, a.chat), a.message_id) : await ac.store.loadById(a.message_id)
      const link = `${origin}/media/${app.svc.signMediaToken(ac.id, row?.chat_jid ?? '', a.message_id)}`
      const info = { fileName: m.fileName, mimetype: m.mimetype, bytes: m.buf.length, url: link, expiresIn: '1h' }
      const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(info, null, 2) }]
      if (m.mimetype.startsWith('image/') && m.buf.length < 1_500_000) content.push({ type: 'image', data: m.buf.toString('base64'), mimeType: m.mimetype })
      return { content }
    },
  )

  return server
}

/** Stateless Streamable HTTP endpoint (POST /mcp and POST /). */
export async function handleMcpRequest(app: App, req: FastifyRequest, reply: FastifyReply, path: string): Promise<unknown> {
  const lang = reqLang(req)
  const p = await authenticate(app, req, false)
  if (!p) {
    return reply
      .code(401)
      .header('www-authenticate', app.oauth.wwwAuthenticate(req, path))
      .header('access-control-expose-headers', 'WWW-Authenticate')
      .header('cache-control', 'no-store')
      .send({ jsonrpc: '2.0', error: { code: -32001, message: tr(lang, 'Unauthorized: sign in with OAuth or send Authorization: Bearer <API key>') }, id: null })
  }
  if (req.method !== 'POST') {
    return reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: tr(lang, 'Method not allowed (stateless server: use POST)') }, id: null })
  }
  const origin = publicOrigin(req, app.settings.get().publicUrl)
  const server = buildMcpServer(app, p, origin, lang)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k === 'content-length' || k === 'transfer-encoding') continue
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
    }
    // be lenient with clients that send only one of the two required Accept types
    headers.set('accept', 'application/json, text/event-stream')
    headers.set('content-type', 'application/json')
    const request = new Request(`${origin}${req.url}`, { method: 'POST', headers, body: JSON.stringify(req.body ?? {}) })
    const res = await transport.handleRequest(request, { parsedBody: req.body })
    reply.code(res.status)
    res.headers.forEach((v, k) => {
      if (k !== 'content-length') reply.header(k, v)
    })
    return reply.send(await res.text())
  } finally {
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  }
}
