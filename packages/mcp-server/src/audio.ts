#!/usr/bin/env node

/**
 * Clowder AI MCP Server - Audio Surface
 * Exposes audio capture/transcription tools through the managed split topology.
 *
 * F195: audio tools were only registered in the all-in-one registerFullToolset()
 * but lacked a split entry file, making them invisible to Codex and any other
 * client using the split MCP server topology.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { installShutdownHandlers, startRefreshLoop } from './refresh-loop.js';
import { registerAudioToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

/**
 * Create an Audio MCP server instance with audio capture/transcription tools registered.
 */
export function createAudioServer(): McpServer {
  const server = createBaseServer('cat-cafe-audio-mcp');
  registerAudioToolset(server);
  return server;
}

async function main(): Promise<void> {
  initCatCafeDir();
  const server = createAudioServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe-audio] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe-audio] MCP Server running on stdio');

  const refreshLoop = startRefreshLoop();
  installShutdownHandlers(refreshLoop);
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-audio] Fatal error:', err);
    process.exit(1);
  });
}
