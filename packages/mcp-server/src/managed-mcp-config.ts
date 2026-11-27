import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAT_CAFE_SPLIT_ENTRYPOINTS, MCP_CALLBACK_ENV_KEYS } from './mcp-launch-contract.js';

const CALLBACK_KEYS = [
  ...MCP_CALLBACK_ENV_KEYS,
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_CONNECTION_ID',
  'CAT_CAFE_DATA_DIR',
  'ALLOWED_WORKSPACE_DIRS',
] as const;
const CALLBACK_KEY_SET = new Set<string>(CALLBACK_KEYS);
/** F333: the Host-owned shared browser route; nominated by the API only for its pinned launch. */
const SHARED_BROWSER_HTTP_PATH = '/api/browser-mcp/mcp';
type Server = Record<string, unknown>;

function environment(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

function managedLaunch(server: Server) {
  const args = server.args;
  if (
    server.enabled === false ||
    typeof server.command !== 'string' ||
    !Array.isArray(args) ||
    args.length !== 1 ||
    typeof args[0] !== 'string'
  )
    return undefined;
  if (Object.keys(environment(server.env)).some((key) => !CALLBACK_KEY_SET.has(key))) return undefined;
  return {
    command: server.command,
    cwd: typeof server.cwd === 'string' ? server.cwd : undefined,
    entrypoint: args[0],
  };
}

function installedEntrypoint(target: string) {
  const name = basename(target);
  if (!['index.js', ...CAT_CAFE_SPLIT_ENTRYPOINTS.values()].includes(name)) return undefined;
  return {
    path: fileURLToPath(new URL(`../dist/${name}`, import.meta.url)),
    family: name === 'index.js' ? '' : name.slice(0, -3),
  };
}

/** A name is not authority. Only this installation's genuine Node entrypoint is managed. */
function installedFamily(server: Server): string | undefined {
  const launch = managedLaunch(server);
  if (!launch) return undefined;
  try {
    if (realpathSync(launch.command) !== realpathSync(process.execPath)) return undefined;
    const target = realpathSync(resolve(launch.cwd ?? process.cwd(), launch.entrypoint));
    const entry = installedEntrypoint(target);
    return entry && target === realpathSync(entry.path) ? entry.family : undefined;
  } catch {
    return undefined;
  }
}

async function installedNativeFamily(server: Server): Promise<string | undefined> {
  const launch = managedLaunch(server);
  if (!launch) return undefined;
  try {
    if ((await realpath(launch.command)) !== (await realpath(process.execPath))) return undefined;
    const target = await realpath(resolve(launch.cwd ?? process.cwd(), launch.entrypoint));
    const entry = installedEntrypoint(target);
    return entry && target === (await realpath(entry.path)) ? entry.family : undefined;
  } catch {
    return undefined;
  }
}

export function isInstalledManagedMcpServer(server: Server): boolean {
  return installedFamily(server) !== undefined;
}

/** External MCP is deliberately unchanged: no proxy, guard or callback authority. */
export function bindManagedMcpStdioConfig(server: Server, callback: Record<string, string> = {}): Server {
  if (installedFamily(server) === undefined) return server;
  const env = { ...environment(server.env) };
  for (const key of CALLBACK_KEYS) if (callback[key]) env[key] = callback[key];
  if (env.CAT_CAFE_CREDENTIAL_FILE || env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
    if (env.CAT_CAFE_MCP_TRANSPORT !== 'stdio') delete env.CAT_CAFE_INVOCATION_ID;
    delete env.CAT_CAFE_CALLBACK_TOKEN;
  }
  return { ...server, env };
}

async function launchCredentials(callback: Record<string, string>, server: Server) {
  const env = { ...environment(server.env), ...callback };
  const path = env.CAT_CAFE_CREDENTIAL_FILE;
  if (!path || !env.CAT_CAFE_INVOCATION_ID) throw new Error('shared_mcp_launch_binding_unavailable');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error('shared_mcp_launch_credentials_invalid');
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch {
    throw new Error('shared_mcp_launch_credentials_invalid');
  }
  if (
    value.invocationId !== env.CAT_CAFE_INVOCATION_ID ||
    typeof value.callbackToken !== 'string' ||
    !value.callbackToken ||
    (env.CAT_CAFE_CALLBACK_TOKEN && value.callbackToken !== env.CAT_CAFE_CALLBACK_TOKEN)
  )
    throw new Error('shared_mcp_launch_credentials_mismatch');
  return { invocationId: String(value.invocationId), callbackToken: value.callbackToken };
}

/** Headers are private launch data: callers must use SDK control/RPC or an owner-only config file. */
export async function materializeNativeMcpHttp(
  servers: Record<string, Server>,
  callback: Record<string, string>,
  pluginPaths: Readonly<Record<string, string>> = {},
): Promise<Record<string, Server>> {
  if (callback.CAT_CAFE_MCP_TRANSPORT !== 'shared') return servers;
  let credentials: Awaited<ReturnType<typeof launchCredentials>> | undefined;
  const entries: [string, Server][] = [];
  for (const [name, server] of Object.entries(servers)) {
    const family = await installedNativeFamily(server);
    const pluginPath = pluginPaths[name];
    if (family === undefined && pluginPath === undefined) {
      entries.push([name, server]);
      continue;
    }
    const origin = new URL(callback.CAT_CAFE_API_URL ?? '');
    if (
      origin.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('shared_mcp_loopback_required');
    credentials ??= await launchCredentials(callback, server);
    if (
      pluginPath !== undefined &&
      pluginPath !== SHARED_BROWSER_HTTP_PATH &&
      !/^\/api\/plugin-mcp\/[^/?#]+\/[^/?#]+\?shared=1&activation=[A-Za-z0-9-]+$/.test(pluginPath)
    )
      throw new Error('shared_plugin_mcp_path_invalid');
    const url = new URL(pluginPath ?? '/api/member-mcp/mcp', origin);
    if (url.origin !== origin.origin) throw new Error('shared_mcp_loopback_required');
    url.searchParams.set('shared', '1');
    if (family && pluginPath === undefined) url.searchParams.set('family', family);
    const { command: _command, args: _args, cwd: _cwd, env: _env, env_vars: _inherited, ...settings } = server;
    entries.push([
      name,
      {
        ...settings,
        type: 'http',
        url: url.href,
        headers: {
          'x-invocation-id': credentials.invocationId,
          'x-callback-token': credentials.callbackToken,
          'x-mcp-connection-id': randomUUID(),
        },
      },
    ]);
  }
  return Object.fromEntries(entries);
}
