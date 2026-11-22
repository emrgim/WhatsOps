// Rebuild the Agent Skill in skills/ from the MCP server (run after `npm run build`):
//   skills/whatsops/SKILL.md (its tools table), skills/whatsops/references/tools.md, skills/whatsops.skill
// test/skill.test.ts fails when these are not up to date with the tools.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSkill } from '../dist/skill.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await writeSkill(root)
console.log('skill written: skills/whatsops/SKILL.md, skills/whatsops/references/tools.md, skills/whatsops.skill')
