import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkill, listServerTools, REPO_URL, SKILL_NAME, TOOL_SECTIONS, zipFiles } from '../src/skill.js'

const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, 'skills', SKILL_NAME)

/** Read the entries of a stored (uncompressed) ZIP through its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const n = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    const size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extra = buf.readUInt16LE(at + 30)
    const comment = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const lName = buf.readUInt16LE(local + 26)
    const lExtra = buf.readUInt16LE(local + 28)
    out.set(name, buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + size))
    at += 46 + nameLen + extra + comment
  }
  return out
}

describe('agent skill', () => {
  it('places every MCP tool in a section of the guide, and nothing else', async () => {
    const { tools } = await listServerTools()
    const listed = TOOL_SECTIONS.flatMap(([, names]) => names)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(tools.map((t) => t.name).sort())
  })

  it('is up to date with the tools (run `npm run build && npm run skill`)', async () => {
    const s = await buildSkill(root)
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(s.skillMd)
    expect(fs.readFileSync(path.join(dir, 'references', 'tools.md'), 'utf8')).toBe(s.tools)
    expect(fs.readFileSync(path.join(root, 'skills', `${SKILL_NAME}.skill`)).equals(s.zip)).toBe(true)
  })

  it('has the frontmatter agents need and points at the repository', () => {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    const fm = md.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
    expect(fm).toMatch(/^name: whatsops$/m)
    const description = fm.match(/^description: (.+)$/m)?.[1] ?? ''
    expect(description.length).toBeGreaterThan(50)
    expect(description.length).toBeLessThanOrEqual(1024)
    expect(description).not.toMatch(/[<>]/)
    expect(md).toContain(`${REPO_URL}/raw/main/skills/whatsops.skill`)
    expect(md).toContain(`${REPO_URL}/tree/main/skills/whatsops`)
  })

  it('explains every tool with all its parameters in references/tools.md', async () => {
    const { tools } = await listServerTools()
    const ref = fs.readFileSync(path.join(dir, 'references', 'tools.md'), 'utf8')
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    for (const t of tools) {
      expect(ref).toContain(`### \`${t.name}\``)
      expect(md).toContain(`| \`${t.name}\` |`)
      for (const p of Object.keys(t.inputSchema.properties ?? {})) expect(ref, `${t.name}.${p}`).toContain(`| \`${p}\` |`)
    }
    expect(ref).toContain('| `remove` | string[] | no | Labels to take off (name or id) |')
  })

  it('ships the .skill file as a ZIP with the skill folder inside', () => {
    const entries = unzip(fs.readFileSync(path.join(root, 'skills', `${SKILL_NAME}.skill`)))
    expect([...entries.keys()]).toEqual(['whatsops/SKILL.md', 'whatsops/references/tools.md'])
    expect(entries.get('whatsops/SKILL.md')!.toString('utf8')).toBe(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))
  })

  it('writes the same ZIP bytes for the same files', () => {
    const f = [{ name: 'a/b.txt', data: Buffer.from('ciao') }]
    expect(zipFiles(f).equals(zipFiles(f))).toBe(true)
    expect(unzip(zipFiles(f)).get('a/b.txt')!.toString()).toBe('ciao')
  })
})
