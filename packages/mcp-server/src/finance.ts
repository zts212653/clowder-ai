#!/usr/bin/env node

/**
 * Clowder AI MCP Server - Finance Surface
 * Exposes read-only finance fact queries through the managed split topology.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { installShutdownHandlers, startRefreshLoop } from './refresh-loop.js';
import { registerFinanceToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

/**
 * Create a Finance MCP server instance with read-only finance fact tools registered.
 */
export function createFinanceServer(): McpServer {
  const server = createBaseServer('cat-cafe-finance-mcp');
  registerFinanceToolset(server);
  return server;
}

async function main(): Promise<void> {
  initCatCafeDir();
  const server = createFinanceServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe-finance] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe-finance] MCP Server running on stdio');

  const refreshLoop = startRefreshLoop();
  installShutdownHandlers(refreshLoop);
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-finance] Fatal error:', err);
    process.exit(1);
  });
}
