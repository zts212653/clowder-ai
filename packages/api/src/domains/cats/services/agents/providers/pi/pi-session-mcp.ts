import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpMcpServerStdio } from '../acp/types.js';
import { record } from './pi-rpc-process.js';

export function piMcpServers(value: unknown): AcpMcpServerStdio[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid Pi MCP servers');
  const names = new Set<string>();
  return value.map((item) => {
    const server = record(item);
    if (
      typeof server.name !== 'string' ||
      !server.name ||
      names.has(server.name) ||
      typeof server.command !== 'string' ||
      !Array.isArray(server.args) ||
      !server.args.every((arg): arg is string => typeof arg === 'string') ||
      (server.type !== undefined && server.type !== 'stdio')
    )
      throw new Error('The Pi bridge supports unique stdio MCP servers only');
    names.add(server.name);
    if (server.env !== undefined && !Array.isArray(server.env)) throw new Error('Invalid Pi MCP environment');
    const env = (Array.isArray(server.env) ? server.env : []).map((value) => {
      const entry = record(value);
      if (typeof entry.name !== 'string' || typeof entry.value !== 'string')
        throw new Error('Invalid Pi MCP environment');
      return { name: entry.name, value: entry.value };
    });
    return { name: server.name, command: server.command, args: server.args, env };
  });
}

/** Same native tool identity after restart; only current, ephemeral launch credentials are embedded. */
export function piMcpExtension(id: string, servers: unknown): { directory?: string; args: string[] } {
  const registrations = piMcpServers(servers).map((server) => [
    `clowder-${createHash('sha256')
      .update(JSON.stringify([id, server.name]))
      .digest('hex')
      .slice(0, 12)}-${server.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24)}`,
    {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      exposure: 'direct',
    },
  ]);
  if (!registrations.length) return { args: [] };
  const directory = mkdtempSync(join(tmpdir(), 'clowder-pi-mcp-'));
  const entry = join(directory, 'session-mcp.mjs');
  try {
    writeFileSync(
      entry,
      `export default function(pi) { for (const [name, config] of ${JSON.stringify(registrations)}) pi.registerMcpServer(name, config); }\n`,
      { mode: 0o600 },
    );
    return { directory, args: ['--extension', entry] };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
