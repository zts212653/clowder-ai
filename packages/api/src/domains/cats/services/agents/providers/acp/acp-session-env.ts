import { randomUUID } from 'node:crypto';
import {
  bindManagedMcpStdioConfig,
  isInstalledManagedMcpServer,
  materializeNativeMcpHttp,
} from '../../../../../../config/capabilities/managed-mcp-config.js';
import { pluginMcpEnvironment } from '../../../../../../config/capabilities/plugin-mcp-environment.js';
/**
 * Per-invocation MCP server env materialization for ACP sessions.
 *
 * Static MCP configs (from .mcp.json via acp-mcp-resolver) don't carry
 * per-invocation callback env (CAT_CAFE_API_URL, token, etc.).
 * This module merges callbackEnv into genuine installed first-party and admitted native-action servers before newSession().
 */

import type { AcpMcpServer } from './types.js';

/** Callback env keys injected per-invocation into cat-cafe MCP servers. */
const _CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_SIGNAL_USER',
  // #1092: File path for credential refresh across ACP session resume.
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_MCP_TRANSPORT',
] as const;

/**
 * Materialize per-invocation MCP server configs by merging callbackEnv
 * into genuine installed first-party and admitted native-action servers. Other servers pass through unchanged.
 *
 * @returns New array (never mutates input)
 */
export function materializeSessionMcpServers(
  baseServers: AcpMcpServer[],
  callbackEnv?: Record<string, string>,
  _credentialFileOnly = false,
): AcpMcpServer[] {
  const resolved = baseServers.map((server) => {
    if (!('command' in server)) return server;
    const registered = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
    const nativeActionServer = server.hostSource === 'plugin' && Boolean(registered.CLOWDER_PLUGIN_ACTION_TOKEN);
    const env = pluginMcpEnvironment(
      { source: nativeActionServer ? 'plugin' : undefined, env: registered },
      callbackEnv ?? {},
    );
    const entries = Object.entries(env ?? {}).map(([name, value]) => ({ name, value }));
    // Only the installed-entrypoint binder below may add callback authority.
    // A foreign server cannot acquire it by reusing a cat-cafe name prefix.
    const materialized = entries;
    return {
      ...server,
      env:
        nativeActionServer && Boolean(env?.CAT_CAFE_CREDENTIAL_FILE || env?.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE)
          ? materialized.filter(
              (entry) => entry.name !== 'CAT_CAFE_INVOCATION_ID' && entry.name !== 'CAT_CAFE_CALLBACK_TOKEN',
            )
          : materialized,
    };
  });
  const records = Object.fromEntries(
    resolved.map((server) => {
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
      return [server.name, bindManagedMcpStdioConfig(record, callbackEnv)];
    }),
  );
  const native = materializeNativeMcpHttp(records, callbackEnv ?? {});
  return Object.entries(native).map(([name, record]): AcpMcpServer => {
    if (typeof record.command !== 'string')
      return {
        type: record.transport === 'sse' ? 'sse' : 'http',
        name,
        url: String(record.url),
        headers: Object.entries((record.headers ?? {}) as Record<string, string>).map(([name, value]) => ({
          name,
          value,
        })),
      };
    return {
      name,
      command: record.command,
      args: (record.args ?? []) as string[],
      env: Object.entries((record.env ?? {}) as Record<string, string>).map(([name, value]) => ({ name, value })),
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
    if (
      'command' in server &&
      isInstalledManagedMcpServer({
        command: server.command,
        args: server.args,
        env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
      })
    ) {
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
  // iCode has always consumed HTTP. Both managed transport choices preserve
  // the same scoped principal; stdio rollback applies to stdio-capable clients.
  const shared = ['shared', 'stdio'].includes(callbackEnv?.CAT_CAFE_MCP_TRANSPORT ?? '');
  const overlay: AcpMcpServer[] =
    catCafeBuiltins.length > 0 && apiUrl && invocationId && callbackToken
      ? [
          {
            type: 'http',
            name: 'cat-cafe-member',
            url: `${apiUrl.replace(/\/+$/, '')}/api/member-mcp/mcp${shared ? '?shared=1' : ''}`,
            headers: [
              { name: 'x-invocation-id', value: invocationId },
              { name: 'x-callback-token', value: callbackToken },
              ...(shared ? [{ name: 'x-mcp-connection-id', value: randomUUID() }] : []),
            ],
          },
        ]
      : [];

  return { servers: [...externals, ...overlay], gatewayRouted: catCafeBuiltins, droppedStdio };
}
