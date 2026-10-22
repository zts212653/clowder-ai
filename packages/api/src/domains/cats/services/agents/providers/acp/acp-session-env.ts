import { pluginMcpEnvironment } from '../../../../../../config/capabilities/plugin-mcp-environment.js';
/**
 * Per-invocation MCP server env materialization for ACP sessions.
 *
 * Static MCP configs (from .mcp.json via acp-mcp-resolver) don't carry
 * per-invocation callback env (CAT_CAFE_API_URL, token, etc.).
 * This module merges callbackEnv into cat-cafe* and native-action servers before newSession().
 */

import type { AcpMcpServer, AcpMcpServerStdio } from './types.js';

/** Prefix for Clowder AI MCP servers that need callback env injection. */
const CAT_CAFE_SERVER_PREFIX = 'cat-cafe';

/** Callback env keys injected per-invocation into cat-cafe MCP servers. */
const CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_SIGNAL_USER',
  // #1092: File path for credential refresh across ACP session resume.
  'CAT_CAFE_CREDENTIAL_FILE',
] as const;

function isCatCafeStdioServer(server: AcpMcpServer): server is AcpMcpServerStdio {
  return (
    'command' in server &&
    (server.name === CAT_CAFE_SERVER_PREFIX || server.name.startsWith(`${CAT_CAFE_SERVER_PREFIX}-`))
  );
}

/**
 * Merge callbackEnv into a stdio server's env array.
 * Overwrites existing entries by name (e.g. replaces `${CAT_CAFE_API_URL}` placeholder).
 */
function mergeCallbackEnv(
  existingEnv: Array<{ name: string; value: string }>,
  callbackEnv: Record<string, string>,
): Array<{ name: string; value: string }> {
  const envMap = new Map(existingEnv.map((e) => [e.name, e.value]));
  for (const key of CALLBACK_ENV_KEYS) {
    if (key in callbackEnv) {
      envMap.set(key, callbackEnv[key]);
    }
  }
  return [...envMap.entries()].map(([name, value]) => ({ name, value }));
}

/**
 * Materialize per-invocation MCP server configs by merging callbackEnv
 * into cat-cafe* and native-action servers. Other servers pass through unchanged.
 *
 * @returns New array (never mutates input)
 */
export function materializeSessionMcpServers(
  baseServers: AcpMcpServer[],
  callbackEnv?: Record<string, string>,
  credentialFileOnly = false,
): AcpMcpServer[] {
  const hasCallbacks = callbackEnv && Object.keys(callbackEnv).length > 0;
  const hasReferences = baseServers.some(
    (server) => 'command' in server && (server.env ?? []).some((entry) => /\$\{[^}]+\}/.test(entry.value)),
  );
  if (!hasCallbacks && !hasReferences) return baseServers;
  return baseServers.map((server) => {
    if (!('command' in server)) return server;
    const registered = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
    const nativeActionServer = Boolean(registered.CLOWDER_PLUGIN_ACTION_TOKEN);
    const env = pluginMcpEnvironment(
      { source: nativeActionServer ? 'plugin' : undefined, env: registered },
      callbackEnv ?? {},
    );
    const entries = Object.entries(env ?? {}).map(([name, value]) => ({ name, value }));
    const materialized = isCatCafeStdioServer(server) && callbackEnv ? mergeCallbackEnv(entries, callbackEnv) : entries;
    return {
      ...server,
      env:
        credentialFileOnly && (isCatCafeStdioServer(server) || nativeActionServer)
          ? materialized.filter(
              (entry) => entry.name !== 'CAT_CAFE_INVOCATION_ID' && entry.name !== 'CAT_CAFE_CALLBACK_TOKEN',
            )
          : materialized,
    };
  });
}

/** Diagnostic: which callback env keys are present (no values — security). */
export function callbackEnvDiagnostic(callbackEnv?: Record<string, string>): Record<string, boolean> {
  return {
    hasApiUrl: !!callbackEnv?.CAT_CAFE_API_URL,
    hasInvocationId: !!callbackEnv?.CAT_CAFE_INVOCATION_ID,
    hasCallbackToken: !!callbackEnv?.CAT_CAFE_CALLBACK_TOKEN,
    hasThreadId: !!callbackEnv?.CAT_CAFE_THREAD_ID,
  };
}
