import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MCP_CALLBACK_ENV_KEYS } from '../../../../../config/capabilities/mcp-constants.js';
import { resolveProviderMcpConfig } from './provider-mcp-config.js';

type Server = Record<string, unknown>;

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

async function readServers(path: string): Promise<Record<string, Server>> {
  const raw = await optionalText(path);
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
    for (const [name, entry] of Object.entries(await readServers(layer.path))) {
      if (!Object.hasOwn(servers, name) || servers[name]?.enabled === false) {
        servers[name] = disabledServer(entry, layer.cwd);
      }
    }
  }
}

/** Highest-priority project entries close every lower native layer over the host-approved surface. */
export async function resolveKimiMcpSurface(input: {
  callbackEnv: Record<string, string>;
  workingDirectory: string;
  mcpServerPath: string;
  nativeDirectory: string;
  mcpSupport?: boolean;
}): Promise<Record<string, Server>> {
  const projectRoot = await kimiProjectRoot(input.workingDirectory);
  const servers = Object.create(null) as Record<string, Server>;
  // A member-wide denial takes precedence over host, project and native sources.
  if (input.mcpSupport !== false) {
    Object.assign(servers, await resolveProviderMcpConfig({ ...input, provider: 'kimi', projectMcpRoot: projectRoot }));
  }
  const layers = [
    { path: join(input.nativeDirectory, 'mcp.json'), cwd: input.workingDirectory },
    { path: join(projectRoot, '.mcp.json'), cwd: projectRoot },
    ...(input.mcpSupport === false
      ? [{ path: join(input.workingDirectory, '.mcp.json'), cwd: input.workingDirectory }]
      : []),
  ];
  await denyUnapprovedNativeServers(servers, layers);
  // Approved MCP children inherit callbacks from the invocation, never a file.
  for (const entry of Object.values(servers)) {
    if (entry.env && typeof entry.env === 'object') {
      const env = { ...(entry.env as Record<string, string>) };
      for (const key of MCP_CALLBACK_ENV_KEYS) delete env[key];
      entry.env = env;
    }
  }
  return servers;
}
