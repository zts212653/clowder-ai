import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { observeInvocationMcpSource } from '../../../../../config/capabilities/invoke-mcp-config.js';
import {
  captureProviderMcpConfig,
  materializeProviderMcpConfig,
  type ProviderMcpConfigPlan,
} from './provider-mcp-config.js';

type Server = Record<string, unknown>;

export interface KimiMcpConfigPlan {
  readonly nativeDirectory: string;
  /** Missing only when the existing explicit injection-disabled mode applies. */
  readonly mcpConfig?: ProviderMcpConfigPlan;
  readonly projectRoot?: string;
  readonly denialLayers: ReadonlyArray<{ path: string; cwd: string }>;
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Match native discovery for regular repositories and gitdir worktree markers. */
async function kimiProjectRoot(cwd: string): Promise<string> {
  let directory = resolve(cwd);
  while (true) {
    const marker = join(directory, '.git');
    const info = await stat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isDirectory()) return directory;
    if (info) {
      const pointer = await optionalText(marker);
      if (info.isFile() && /^\s*(?:\uFEFF)?gitdir:\s*\S+/.test(pointer ?? '')) return directory;
      throw new Error('Ambiguous Kimi Git root marker; refusing workspace trust');
    }
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}

function parseServers(raw: string | undefined): Record<string, Server> {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native MCP config');
  const servers = (parsed as Server).mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid native MCP servers');
  return servers as Record<string, Server>;
}

/** Disabled entries still pass native transport validation. Do not copy env/header/argv secrets. */
function disabledServer(entry: Server, cwd: string): Server {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid native MCP entry');
  // Native schemas ignore foreign `type` hints and infer only when transport is absent.
  const transport = Object.hasOwn(entry, 'transport')
    ? entry.transport
    : typeof entry.command === 'string'
      ? 'stdio'
      : typeof entry.url === 'string'
        ? 'http'
        : undefined;
  if (transport === 'stdio' && typeof entry.command === 'string' && entry.command.length > 0) {
    return {
      transport,
      command: entry.command,
      enabled: false,
      cwd: typeof entry.cwd === 'string' ? resolve(cwd, entry.cwd) : cwd,
    };
  }
  if ((transport === 'http' || transport === 'sse') && typeof entry.url === 'string') {
    return { transport, url: entry.url, enabled: false };
  }
  throw new Error('Cannot create a valid native MCP denial; refusing workspace trust');
}

async function denyUnapprovedNativeServers(
  servers: Record<string, Server>,
  layers: ReadonlyArray<{ path: string; cwd: string }>,
): Promise<void> {
  for (const layer of layers) {
    const raw = await optionalText(layer.path);
    observeInvocationMcpSource(layer.path, raw ?? null);
    for (const [name, entry] of Object.entries(parseServers(raw))) {
      if (!Object.hasOwn(servers, name) || servers[name]?.enabled === false) {
        Object.defineProperty(servers, name, {
          value: disabledServer(entry, layer.cwd),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }
}

/** Highest-priority project entries close every lower native layer over the host-approved surface. */
export async function captureKimiMcpSurface(input: {
  callbackEnv: Record<string, string>;
  workingDirectory: string;
  mcpServerPath: string;
  nativeDirectory: string;
  mcpSupport?: boolean;
  credentialFile?: string;
}): Promise<KimiMcpConfigPlan> {
  const projectRoot = await kimiProjectRoot(input.workingDirectory);
  const layers = [
    { path: join(input.nativeDirectory, 'mcp.json'), cwd: input.workingDirectory },
    { path: join(projectRoot, '.mcp.json'), cwd: projectRoot },
    ...(input.mcpSupport === false
      ? [{ path: join(input.workingDirectory, '.mcp.json'), cwd: input.workingDirectory }]
      : []),
  ];
  // A member-wide denial takes precedence over host, project and native sources.
  const mcpConfig: ProviderMcpConfigPlan =
    input.mcpSupport === false
      ? { servers: {}, source: 'capabilities.json', pluginMcpServerNames: [], catCafeMcpServerNames: [] }
      : await captureProviderMcpConfig({ ...input, provider: 'kimi', projectMcpRoot: projectRoot });
  await denyUnapprovedNativeServers(mcpConfig.servers, layers);
  return structuredClone({ nativeDirectory: input.nativeDirectory, mcpConfig, projectRoot, denialLayers: layers });
}

/** Native auto-discovery cannot be disabled: fresh lower layers may only add denials, never permissions. */
export async function resolveKimiMcpSurface(
  input: Parameters<typeof captureKimiMcpSurface>[0] & {
    frozenKimiMcpConfig?: KimiMcpConfigPlan;
  },
): Promise<Record<string, Server>> {
  const plan = input.frozenKimiMcpConfig ?? (await captureKimiMcpSurface(input));
  if (!plan.mcpConfig) return {};
  if ((await kimiProjectRoot(input.workingDirectory)) !== plan.projectRoot)
    throw new Error('Kimi native project root changed since admission; retry this invocation.');
  const servers = structuredClone(plan.mcpConfig.servers);
  await denyUnapprovedNativeServers(servers, plan.denialLayers);
  return materializeProviderMcpConfig({ ...plan.mcpConfig, servers }, input).servers;
}
