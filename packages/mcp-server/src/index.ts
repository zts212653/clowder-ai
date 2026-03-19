#!/usr/bin/env node

/**
 * Clowder AI MCP Server (legacy all-in-one entrypoint)
 * 保持向后兼容：聚合注册 collab + memory + signals。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFullToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

function createBaseServer(name: string): McpServer {
  return new McpServer({
    name,
    version: '0.1.0',
  });
}

export function createServer(): McpServer {
  const server = createBaseServer('cat-cafe-mcp');
  registerFullToolset(server);
  return server;
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  initCatCafeDir();
  const server = createServer();
  const transport = new StdioServerTransport();
  console.error('[cat-cafe] MCP Server starting...');
  await server.connect(transport);
  console.error('[cat-cafe] MCP Server running on stdio');
}

// 仅作为入口运行时启动 (import 时跳过，避免测试阻塞在 stdio)
const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe] Fatal error:', err);
    process.exit(1);
  });
}
