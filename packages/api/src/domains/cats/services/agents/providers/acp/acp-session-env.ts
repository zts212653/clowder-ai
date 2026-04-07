/**
 * Per-invocation MCP server env materialization for ACP sessions.
 *
 * Static MCP configs (from .mcp.json via acp-mcp-resolver) don't carry
 * per-invocation callback env (CAT_CAFE_API_URL, token, etc.).
 * This module merges callbackEnv into cat-cafe* servers before newSession().
 */

import type { AcpMcpServer, AcpMcpServerStdio } from './types.js';

/** Prefix for Clowder AI MCP servers that need callback env injection. */
const CAT_CAFE_SERVER_PREFIX = 'cat-cafe';

/** Callback env keys injected per-invocation into cat-cafe MCP servers. */
const CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_SIGNAL_USER',
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
 * into cat-cafe* servers. Non-cat-cafe servers are passed through unchanged.
 *
 * @returns New array (never mutates input)
 */
export function materializeSessionMcpServers(
  baseServers: AcpMcpServer[],
  callbackEnv?: Record<string, string>,
): AcpMcpServer[] {
  if (!callbackEnv || Object.keys(callbackEnv).length === 0) return baseServers;

  return baseServers.map((server) => {
    if (!isCatCafeStdioServer(server)) return server;
    return { ...server, env: mergeCallbackEnv(server.env, callbackEnv) };
  });
}

/** Diagnostic: which callback env keys are present (no values — security). */
export function callbackEnvDiagnostic(callbackEnv?: Record<string, string>): Record<string, boolean> {
  return {
    hasApiUrl: !!callbackEnv?.CAT_CAFE_API_URL,
    hasInvocationId: !!callbackEnv?.CAT_CAFE_INVOCATION_ID,
    hasCallbackToken: !!callbackEnv?.CAT_CAFE_CALLBACK_TOKEN,
  };
}
