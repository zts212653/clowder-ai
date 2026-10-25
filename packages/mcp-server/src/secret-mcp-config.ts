import { join } from 'node:path';
import { secretMcpProxyPath } from './secret-runtime.js';

const HOST_CALLBACK_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_CONNECTION_ID',
] as const;
const SPEC_KEY = 'CAT_CAFE_SECRET_MCP_PROXY_SPEC';

function callbackEnvironment(original: Record<string, string>, current: Record<string, string>) {
  const env = Object.fromEntries(HOST_CALLBACK_KEYS.flatMap((key) => (current[key] ? [[key, current[key]]] : [])));
  for (const key of ['CAT_CAFE_CREDENTIAL_FILE', 'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE'] as const)
    if (original[key]) env[key] = original[key];
  if (env.CAT_CAFE_CREDENTIAL_FILE || env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
    delete env.CAT_CAFE_CALLBACK_TOKEN;
    delete env.CAT_CAFE_INVOCATION_ID;
  }
  return env;
}

/** Invocation-local transport decoration; capability discovery remains canonical. */
export function guardMcpConfig(
  server: Record<string, unknown>,
  callbackEnv: Record<string, string> = {},
  root?: string,
  source = 'external',
  nodeCommand = process.execPath,
): Record<string, unknown> {
  const proxy = root ? join(root, 'packages/mcp-server/dist/secret-mcp-proxy.js') : secretMcpProxyPath();
  const originalEnv = {
    ...(server.env && typeof server.env === 'object' && !Array.isArray(server.env)
      ? (server.env as Record<string, string>)
      : {}),
  };
  const callback = callbackEnvironment(originalEnv, callbackEnv);
  if (callback.CAT_CAFE_CREDENTIAL_FILE || callback.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
    delete originalEnv.CAT_CAFE_CALLBACK_TOKEN;
    delete originalEnv.CAT_CAFE_INVOCATION_ID;
  }
  if (Array.isArray(server.args) && server.args.includes(proxy) && originalEnv[SPEC_KEY])
    return { ...server, env: { ...originalEnv, ...callback } };
  if (server.enabled === false || (!server.command && !server.url && !server.serverUrl)) return server;
  const { command, args, cwd, url, serverUrl, headers, http_headers, bearer_token_env_var, type, transport, ...rest } =
    server;
  const spec = command
    ? { command, args, cwd, env: originalEnv }
    : {
        url: url ?? serverUrl,
        headers: headers ?? http_headers,
        bearerTokenEnvVar: bearer_token_env_var,
        transport: transport ?? type,
      };
  const inherited = Array.isArray(server.env_vars) ? server.env_vars : [];
  return {
    ...rest,
    command: nodeCommand,
    args: [proxy],
    env: { ...originalEnv, ...callback, [SPEC_KEY]: JSON.stringify({ ...spec, source }) },
    ...(typeof bearer_token_env_var === 'string'
      ? { env_vars: [...new Set([...inherited, bearer_token_env_var])] }
      : {}),
  };
}
