#!/usr/bin/env node

/**
 * Clowder AI MCP Server — Limb Surface
 * 只暴露 Limb 工具（跨 agent 调用）。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerLimbToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

export function createLimbServer(): McpServer {
  const server = createBaseServer('cat-cafe-limb-mcp');
  registerLimbToolset(server);
  return server;
}

async function main(): Promise<void> {
  initCatCafeDir();
  const server = createLimbServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe-limb] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe-limb] MCP Server running on stdio');
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-limb] Fatal error:', err);
    process.exit(1);
  });
}
