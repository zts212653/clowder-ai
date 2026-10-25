import { realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAT_CAFE_SPLIT_ENTRYPOINTS, MCP_CALLBACK_ENV_KEYS } from './mcp-launch-contract.js';
import { secretMcpProxyPath } from './secret-runtime.js';

const HOST_CALLBACK_KEYS = [
  ...MCP_CALLBACK_ENV_KEYS,
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_CONNECTION_ID',
] as const;
const SPEC_KEY = 'CAT_CAFE_SECRET_MCP_PROXY_SPEC';

function environment(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

function bindManagedCallback(spec: Record<string, unknown>, callback: Record<string, string>) {
  // Names and path suffixes are user-controlled. Only this installed package's
  // real entrypoint under the same Node executable can inherit host authority.
  const args = spec.args;
  if (typeof spec.command !== 'string' || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string')
    return spec;
  const original = environment(spec.env);
  // An otherwise genuine entrypoint with user preload/search-path settings is
  // still an external launch. Never give that code the proxy's callback scope.
  const allowedEnv = new Set<string>([...HOST_CALLBACK_KEYS, 'ALLOWED_WORKSPACE_DIRS']);
  if (Object.keys(original).some((key) => !allowedEnv.has(key))) return spec;
  try {
    if (realpathSync(spec.command) !== realpathSync(process.execPath)) return spec;
    const target = realpathSync(resolve(typeof spec.cwd === 'string' ? spec.cwd : process.cwd(), args[0]));
    const name = basename(target);
    if (!['index.js', ...CAT_CAFE_SPLIT_ENTRYPOINTS.values()].includes(name)) return spec;
    if (target !== realpathSync(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)))) return spec;
  } catch {
    return spec;
  }
  const env = {
    ...original,
    ...callback,
  };
  if (env.CAT_CAFE_CREDENTIAL_FILE || env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
    delete env.CAT_CAFE_INVOCATION_ID;
    delete env.CAT_CAFE_CALLBACK_TOKEN;
  }
  return { ...spec, env };
}

function callbackEnvironment(original: Record<string, string>, current: Record<string, string>) {
  const env = Object.fromEntries(
    HOST_CALLBACK_KEYS.flatMap((key) => (current[key] || original[key] ? [[key, current[key] || original[key]]] : [])),
  );
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
  const originalEnv = { ...environment(server.env) };
  const callback = callbackEnvironment(originalEnv, callbackEnv);
  if (callback.CAT_CAFE_CREDENTIAL_FILE || callback.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
    delete originalEnv.CAT_CAFE_CALLBACK_TOKEN;
    delete originalEnv.CAT_CAFE_INVOCATION_ID;
  }
  if (Array.isArray(server.args) && server.args.includes(proxy) && originalEnv[SPEC_KEY]) {
    const spec = bindManagedCallback(JSON.parse(originalEnv[SPEC_KEY]) as Record<string, unknown>, callback);
    return { ...server, env: { ...callback, [SPEC_KEY]: JSON.stringify(spec) } };
  }
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
        env: originalEnv,
      };
  const inherited = Array.isArray(server.env_vars) ? server.env_vars : [];
  return {
    ...rest,
    command: nodeCommand,
    args: [proxy],
    env: { ...callback, [SPEC_KEY]: JSON.stringify({ ...bindManagedCallback(spec, callback), source }) },
    ...(typeof bearer_token_env_var === 'string'
      ? { env_vars: [...new Set([...inherited, bearer_token_env_var])] }
      : {}),
  };
}
