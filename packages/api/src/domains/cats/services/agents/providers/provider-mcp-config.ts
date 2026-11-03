import { existsSync } from 'node:fs';
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
import {
  assertMappedCapabilitySource,
  resolveInvokeCapabilityRoot,
} from '../../../../../config/capabilities/invoke-capability-root.js';
import {
  observeInvocationMcpSource,
  readInvocationMcpConfig,
  readInvocationMcpFile,
} from '../../../../../config/capabilities/invoke-mcp-config.js';
import {
  bindManagedMcpStdioConfig,
  materializeNativeMcpHttp,
} from '../../../../../config/capabilities/managed-mcp-config.js';
import { isManagedCatCafeSplit } from '../../../../../config/capabilities/mcp-constants.js';
import {
  resolveMcpArgs,
  resolveMcpCommand,
  resolveMcpWorkingDir,
} from '../../../../../config/capabilities/mcp-launch-paths.js';
import {
  bindPluginMcpEnvironment,
  pluginMcpEnvironment,
} from '../../../../../config/capabilities/plugin-mcp-environment.js';
import { isRetiredGithubMcpConfigEntry } from '../../../../../config/capabilities/retired-github-mcp.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('provider-mcp-config');
function resolveMcpWorkspaceRoot(workingDirectory?: string): string {
  const explicitAllowed = process.env.ALLOWED_WORKSPACE_DIRS?.trim();
  if (explicitAllowed) return explicitAllowed;
  const threadWorkspace = workingDirectory?.trim();
  if (threadWorkspace) return resolve(threadWorkspace);
  const explicitWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (explicitWorkspace) return explicitWorkspace;
  return process.cwd();
}

export interface ProviderMcpConfigPlan {
  readonly servers: Record<string, Record<string, unknown>>;
  readonly source: 'capabilities.json' | 'fallback';
  readonly pluginMcpServerNames: readonly string[];
  readonly catCafeMcpServerNames: readonly string[];
}

function catCafeEnvironment(
  input: { callbackEnv: Record<string, string>; credentialFile?: string },
  previous: Record<string, string>,
) {
  const env = { ...previous };
  if (input.credentialFile) {
    delete env.CAT_CAFE_INVOCATION_ID;
    delete env.CAT_CAFE_CALLBACK_TOKEN;
  }
  for (const key of MCP_CALLBACK_ENV_KEYS) {
    const value = input.callbackEnv[key];
    if (value && !(input.credentialFile && (key === 'CAT_CAFE_INVOCATION_ID' || key === 'CAT_CAFE_CALLBACK_TOKEN')))
      env[key] = value;
  }
  if (input.credentialFile) env.CAT_CAFE_CREDENTIAL_FILE = input.credentialFile;
  return env;
}

export async function captureProviderMcpConfig(input: {
  callbackEnv: Record<string, string>;
  workingDirectory?: string;
  mcpServerPath: string;
  credentialFile?: string;
  provider?: string;
  /** Native clients may inherit a Git-root MCP file while executing in a child directory. */
  projectMcpRoot?: string;
}): Promise<ProviderMcpConfigPlan> {
  const distDir = dirname(input.mcpServerPath);
  const binaryProjectRoot = resolve(distDir, '../../..');
  const capabilitiesProjectRoot = await resolveInvokeCapabilityRoot(binaryProjectRoot);
  const catId = input.callbackEnv.CAT_CAFE_CAT_ID;

  const catCafeEnvEntries = catCafeEnvironment(input, {
    ALLOWED_WORKSPACE_DIRS: resolveMcpWorkspaceRoot(input.workingDirectory),
  });

  const mcpServers: Record<string, Record<string, unknown>> = {};
  const managedMcpServerNames = new Set<string>();
  const pluginMcpServerNames: string[] = [];
  const catCafeMcpServerNames: string[] = [];
  let resolved = false;
  try {
    // F249: Project config is the single truth source for MCP resolution.
    // Try project first; fall back to global for uninitialized projects.
    const {
      config: capConfig,
      configSourceRoot,
      accessScope,
    } = readInvocationMcpConfig(capabilitiesProjectRoot, input.workingDirectory);
    if (capConfig && catId) {
      if (input.provider === 'kimi') {
        // Retired or unusable descriptors may be absent from resolveServersForCat.
        // Their host-owned names must still exclude stale project definitions.
        for (const cap of capConfig.capabilities) {
          if (cap.type === 'mcp') managedMcpServerNames.add(cap.id.replace(/:/g, '__'));
        }
      }
      for (const s of resolveServersForCat(capConfig, catId, { accessScope })) {
        managedMcpServerNames.add(s.name);
        if (!s.enabled) continue;
        if (isManagedCatCafeSplit(s)) {
          const ep = CAT_CAFE_SPLIT_ENTRYPOINTS.get(s.name)!;
          const epPath = join(distDir, ep);
          if (existsSync(epPath)) {
            catCafeMcpServerNames.push(s.name);
            mcpServers[s.name] = {
              command: resolveCatCafeNodeCommand(),
              args: [epPath],
              env: catCafeEnvEntries,
            };
          }
        } else if (s.resolver === 'pencil') {
          const pencil = await resolvePencilCommand({ projectRoot: configSourceRoot });
          if (pencil) mcpServers[s.name] = { command: pencil.command, args: pencil.args };
        } else if (s.transport === 'streamableHttp' && s.url) {
          const entry: Record<string, unknown> = { type: 'http', url: s.url };
          if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
          mcpServers[s.name] = entry;
        } else if (s.command) {
          const workingDir = resolveMcpWorkingDir(s.workingDir, configSourceRoot);
          const entry: Record<string, unknown> = {
            command: resolveMcpCommand(s.command, workingDir, configSourceRoot),
            args: resolveMcpArgs(s.args, workingDir, configSourceRoot),
          };
          const environment = pluginMcpEnvironment(s, input.callbackEnv);
          if (environment && Object.keys(environment).length > 0) entry.env = environment;
          if (s.source === 'plugin' && environment?.CLOWDER_PLUGIN_ACTION_TOKEN) pluginMcpServerNames.push(s.name);
          if (workingDir) entry.cwd = workingDir;
          mcpServers[s.name] = entry;
        }
      }
      resolved = true;
    }
  } catch {
    // best-effort fallback below
  }
  assertMappedCapabilitySource(resolved, binaryProjectRoot, capabilitiesProjectRoot);
  if (!resolved) {
    for (const [name, ep] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      const epPath = join(distDir, ep);
      if (existsSync(epPath)) {
        catCafeMcpServerNames.push(name);
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
      const excludedMcpServerNames = expandManagedMcpNamesForUserMerge([
        ...managedMcpServerNames,
        ...Object.keys(mcpServers),
        ...(input.provider === 'kimi' ? CAT_CAFE_SPLIT_ENTRYPOINTS.keys() : []),
      ]);
      const roots = new Set([input.projectMcpRoot ?? input.workingDirectory, input.workingDirectory]);
      for (const userMcpRoot of roots) {
        const userMcpPath = join(userMcpRoot, '.mcp.json');
        if (existsSync(userMcpPath)) {
          const userMcp = JSON.parse(readInvocationMcpFile(userMcpPath)) as {
            mcpServers?: Record<string, unknown>;
          };
          if (userMcp.mcpServers && typeof userMcp.mcpServers === 'object') {
            for (const [name, entry] of Object.entries(userMcp.mcpServers)) {
              if (isRetiredGithubMcpConfigEntry(name, entry)) continue;
              if (!excludedMcpServerNames.has(name) && entry && typeof entry === 'object') {
                const server = { ...(entry as Record<string, unknown>) };
                if (input.projectMcpRoot && typeof server.command === 'string') {
                  server.cwd = resolve(userMcpRoot, typeof server.cwd === 'string' ? server.cwd : '.');
                }
                mcpServers[name] = server;
              }
            }
          }
        } else observeInvocationMcpSource(userMcpPath, null);
      }
    } catch {
      // best-effort: unreadable user config → capabilities-only
    }
  }

  log.debug(
    summarizeMcpInjection(mcpServers, {
      catId,
      resolvedFrom: resolved ? 'capabilities.json' : 'fallback',
      provider: input.provider ?? 'claude',
    }),
    '#712: MCP invoke-time injection',
  );
  return structuredClone({
    servers: mcpServers,
    source: resolved ? 'capabilities.json' : 'fallback',
    pluginMcpServerNames,
    catCafeMcpServerNames,
  });
}

export async function resolveProviderMcpConfigResolution(
  input: Parameters<typeof captureProviderMcpConfig>[0] & { frozenNativeMcpConfig?: ProviderMcpConfigPlan },
): Promise<{ servers: Record<string, Record<string, unknown>>; source: ProviderMcpConfigPlan['source'] }> {
  const plan = input.frozenNativeMcpConfig ?? (await captureProviderMcpConfig(input));
  return materializeProviderMcpConfig(plan, input);
}

export function materializeProviderMcpConfig(
  plan: ProviderMcpConfigPlan,
  input: { callbackEnv: Record<string, string>; credentialFile?: string },
) {
  const callback = {
    ...input.callbackEnv,
    ...(input.credentialFile ? { CAT_CAFE_CREDENTIAL_FILE: input.credentialFile } : {}),
  };
  return {
    servers: materializeNativeMcpHttp(
      Object.fromEntries(
        Object.entries(plan.servers).map(([name, server]) => [
          name,
          bindManagedMcpStdioConfig(
            plan.pluginMcpServerNames.includes(name)
              ? { ...server, env: bindPluginMcpEnvironment(server.env as Record<string, string>, callback) }
              : plan.catCafeMcpServerNames.includes(name)
                ? { ...server, env: catCafeEnvironment(input, server.env as Record<string, string>) }
                : server,
            callback,
          ),
        ]),
      ),
      callback,
    ),
    source: plan.source,
  };
}

export async function resolveProviderMcpConfig(
  input: Parameters<typeof resolveProviderMcpConfigResolution>[0],
): Promise<Record<string, Record<string, unknown>>> {
  return (await resolveProviderMcpConfigResolution(input)).servers;
}
