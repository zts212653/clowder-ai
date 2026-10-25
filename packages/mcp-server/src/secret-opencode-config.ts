import { pathToFileURL } from 'node:url';
import { guardMcpConfig } from './secret-mcp-config.js';
import { secretRuntimeScript } from './secret-runtime.js';

const PLUGIN = pathToFileURL(secretRuntimeScript('secret-opencode-plugin.mjs')).href;

interface GuardedConfig {
  plugin?: string[];
  mcp?: Record<string, unknown>;
}

/** Apply after all project/capability merges, including OpenCode's own config hook. */
export function withOpenCodeSecretGuard<T extends GuardedConfig>(
  config: T,
  callbackEnv: Record<string, string> = {},
  nodeCommand = process.execPath,
): T {
  config.plugin = [...new Set([...(config.plugin ?? []), PLUGIN])];
  if (config.mcp)
    config.mcp = Object.fromEntries(
      Object.entries(config.mcp).map(([name, entry]) => [name, guardEntry(name, entry, callbackEnv, nodeCommand)]),
    );
  return config;
}

function guardEntry(name: string, entry: unknown, callbackEnv: Record<string, string>, nodeCommand: string): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const server = entry as Record<string, unknown>;
  if (server.enabled === false) return entry;
  // OAuth belongs to OpenCode. Its native before-hook checks the final tool
  // args/files without copying or replacing the client's auth flow.
  if (server.type === 'remote' && server.oauth !== false) return entry;
  const command = Array.isArray(server.command) ? server.command : undefined;
  const guarded = guardMcpConfig(
    command
      ? { command: command[0], args: command.slice(1), env: server.environment, cwd: server.cwd }
      : { url: server.url, headers: server.headers, transport: 'auto' },
    callbackEnv,
    undefined,
    name,
    nodeCommand,
  );
  if (!guarded.command) return entry;
  const { url: _url, headers: _headers, oauth: _oauth, ...rest } = server;
  return {
    ...rest,
    type: 'local',
    command: [guarded.command, ...(guarded.args as string[])],
    environment: guarded.env,
  };
}
