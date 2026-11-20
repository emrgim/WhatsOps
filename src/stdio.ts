#!/usr/bin/env node
/**
 * stdio ⇄ Streamable HTTP proxy, for MCP clients that only speak stdio.
 * Env: WA_MCP_URL (default http://127.0.0.1:8810/mcp), WA_API_KEY (wam_… API key), WA_LANG (en|it, default: OS language).
 * It never opens a WhatsApp socket itself: the server owns the single socket per number.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { VERSION } from './config.js'
import { osLang } from './i18n.js'

const url = process.env.WA_MCP_URL || 'http://127.0.0.1:8810/mcp'
const key = process.env.WA_API_KEY || ''

async function main() {
  const client = new Client({ name: 'mcp-mrg-whatsops-stdio', version: VERSION })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'Accept-Language': osLang(), ...(key ? { Authorization: `Bearer ${key}` } : {}) } } }))
  const info = client.getServerVersion()
  const server = new Server(
    { name: info?.name ?? 'mcp-mrg-whatsops', title: 'WhatsOps', version: info?.version ?? VERSION },
    { capabilities: { tools: {} }, instructions: client.getInstructions() },
  )
  server.setRequestHandler(ListToolsRequestSchema, async (req) => client.listTools(req.params))
  server.setRequestHandler(CallToolRequestSchema, async (req) => client.callTool(req.params))
  await server.connect(new StdioServerTransport())
}

main().catch((e) => {
  process.stderr.write(`mcp-mrg-whatsops-stdio: ${String(e?.message ?? e)}\n`)
  process.exit(1)
})
