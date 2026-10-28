import { pathToFileURL } from 'node:url';
import { bindManagedMcpStdioConfig } from './managed-mcp-config.js';
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
      Object.entries(config.mcp).map(([name, entry]) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [name, entry];
        const server = entry as Record<string, unknown>;
        if (server.type !== 'local' || !Array.isArray(server.command)) return [name, entry];
        const bound = bindManagedMcpStdioConfig(
          {
            command: server.command[0],
            args: server.command.slice(1),
            env: server.environment,
            enabled: server.enabled,
          },
          callbackEnv,
        );
        return [name, bound.env === server.environment ? entry : { ...server, environment: bound.env }];
      }),
    );
  void nodeCommand;
  return config;
}
