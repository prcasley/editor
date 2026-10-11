// A Pascal MCP server and client in one process, linked in memory. Every scene in
// the portfolio is built only through these tool calls, the same contracts an
// external agent (Claude Code, Codex, ...) drives over stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPascalMcpServer, SceneBridge } from '@pascal-app/mcp'

export type ToolResult = Record<string, any>

export type PascalSession = {
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>
  close: () => Promise<void>
  /** Number of tool calls made, by tool name. */
  calls: Record<string, number>
}

/**
 * Opens a session on an empty project. The headless scene store is one per
 * process, so each scene starts with `clear_scene` rather than inheriting the
 * previous scene's nodes.
 */
export async function openSession(reason: string): Promise<PascalSession> {
  const bridge = new SceneBridge()
  bridge.loadDefault()
  const server = createPascalMcpServer({ bridge })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'woodmont-portfolio', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const cleared = await client.callTool({ name: 'clear_scene', arguments: { reason } })
  if (cleared.isError) throw new Error(`clear_scene refused: ${JSON.stringify(cleared.content)}`)
  const calls: Record<string, number> = { clear_scene: 1 }

  return {
    calls,
    async call(name, args = {}) {
      calls[name] = (calls[name] ?? 0) + 1
      const res = await client.callTool({ name, arguments: args })
      const content = res.content as { type: string; text?: string }[] | undefined
      const text = content?.find((c) => c.type === 'text')?.text ?? ''
      if (res.isError) throw new Error(`${name} refused: ${text}`)
      if (res.structuredContent) return res.structuredContent as ToolResult
      return text ? (JSON.parse(text) as ToolResult) : {}
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
}
