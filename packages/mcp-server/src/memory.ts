#!/usr/bin/env node

/**
 * Cat Café MCP Server — Memory Surface
 * 只暴露记忆与回溯工具（evidence/reflect/session chain）。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMemoryToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

/**
 * Create a Memory MCP server instance with evidence search,
 * reflection, session chain, and memory retention tools registered.
 */
export function createMemoryServer(): McpServer {
  const server = createBaseServer('cat-cafe-memory-mcp');
  registerMemoryToolset(server);
  return server;
}

async function main(): Promise<void> {
  initCatCafeDir();
  const server = createMemoryServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe-memory] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe-memory] MCP Server running on stdio');
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-memory] Fatal error:', err);
    process.exit(1);
  });
}
