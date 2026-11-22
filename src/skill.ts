/**
 * The Agent Skill shipped in the repository (skills/whatsops): a guide for any agent that connects to
 * WhatsOps over MCP. The tool reference is generated from the MCP server itself, so it always says
 * what the server really offers:
 *   skills/whatsops/SKILL.md            hand-written guide; the "tools at a glance" table is generated
 *   skills/whatsops/references/tools.md every tool with its parameters (generated)
 *   skills/whatsops.skill               the folder as a ZIP, for apps that upload skills
 * Rebuild after changing a tool: `npm run build && npm run skill` (test/skill.test.ts fails otherwise).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { App } from './app.js'
import { buildMcpServer, TOOL_SCOPES } from './mcp/server.js'

export const SKILL_NAME = 'whatsops'
export const REPO_URL = 'https://github.com/emrgim/WhatsOps'
export const SKILL_URL = `${REPO_URL}/tree/main/skills/${SKILL_NAME}`
export const SKILL_FILE_URL = `${REPO_URL}/raw/main/skills/${SKILL_NAME}.skill`

/** Where every tool goes in the guide; a new tool must be placed here (the skill test fails otherwise). */
export const TOOL_SECTIONS: [string, string[]][] = [
  ['Numbers and profile', ['whatsapp_accounts', 'whatsapp_get_profile', 'whatsapp_update_profile']],
  ['Read chats and messages', ['whatsapp_list_chats', 'whatsapp_get_messages', 'whatsapp_search_messages', 'whatsapp_download_media', 'whatsapp_transcribe_voice']],
  ['Contacts and groups', ['whatsapp_find_contact', 'whatsapp_check_number', 'whatsapp_list_groups', 'whatsapp_get_group']],
  ['Send', ['whatsapp_send_text', 'whatsapp_send_media', 'whatsapp_send_location']],
  ['Statuses (stories)', ['whatsapp_post_status', 'whatsapp_status_views']],
  ['Act on messages and chats', ['whatsapp_react', 'whatsapp_mark_read', 'whatsapp_edit_message', 'whatsapp_delete_message', 'whatsapp_set_disappearing']],
  ['Labels (WhatsApp Business)', ['whatsapp_list_labels', 'whatsapp_label_chat']],
  ['Plugin: Current RMS', ['currentrms_discussions', 'currentrms_set_sync', 'currentrms_record_group', 'currentrms_users', 'currentrms_user_invite']],
  ['Plugin: Rentman', ['rentman_projects', 'rentman_project_group']],
  ['WhatsOps itself', ['whatsops_feedback']],
]

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; anyOf?: Schema[]; const?: unknown; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; description?: string; properties?: Record<string, Schema>; required?: string[] }
export type ToolInfo = { name: string; title?: string; description?: string; inputSchema: Schema; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; scope: string }

/** The tools exactly as an agent sees them on connect (English), plus the scope each one needs. */
export async function listServerTools(): Promise<{ tools: ToolInfo[]; instructions: string }> {
  const server = buildMcpServer({} as App, { kind: 'key', id: 'skill', label: 'skill', scopes: new Set(['read', 'send', 'admin']) } as never, 'https://whatsops.example.com', 'en')
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'skill-builder', version: '1' })
  await client.connect(b)
  const { tools } = await client.listTools()
  const instructions = client.getInstructions() ?? ''
  await client.close()
  return { tools: tools.map((t) => ({ ...(t as unknown as ToolInfo), scope: TOOL_SCOPES.get(t.name) ?? 'read' })), instructions }
}

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
const firstSentence = (s = '') => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim()

function typeOf(s: Schema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (s.anyOf) return s.anyOf.map((x) => (x.const !== undefined ? JSON.stringify(x.const) : typeOf(x))).join(' | ')
  if (s.type === 'array') return `${s.items ? typeOf(s.items) : 'any'}[]${s.minItems ? ` (at least ${s.minItems})` : ''}`
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type ?? 'any'
  const max = s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER ? s.maximum : undefined
  const range = max !== undefined ? ` ${s.minimum ?? ''}–${max}` : s.minimum !== undefined ? ` ≥ ${s.minimum}` : ''
  const len = s.maxLength !== undefined ? ` (${s.minLength ? `${s.minLength}–` : 'max '}${s.maxLength} chars)` : s.minLength ? ' (not empty)' : ''
  return `${t}${range}${len}`
}

const effect = (t: ToolInfo) => (t.annotations?.readOnlyHint ? 'reads only' : t.annotations?.destructiveHint ? 'changes WhatsApp, cannot be undone' : 'changes WhatsApp')

/** "Tools at a glance": one line per tool, by section. */
export function toolsTable(tools: ToolInfo[]): string {
  const by = new Map(tools.map((t) => [t.name, t]))
  const out: string[] = []
  for (const [section, names] of TOOL_SECTIONS) {
    out.push(`**${section}**`, '', '| Tool | Scope | What it does |', '|---|---|---|')
    for (const n of names) {
      const t = by.get(n)
      if (t) out.push(`| \`${n}\` | ${t.scope} | ${cell(firstSentence(t.description))} |`)
    }
    out.push('')
  }
  return out.join('\n').trim()
}

/** references/tools.md: every tool, what it does and every parameter. */
export function toolsReference(tools: ToolInfo[], instructions: string): string {
  const by = new Map(tools.map((t) => [t.name, t]))
  const out = [
    '# WhatsOps MCP tools (reference)',
    '',
    '<!-- Generated from the MCP server by `npm run skill`: do not edit by hand. -->',
    '',
    `${tools.length} tools. Scope = what the credential (API key or OAuth grant) needs: \`read\` or \`send\` (\`admin\` includes both). The WhatsApp tools take \`account\` (phone number or id of one of the owner's numbers; the default number when omitted).`,
    '',
    '## What the server tells every agent on connect',
    '',
    ...instructions.split('\n').map((l) => `> ${l}`),
    '',
  ]
  for (const [section, names] of TOOL_SECTIONS) {
    out.push(`## ${section}`, '')
    for (const n of names) {
      const t = by.get(n)
      if (!t) continue
      out.push(`### \`${n}\` — ${t.title ?? n}`, '', `Scope \`${t.scope}\` · ${effect(t)}`, '', (t.description ?? '').trim(), '')
      const props = Object.entries(t.inputSchema.properties ?? {})
      if (!props.length) {
        out.push('No parameters.', '')
        continue
      }
      const req = new Set(t.inputSchema.required ?? [])
      out.push('| Parameter | Type | Required | Meaning |', '|---|---|---|---|')
      for (const [p, s] of props) out.push(`| \`${p}\` | ${cell(typeOf(s))} | ${req.has(p) ? 'yes' : 'no'} | ${cell(s.description)} |`)
      out.push('')
    }
  }
  return out.join('\n').trimEnd() + '\n'
}

const START = '<!-- tools:start (generated by `npm run skill`) -->'
const END = '<!-- tools:end -->'

/** SKILL.md with the generated table between its markers. */
export function withToolsTable(skillMd: string, table: string): string {
  const i = skillMd.indexOf(START)
  const j = skillMd.indexOf(END)
  if (i < 0 || j < i) throw new Error(`SKILL.md must contain ${START} … ${END}`)
  return `${skillMd.slice(0, i + START.length)}\n${table}\n${skillMd.slice(j)}`
}

/** A ZIP of the files, stored without compression and with a fixed date: the same files give the same bytes. */
export function zipFiles(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const crc = zlib.crc32(f.data) >>> 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // UTF-8 names
    lh.writeUInt16LE(0, 8) // stored
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(f.data.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, f.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(0x031e, 4) // made by: Unix
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(f.data.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38) // -rw-r--r--
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + f.data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

/** What the skill files must contain now, from the hand-written SKILL.md in `root` (the repository). */
export async function buildSkill(root: string): Promise<{ skillMd: string; tools: string; zip: Buffer; names: string[] }> {
  const { tools, instructions } = await listServerTools()
  const dir = path.join(root, 'skills', SKILL_NAME)
  const skillMd = withToolsTable(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), toolsTable(tools))
  const ref = toolsReference(tools, instructions)
  const zip = zipFiles([
    { name: `${SKILL_NAME}/SKILL.md`, data: Buffer.from(skillMd, 'utf8') },
    { name: `${SKILL_NAME}/references/tools.md`, data: Buffer.from(ref, 'utf8') },
  ])
  return { skillMd, tools: ref, zip, names: tools.map((t) => t.name) }
}

/** Write the skill files into the repository. */
export async function writeSkill(root: string): Promise<void> {
  const s = await buildSkill(root)
  const dir = path.join(root, 'skills', SKILL_NAME)
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), s.skillMd)
  fs.writeFileSync(path.join(dir, 'references', 'tools.md'), s.tools)
  fs.writeFileSync(path.join(root, 'skills', `${SKILL_NAME}.skill`), s.zip)
}
