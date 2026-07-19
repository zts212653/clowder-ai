#!/usr/bin/env node

/**
 * Generic Protocol MCP Server
 *
 * Reads protocol YAML files and exposes them as MCP tools.
 * Usage: node protocol-server.js --prefix VIDEO_GEN --protocols-dir plugins/video-gen/protocols
 *
 * Credentials are read from env vars set by PluginResourceActivator:
 *   {PREFIX}_PROVIDER, {PREFIX}_AUTH_TYPE, {PREFIX}_API_KEY, {PREFIX}_BASE_URL, {PREFIX}_MODEL
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadProtocolsFromDir } from './protocol-engine/loader.js';
import type { ProtocolTemplate, ProviderInstance } from './protocol-engine/types.js';
import { buildCredentialsFromEnv, buildProviderFromEnv, createProtocolTools } from './tools/protocol-tools.js';

function parseArgs(): { prefix: string; protocolsDir: string } {
  const args = process.argv.slice(2);
  let prefix = '';
  let protocolsDir = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prefix' && args[i + 1]) prefix = args[++i];
    if (args[i] === '--protocols-dir' && args[i + 1]) protocolsDir = args[++i];
  }
  if (!prefix || !protocolsDir) {
    console.error('Usage: protocol-server --prefix <ENV_PREFIX> --protocols-dir <path>');
    process.exit(1);
  }
  return { prefix, protocolsDir };
}

function resolveProjectRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // dist/protocol-server.js → ../../.. = project root
  return resolve(thisDir, '..', '..', '..');
}

/** Assemble credentials + inject auth paramName from template. Exported for testing. */
export function buildProtocolToolConfig(prefix: string, provider: ProviderInstance, template: ProtocolTemplate) {
  const credentials = buildCredentialsFromEnv(prefix);
  if (template.auth?.paramName) credentials._authParamName = template.auth.paramName;
  return { prefix: prefix.toLowerCase(), provider, template, credentials };
}

async function main(): Promise<void> {
  const { prefix, protocolsDir } = parseArgs();
  const projectRoot = resolveProjectRoot();
  const absProtocolsDir = resolve(projectRoot, protocolsDir);

  // Load templates first to resolve provider's base URL from protocol YAML default.
  const templates = loadProtocolsFromDir(absProtocolsDir);

  // Peek at the selected protocol name from env to get its template baseUrl and auth defaults.
  const providerName = process.env[`${prefix}_PROVIDER`];
  const selectedTemplate = providerName ? templates.get(providerName) : undefined;
  const provider = buildProviderFromEnv(prefix, selectedTemplate?.baseUrl, selectedTemplate?.auth?.method);
  if (!provider) {
    console.error(`[protocol-server] ${prefix}_PROVIDER not set, no tools registered`);
    const server = new McpServer({ name: `protocol-${prefix.toLowerCase()}`, version: '0.1.0' });
    await server.connect(new StdioServerTransport());
    return;
  }

  const template = templates.get(provider.protocol);
  if (!template) {
    console.error(`[protocol-server] Protocol '${provider.protocol}' not found in ${absProtocolsDir}`);
    const server = new McpServer({ name: `protocol-${prefix.toLowerCase()}`, version: '0.1.0' });
    await server.connect(new StdioServerTransport());
    return;
  }

  if (!provider.baseUrl) {
    console.error(
      `[protocol-server] Error: ${prefix}_BASE_URL not set and protocol '${provider.protocol}' has no default baseUrl`,
    );
    const server = new McpServer({ name: `protocol-${prefix.toLowerCase()}`, version: '0.1.0' });
    await server.connect(new StdioServerTransport());
    return;
  }

  const config = buildProtocolToolConfig(prefix, provider, template);
  const tools = createProtocolTools(config);

  const server = new McpServer({ name: `protocol-${config.prefix}`, version: '0.1.0' });
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args, extra) => {
      const result = await tool.handler(args as never, extra);
      return result as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    });
  }

  const transport = new StdioServerTransport();
  console.error(
    `[protocol-server] Starting ${config.prefix} with ${tools.length} tools (provider: ${provider.protocol})`,
  );
  await server.connect(transport);
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[protocol-server] Fatal:', err);
    process.exit(1);
  });
}

export { main as startProtocolServer };
