import { resolveEnvReferences } from '../../utils/env-references.js';

/** Invocation credentials belong to the native MCP transport, never its tool arguments. */
const TRANSPORT_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_CONNECTION_ID',
] as const;

export function pluginMcpEnvironment(
  server: { readonly source?: string; readonly env?: Record<string, string> },
  invocationEnvironment: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const env = server.env ? resolveEnvReferences(server.env) : undefined;
  if (server.source !== 'plugin' || !env?.CLOWDER_PLUGIN_ACTION_TOKEN) return env;
  return bindPluginMcpEnvironment(env, invocationEnvironment);
}

/** Bind current transport credentials without re-expanding an admitted environment. */
export function bindPluginMcpEnvironment(
  environment: Record<string, string>,
  invocationEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = { ...environment };
  for (const key of TRANSPORT_KEYS) {
    delete env[key];
    const value = invocationEnvironment[key];
    if (value) env[key] = value;
  }
  return env;
}
