import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  expandManagedMcpNamesForUserMerge,
  MCP_CALLBACK_ENV_KEYS,
  resolveCatCafeNodeCommand,
  resolvePencilCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import { isRetiredGithubMcpConfigEntry } from '../../../../../config/capabilities/retired-github-mcp.js';

export type ClaudeMcpServerConfig = Record<string, unknown>;

export interface ClaudeMcpConfigResolution {
  readonly servers: Record<string, ClaudeMcpServerConfig>;
  readonly source: 'capabilities.json' | 'fallback';
}

function resolveWorkspaceRoot(workingDirectory?: string): string {
  const explicitAllowed = process.env.ALLOWED_WORKSPACE_DIRS?.trim();
  if (explicitAllowed) return explicitAllowed;
  const threadWorkspace = workingDirectory?.trim();
  if (threadWorkspace) return resolve(threadWorkspace);
  const explicitWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (explicitWorkspace) return explicitWorkspace;
  return process.cwd();
}

/**
 * Resolve the exact per-invocation Claude MCP surface once for both supported
 * Claude carriers. This is intentionally independent from CLI argument
 * assembly: SDK and CLI consume the same server map and callback credentials.
 */
export async function resolveClaudeMcpConfig(input: {
  readonly callbackEnv?: Record<string, string>;
  readonly workingDirectory?: string;
  readonly mcpServerPath?: string;
}): Promise<ClaudeMcpConfigResolution | undefined> {
  if (!input.callbackEnv || !input.mcpServerPath) return undefined;

  const distDir = dirname(input.mcpServerPath);
  const capabilitiesProjectRoot = resolve(distDir, '../../..');
  const catId = input.callbackEnv.CAT_CAFE_CAT_ID;
  const callbackEnv: Record<string, string> = {
    ALLOWED_WORKSPACE_DIRS: resolveWorkspaceRoot(input.workingDirectory),
  };
  for (const key of MCP_CALLBACK_ENV_KEYS) {
    const value = input.callbackEnv[key];
    if (value) callbackEnv[key] = value;
  }

  const servers: Record<string, ClaudeMcpServerConfig> = {};
  const managedNames = new Set<string>();
  let resolved = false;
  try {
    let capabilityConfig: CapabilitiesConfig | null = null;
    let accessScope: 'global' | 'project' = 'global';
    if (input.workingDirectory && input.workingDirectory !== capabilitiesProjectRoot) {
      try {
        const parsed = JSON.parse(
          readFileSync(join(input.workingDirectory, '.cat-cafe', 'capabilities.json'), 'utf8'),
        ) as Partial<CapabilitiesConfig>;
        if ((parsed.version === 1 || parsed.version === 2) && Array.isArray(parsed.capabilities)) {
          capabilityConfig = parsed as CapabilitiesConfig;
          accessScope = 'project';
        }
      } catch {
        // No project capability config; use the installation-owned config.
      }
    }
    if (!capabilityConfig) {
      const parsed = JSON.parse(
        readFileSync(join(capabilitiesProjectRoot, '.cat-cafe', 'capabilities.json'), 'utf8'),
      ) as Partial<CapabilitiesConfig>;
      if ((parsed.version === 1 || parsed.version === 2) && Array.isArray(parsed.capabilities)) {
        capabilityConfig = parsed as CapabilitiesConfig;
      }
    }
    if (capabilityConfig && catId) {
      for (const server of resolveServersForCat(capabilityConfig, catId, { accessScope })) {
        managedNames.add(server.name);
        if (!server.enabled) continue;
        if (server.source === 'cat-cafe' && CAT_CAFE_SPLIT_ENTRYPOINTS.has(server.name)) {
          const entrypoint = CAT_CAFE_SPLIT_ENTRYPOINTS.get(server.name)!;
          const entrypointPath = join(distDir, entrypoint);
          if (existsSync(entrypointPath)) {
            servers[server.name] = {
              command: resolveCatCafeNodeCommand(),
              args: [entrypointPath],
              env: callbackEnv,
            };
          }
        } else if (server.resolver === 'pencil') {
          const pencil = await resolvePencilCommand({ projectRoot: capabilitiesProjectRoot });
          if (pencil) servers[server.name] = { command: pencil.command, args: pencil.args };
        } else if (server.transport === 'streamableHttp' && server.url) {
          servers[server.name] = {
            type: 'http',
            url: server.url,
            ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
          };
        } else if (server.command) {
          servers[server.name] = {
            command: server.command,
            args: server.args,
            ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
            ...(server.workingDir ? { cwd: server.workingDir } : {}),
          };
        }
      }
      resolved = true;
    }
  } catch {
    // Fall through to the installation-owned Cat Cafe entrypoints.
  }

  if (!resolved) {
    for (const [name, entrypoint] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      const entrypointPath = join(distDir, entrypoint);
      if (existsSync(entrypointPath)) {
        servers[name] = {
          command: resolveCatCafeNodeCommand(),
          args: [entrypointPath],
          env: callbackEnv,
        };
      }
    }
  }

  if (input.workingDirectory) {
    try {
      const projectConfig = JSON.parse(readFileSync(join(input.workingDirectory, '.mcp.json'), 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        const excludedNames = expandManagedMcpNamesForUserMerge([...managedNames, ...Object.keys(servers)]);
        for (const [name, entry] of Object.entries(projectConfig.mcpServers)) {
          if (isRetiredGithubMcpConfigEntry(name, entry)) continue;
          if (!excludedNames.has(name) && !(name in servers) && entry && typeof entry === 'object') {
            servers[name] = entry as ClaudeMcpServerConfig;
          }
        }
      }
    } catch {
      // Project MCP config is optional; the managed surface remains authoritative.
    }
  }

  return { servers, source: resolved ? 'capabilities.json' : 'fallback' };
}
