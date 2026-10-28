import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
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
type Server = Record<string, unknown>;

function environment(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

/** A name is not authority. Only this installation's genuine Node entrypoint is managed. */
function installedFamily(server: Server): string | undefined {
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
  try {
    if (realpathSync(server.command) !== realpathSync(process.execPath)) return undefined;
    const target = realpathSync(resolve(typeof server.cwd === 'string' ? server.cwd : process.cwd(), args[0]));
    const name = basename(target);
    if (!['index.js', ...CAT_CAFE_SPLIT_ENTRYPOINTS.values()].includes(name)) return undefined;
    if (target !== realpathSync(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)))) return undefined;
    return name === 'index.js' ? '' : name.slice(0, -3);
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

function launchCredentials(callback: Record<string, string>, server: Server) {
  const env = { ...environment(server.env), ...callback };
  const path = env.CAT_CAFE_CREDENTIAL_FILE;
  if (!path || !env.CAT_CAFE_INVOCATION_ID) throw new Error('shared_mcp_launch_binding_unavailable');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error('shared_mcp_launch_credentials_invalid');
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
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
export function materializeNativeMcpHttp(
  servers: Record<string, Server>,
  callback: Record<string, string>,
): Record<string, Server> {
  if (callback.CAT_CAFE_MCP_TRANSPORT !== 'shared') return servers;
  let credentials: ReturnType<typeof launchCredentials> | undefined;
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const family = installedFamily(server);
      if (family === undefined) return [name, server];
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
      credentials ??= launchCredentials(callback, server);
      const url = new URL('/api/member-mcp/mcp', origin);
      url.searchParams.set('shared', '1');
      if (family) url.searchParams.set('family', family);
      const { command: _command, args: _args, cwd: _cwd, env: _env, env_vars: _inherited, ...settings } = server;
      return [
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
      ];
    }),
  );
}
