import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  expandManagedMcpNamesForUserMerge,
  MCP_CALLBACK_ENV_KEYS,
  resolveCatCafeNodeCommand,
  resolvePencilCommand,
  resolveServersForCat,
  summarizeMcpInjection,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import { isRetiredGithubMcpConfigEntry } from '../../../../../config/capabilities/retired-github-mcp.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('claude-mcp-config');
function resolveMcpWorkspaceRoot(workingDirectory?: string): string {
  const explicitAllowed = process.env.ALLOWED_WORKSPACE_DIRS?.trim();
  if (explicitAllowed) return explicitAllowed;
  const threadWorkspace = workingDirectory?.trim();
  if (threadWorkspace) return resolve(threadWorkspace);
  const explicitWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (explicitWorkspace) return explicitWorkspace;
  return process.cwd();
}

export async function resolveClaudeMcpConfig(input: {
  callbackEnv: Record<string, string>;
  workingDirectory?: string;
  mcpServerPath: string;
}): Promise<Record<string, Record<string, unknown>>> {
  const distDir = dirname(input.mcpServerPath);
  const binaryProjectRoot = resolve(distDir, '../../..');
  const capabilitiesProjectRoot = binaryProjectRoot;
  const catId = input.callbackEnv.CAT_CAFE_CAT_ID;

  const catCafeEnvEntries: Record<string, string> = {
    ALLOWED_WORKSPACE_DIRS: resolveMcpWorkspaceRoot(input.workingDirectory),
  };
  for (const key of MCP_CALLBACK_ENV_KEYS) {
    const val = input.callbackEnv![key];
    if (val) catCafeEnvEntries[key] = val;
  }

  const mcpServers: Record<string, Record<string, unknown>> = {};
  const managedMcpServerNames = new Set<string>();
  let resolved = false;
  try {
    // F249: Project config is the single truth source for MCP resolution.
    // Try project first; fall back to global for uninitialized projects.
    let capConfig = null;
    let accessScope: 'global' | 'project' = 'global';
    if (input.workingDirectory && input.workingDirectory !== capabilitiesProjectRoot) {
      try {
        const projectRaw = readFileSync(join(input.workingDirectory, '.cat-cafe', 'capabilities.json'), 'utf-8');
        const parsed = JSON.parse(projectRaw);
        if (parsed?.version === 1 || parsed?.version === 2) {
          capConfig = parsed;
          accessScope = 'project';
        }
      } catch {
        /* No project config — fall back to global */
      }
    }
    if (!capConfig) {
      const raw = readFileSync(join(capabilitiesProjectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
    }
    if (capConfig && catId) {
      for (const s of resolveServersForCat(capConfig, catId, { accessScope })) {
        managedMcpServerNames.add(s.name);
        if (!s.enabled) continue;
        if (s.source === 'cat-cafe' && CAT_CAFE_SPLIT_ENTRYPOINTS.has(s.name)) {
          const ep = CAT_CAFE_SPLIT_ENTRYPOINTS.get(s.name)!;
          const epPath = join(distDir, ep);
          if (existsSync(epPath)) {
            mcpServers[s.name] = {
              command: resolveCatCafeNodeCommand(),
              args: [epPath],
              env: catCafeEnvEntries,
            };
          }
        } else if (s.resolver === 'pencil') {
          const pencil = await resolvePencilCommand({ projectRoot: capabilitiesProjectRoot });
          if (pencil) mcpServers[s.name] = { command: pencil.command, args: pencil.args };
        } else if (s.transport === 'streamableHttp' && s.url) {
          const entry: Record<string, unknown> = { type: 'http', url: s.url };
          if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
          mcpServers[s.name] = entry;
        } else if (s.command) {
          const entry: Record<string, unknown> = { command: s.command, args: s.args };
          if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
          if (s.workingDir) entry.cwd = s.workingDir;
          mcpServers[s.name] = entry;
        }
      }
      resolved = true;
    }
  } catch {
    // best-effort fallback below
  }
  if (!resolved) {
    for (const [name, ep] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      const epPath = join(distDir, ep);
      if (existsSync(epPath)) {
        mcpServers[name] = {
          command: resolveCatCafeNodeCommand(),
          args: [epPath],
          env: catCafeEnvEntries,
        };
      }
    }
  }
  // Merge user project .mcp.json: include user-owned servers (e.g.
  // `filesystem`) that are NOT managed by capabilities.json. Our managed
  // entries always take precedence — stale user copies are ignored.
  // --strict-mcp-config still applies: only the merged set is active.
  if (input.workingDirectory) {
    try {
      const userMcpPath = join(input.workingDirectory, '.mcp.json');
      if (existsSync(userMcpPath)) {
        const userMcp = JSON.parse(readFileSync(userMcpPath, 'utf-8')) as {
          mcpServers?: Record<string, unknown>;
        };
        if (userMcp.mcpServers && typeof userMcp.mcpServers === 'object') {
          const excludedMcpServerNames = expandManagedMcpNamesForUserMerge([
            ...managedMcpServerNames,
            ...Object.keys(mcpServers),
          ]);
          for (const [name, entry] of Object.entries(userMcp.mcpServers)) {
            if (isRetiredGithubMcpConfigEntry(name, entry)) continue;
            if (!excludedMcpServerNames.has(name) && !(name in mcpServers) && entry && typeof entry === 'object') {
              mcpServers[name] = entry as Record<string, unknown>;
            }
          }
        }
      }
    } catch {
      // best-effort: unreadable user config → capabilities-only
    }
  }

  log.debug(
    summarizeMcpInjection(mcpServers, {
      catId,
      resolvedFrom: resolved ? 'capabilities.json' : 'fallback',
      provider: 'claude',
    }),
    '#712: MCP invoke-time injection',
  );
  return mcpServers;
}
