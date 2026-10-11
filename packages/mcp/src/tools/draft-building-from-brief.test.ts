import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SceneBridge } from '../bridge/scene-bridge'
import { registerSharedTools } from './shared-tools'

// The brief's edge cases run in the shared table (draft-building-cases.ts); these are what only a
// client sees: the whole draft is one undo step, and a brief the contract cannot read never
// reaches the scene.
type Result = {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}

const brief = {
  footprint: { shape: 'rectangle', width: '33 ft', depth: { value: 8, source: 'measured' } },
  stories: [{ height: 3 }, { height: 3 }],
  roof: { type: 'hip' },
  facades: [{ facade: 'front', openings: [{ kind: 'door' }, { kind: 'window', count: 2 }] }],
}

describe('draft_building_from_brief over MCP', () => {
  let bridge: SceneBridge
  let client: Client

  beforeEach(async () => {
    bridge = new SceneBridge()
    // The editor's empty start: a site, a building and one empty level.
    bridge.setScene({}, [])
    bridge.loadDefault()
    bridge.clearHistory()
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerSharedTools(server, bridge)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  const call = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: 'draft_building_from_brief', arguments: args })) as Result
  const countOf = (type: string) =>
    Object.values(bridge.getNodes()).filter((node) => node.type === type).length

  test('drafts the building in one undo step and lists what was estimated', async () => {
    const before = Object.keys(bridge.getNodes()).sort()
    const result = await call(brief)
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      counts: { levels: 2, walls: 8, doors: 1, windows: 2 },
      achieved: { created: { level: 2, wall: 8, door: 1, window: 2, roof: 1 } },
    })
    const estimates = result.structuredContent!.estimates as { field: string; source: string }[]
    // "33 ft" is read in metres and, given bare, counts as an estimate; the measured depth is not listed.
    expect(estimates).toContainEqual(
      expect.objectContaining({ field: 'footprint.width', value: 10.0584, source: 'estimated' }),
    )
    expect(estimates).toContainEqual(
      expect.objectContaining({ field: 'roof.pitch', value: 30, source: 'default' }),
    )
    expect(estimates.some(({ field }) => field === 'footprint.depth')).toBe(false)
    expect(countOf('wall')).toBe(8)

    expect(bridge.undo()).toBe(1)
    expect(Object.keys(bridge.getNodes()).sort()).toEqual(before)
  })

  test('refuses a brief its contract cannot read, and changes nothing', async () => {
    const before = Object.keys(bridge.getNodes()).sort()
    const result = await call({ ...brief, stories: [], roof: { type: 'dome' } })
    expect(result.isError).toBe(true)
    const text = result.content[0]!.text
    expect(text).toContain('stories')
    expect(text).toContain('roof.type')
    expect(Object.keys(bridge.getNodes()).sort()).toEqual(before)
  })
})
