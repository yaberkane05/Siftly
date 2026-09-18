import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getStatus, listRecent, searchBookmarks, syncFromX } from '../lib/agent'

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  }
}

const server = new McpServer({
  name: 'siftly',
  version: '0.2.0',
})

server.registerTool(
  'siftly_status',
  {
    description:
      'Library snapshot: bookmark count, unprocessed items, X session status, last sync run.',
  },
  async () => {
    try {
      return json(await getStatus())
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'siftly_recent',
  {
    description:
      'Bookmarks imported in the last N hours (default 48, max 40 results). Use for “last 24h/48h bookmarks”.',
    inputSchema: {
      hours: z.number().int().min(1).max(720).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
  },
  async ({ hours, limit }) => {
    try {
      return json(await listRecent({ hours, limit }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'siftly_search',
  {
    description: 'Keyword search over the local Siftly bookmark library (FTS + tags).',
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(40).optional(),
    },
  },
  async ({ query, limit }) => {
    try {
      return json(await searchBookmarks(query, limit ?? 20))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'siftly_sync',
  {
    description:
      'Incremental X bookmark sync. Stops after 5 consecutive known tweets, then processes only new ones. May open a Chromium window if the X session is missing or expired.',
  },
  async () => {
    try {
      return json(await syncFromX('mcp'))
    } catch (err) {
      return fail(err)
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
