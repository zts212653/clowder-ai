#!/usr/bin/env node

/**
 * Clowder AI MCP Server — Limb Surface
 *
 * 只暴露布偶猫专属能力（pair-approve / pair-list / invoke）。
 *
 * F193 Phase C: split-only 配置归一后，limb tools 不再 piggyback 在
 * all-in-one `cat-cafe` server 上，而是有独立 namespace。
 * 见 docs/features/F193-cross-thread-comm-unification.md Phase C。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { installShutdownHandlers, startRefreshLoop } from './refresh-loop.js';
import { registerLimbToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

/**
 * Create a Limb MCP server instance with limb tools
 * (布偶猫 pair-approve / pair-list / invoke) registered.
 */
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

  const refreshLoop = startRefreshLoop();
  installShutdownHandlers(refreshLoop);
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-limb] Fatal error:', err);
    process.exit(1);
  });
}
