#!/usr/bin/env node

/**
 * Clowder AI MCP Server — Collab Surface
 * 只暴露协作核心工具（消息、上下文、任务、权限）。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCollabToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

/**
 * Create a Collab MCP server instance with messaging, context,
 * task management, and permission tools registered.
 */
export function createCollabServer(): McpServer {
  const server = createBaseServer('cat-cafe-collab-mcp');
  registerCollabToolset(server);
  return server;
}

async function main(): Promise<void> {
  initCatCafeDir();
  const server = createCollabServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe-collab] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe-collab] MCP Server running on stdio');
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-collab] Fatal error:', err);
    process.exit(1);
  });
}
