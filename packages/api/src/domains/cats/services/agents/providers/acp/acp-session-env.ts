import { pluginMcpEnvironment } from '../../../../../../config/capabilities/plugin-mcp-environment.js';
import { guardMcpConfig } from '../../../../../../config/capabilities/secret-mcp-config.js';
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
  const resolved = baseServers.map((server) => {
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
  const proxyEnv = credentialFileOnly
    ? Object.fromEntries(
        Object.entries(callbackEnv ?? {}).filter(
          ([key]) => key !== 'CAT_CAFE_INVOCATION_ID' && key !== 'CAT_CAFE_CALLBACK_TOKEN',
        ),
      )
    : callbackEnv;
  return resolved.map((server): AcpMcpServerStdio => {
    const record =
      'command' in server
        ? {
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
          }
        : {
            url: server.url,
            headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
            transport: server.type,
          };
    const guarded = guardMcpConfig(record, proxyEnv, undefined, server.name);
    return {
      name: server.name,
      command: String(guarded.command),
      args: guarded.args as string[],
      env: Object.entries(guarded.env as Record<string, string>).map(([name, value]) => ({ name, value })),
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

/** Result of routing a member's MCP servers onto the iCode transport. */
export interface IcodeMcpMaterialization {
  /** Servers to pass into session/new and session/load for this turn. */
  servers: AcpMcpServer[];
  /** cat-cafe builtin servers routed through the member gateway overlay. */
  gatewayRouted: string[];
  /** Non-cat-cafe stdio servers dropped because iCode rejects stdio injection. */
  droppedStdio: string[];
}

/**
 * F306 Phase B — iCode transport materialization.
 *
 * iCode rejects client-injected stdio MCP servers, so the member's cat-cafe
 * tool families are routed through the in-API member gateway as a single HTTP
 * overlay carrying THIS turn's invocation credentials. Remote (http/sse)
 * servers configured by the project pass through; stdio servers that are not
 * cat-cafe builtins cannot be routed yet and are reported (never silently
 * dropped) so a missing tool cannot be mistaken for a working one.
 */
export function materializeIcodeSessionMcpServers(
  baseServers: AcpMcpServer[],
  callbackEnv?: Record<string, string>,
): IcodeMcpMaterialization {
  const externals: AcpMcpServer[] = [];
  const catCafeBuiltins: string[] = [];
  const droppedStdio: string[] = [];

  for (const server of baseServers) {
    if (isCatCafeStdioServer(server)) {
      catCafeBuiltins.push(server.name);
      continue;
    }
    if ('command' in server) {
      // Stdio server that is not a cat-cafe builtin — iCode cannot take it.
      droppedStdio.push(server.name);
      continue;
    }
    externals.push(server);
  }

  const apiUrl = callbackEnv?.CAT_CAFE_API_URL;
  const invocationId = callbackEnv?.CAT_CAFE_INVOCATION_ID;
  const callbackToken = callbackEnv?.CAT_CAFE_CALLBACK_TOKEN;
  const overlay: AcpMcpServer[] =
    catCafeBuiltins.length > 0 && apiUrl && invocationId && callbackToken
      ? [
          {
            type: 'http',
            name: 'cat-cafe-member',
            url: `${apiUrl.replace(/\/+$/, '')}/api/member-mcp/mcp`,
            headers: [
              { name: 'x-invocation-id', value: invocationId },
              { name: 'x-callback-token', value: callbackToken },
            ],
          },
        ]
      : [];

  return { servers: [...externals, ...overlay], gatewayRouted: catCafeBuiltins, droppedStdio };
}
