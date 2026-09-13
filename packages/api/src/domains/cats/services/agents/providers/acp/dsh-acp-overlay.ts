/**
 * Cordis overlay YAML for DeepSeek Harness ACP family MCP.
 * Content-addressed overlays live next to cordis.yml so plugin resolution keeps
 * the official composition anchor. A later API/test boot cannot replace a
 * configuration already referenced by another project's process pool.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpMcpServer, AcpMcpServerHttp, AcpMcpServerStdio } from './types.js';

const BARE_DSH_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

/** Cordis interpolates this at DSH process boot from Hub spawn env. */
export const DSH_ACP_CREDENTIAL_ENV_JS = '!!js process.env.CAT_CAFE_CREDENTIAL_FILE';

export function writeDshAcpOverlayConfig(input: {
  baseConfigPath: string;
  servers: readonly AcpMcpServer[];
  outputDir: string;
  pluginName?: string;
}): string {
  const base = readFileSync(input.baseConfigPath, 'utf-8');
  const plugins = buildDshMcpClientPlugins(input.servers, input.pluginName);
  const merged = plugins ? `${base.replace(/\s*$/, '')}\n\n# cat-cafe family MCP via dsh-mcp-client\n${plugins}` : base;
  const content = merged.endsWith('\n') ? merged : `${merged}\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  const outputPath = join(input.outputDir, `cat-cafe-dsh-acp.${digest}.cordis.yml`);
  mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
  const tempPath = `${outputPath}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  renameSync(tempPath, outputPath);
  return outputPath;
}

export function buildDshMcpClientPlugins(servers: readonly AcpMcpServer[], pluginName?: string): string {
  const name = pluginName ?? BARE_DSH_MCP_CLIENT;
  const lines: string[] = [];
  for (const server of servers) {
    if (isStdioMcpServer(server)) lines.push(...stdioPluginLines(server, name));
    else if (isHttpMcpServer(server)) lines.push(...httpPluginLines(server, name));
  }
  return lines.join('\n');
}

/** @deprecated Use buildDshMcpClientPlugins. */
export function buildDshMcpClientInserts(servers: readonly AcpMcpServer[]): string {
  return buildDshMcpClientPlugins(servers);
}

function isStdioMcpServer(server: AcpMcpServer): server is AcpMcpServerStdio {
  return 'command' in server && typeof server.command === 'string' && !('type' in server);
}

function isHttpMcpServer(server: AcpMcpServer): server is AcpMcpServerHttp {
  return 'type' in server && server.type === 'http';
}

function stdioPluginLines(server: AcpMcpServerStdio, pluginName: string): string[] {
  const id = sanitizeYamlId(server.name);
  const lines = [
    `- id: mcp-${id}`,
    `  name: ${yamlQuote(pluginName)}`,
    '  config:',
    `    serverName: ${yamlQuote(server.name)}`,
    '    transport: stdio',
    `    command: ${yamlQuote(server.command)}`,
  ];
  if (server.args.length > 0) {
    lines.push(`    args: [${server.args.map(yamlQuote).join(', ')}]`);
  }
  appendEnvLines(lines, server.env);
  lines.push('    failOnStartupError: true');
  return lines;
}

function httpPluginLines(server: AcpMcpServerHttp, pluginName: string): string[] {
  const id = sanitizeYamlId(server.name);
  const lines = [
    `- id: mcp-${id}`,
    `  name: ${yamlQuote(pluginName)}`,
    '  config:',
    `    serverName: ${yamlQuote(server.name)}`,
    '    transport: streamable-http',
    `    url: ${yamlQuote(server.url)}`,
  ];
  if (server.headers.length > 0) {
    lines.push('    headers:');
    for (const header of server.headers) {
      if (header.value.startsWith('!!js ')) {
        lines.push(`      ${header.name}: ${yamlJsScalar(header.value)}`);
        continue;
      }
      lines.push(`      ${header.name}: ${yamlQuote(header.value)}`);
    }
  }
  lines.push('    failOnStartupError: true');
  return lines;
}

function appendEnvLines(lines: string[], env: AcpMcpServerStdio['env']): void {
  if (!env || env.length === 0) return;
  lines.push('    env:');
  for (const entry of env) {
    if (entry.value.startsWith('!!js ')) {
      lines.push(`      ${entry.name}: ${yamlJsScalar(entry.value)}`);
      continue;
    }
    lines.push(`      ${entry.name}: ${yamlQuote(entry.value)}`);
  }
}

/**
 * Emit a `!!js` scalar the DSH entry-list dialect can parse: the YAML tag
 * applies to exactly one scalar, so any expression beyond a plain dotted
 * identifier (e.g. `'Bearer ' + process.env.X`) must be quoted as a whole —
 * unquoted, `+ process.env.X` is trailing content and js-yaml throws.
 */
function yamlJsScalar(value: string): string {
  const expr = value.slice('!!js '.length);
  return /^[A-Za-z0-9_$.]+$/.test(expr) ? value : `!!js ${yamlQuote(expr)}`;
}

function sanitizeYamlId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'server';
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
