// Broad read-only consumer surface, all schemas/descriptions/handlers are production exports.
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

Object.assign(process.env, JSON.parse(readFileSync(process.argv[2], 'utf8')));
const { callbackTools } = await import('../../dist/tools/callback-tools.js');
const { evidenceTools } = await import('../../dist/tools/evidence-tools.js');
const { graphTools } = await import('../../dist/tools/graph-tools.js');
const { fileTools, fileSliceTools } = await import('../../dist/tools/file-tools.js');
const { recentTools } = await import('../../dist/tools/recent-tools.js');
const selected = [
  ...evidenceTools,
  ...graphTools,
  ...fileSliceTools,
  ...recentTools,
  ...fileTools.filter((tool) => ['read_file', 'list_files'].includes(tool.name)),
  ...callbackTools.filter((tool) =>
    [
      'cat_cafe_get_message',
      'cat_cafe_get_thread_context',
      'cat_cafe_list_threads',
      'cat_cafe_read_profile',
      'cat_cafe_list_tasks',
    ].includes(tool.name),
  ),
];
const server = new McpServer({ name: 'f321-experience-reader', version: '1.0.0' });
for (const tool of selected) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: z.object(tool.inputSchema),
      annotations: tool.annotations ?? { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    tool.handler,
  );
}
await server.connect(new StdioServerTransport());
