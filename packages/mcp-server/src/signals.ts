#!/usr/bin/env node

/**
 * Clowder AI MCP Server — Signals Surface
 * 只暴露 Signal Hunter 工具。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSignalToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

/**
 * Create a Signals MCP server instance with Signal Hunter tools
 * (inbox, search, study, article management) registered.
 */
export function createSignalsServer(): McpServer {
  const server = createBaseServer('cat-cafe-signals-mcp');
  registerSignalToolset(server);
  return server;
}

async function main(): Promise<void> {
  initCatCafeDir();
  const server = createSignalsServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe-signals] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe-signals] MCP Server running on stdio');
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-signals] Fatal error:', err);
    process.exit(1);
  });
}
