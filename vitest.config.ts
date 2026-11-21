import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
// tests never touch a real installation's data (log file, database); no 45 s pause between test groups
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', env: { WA_DATA_DIR: path.join(os.tmpdir(), 'whatsops-test'), WA_GROUP_GAP_MS: '0' } } })
