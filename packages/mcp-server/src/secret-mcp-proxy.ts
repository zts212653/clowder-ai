import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCError, JSONRPCMessage, JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import { runWithNativeTurnAuth } from './native-turn-auth.js';
import { blockedMcpReply, inspectMcpWire, redactMcpWire } from './secret-mcp-wire.js';
import { SecretRemoteTransport } from './secret-remote-transport.js';
import { type CredentialSources, credentialSourcesFromEnvironment } from './secret-runtime.js';
import { guardSecretToolCall } from './secret-tool-guard.js';
import {
  type InvocationCredentialValues,
  resolveInvocationCredentials,
  resolveInvocationRequestSignal,
  withInvocationCredentials,
} from './tools/invocation-auth.js';
import { isDirectExecution } from './utils/is-direct-execution.js';

export const SECRET_MCP_PROXY_SPEC = 'CAT_CAFE_SECRET_MCP_PROXY_SPEC';

/** Relay wire messages without re-owning the external server's tool registry. */
export async function startSecretMcpProxy(
  downstream: Transport,
  upstream: Transport,
  source: string = randomUUID(),
  cwd: string = process.cwd(),
  credentialSources?: CredentialSources,
  launchCredentials?: InvocationCredentialValues,
): Promise<() => Promise<void>> {
  let closing = false;
  const pending = new Map<string | number, (result: JSONRPCResponse | JSONRPCError) => void>();
  const inflight = new Set<string | number>();
  const controllers = new Map<string | number, AbortController>();
  const dispose = async () => {
    if (closing) return;
    closing = true;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    for (const [id, resolve] of pending) resolve(proxyError(id, 'MCP transport closed before completion.'));
    pending.clear();
    inflight.clear();
    await Promise.allSettled([upstream.close(), downstream.close()]);
  };
  upstream.onmessage = (message: JSONRPCMessage) => {
    if (!('method' in message) && 'id' in message && message.id !== undefined) {
      const finish = pending.get(message.id);
      if (finish) {
        pending.delete(message.id);
        finish(message);
        return;
      }
    }
    void redactMcpWire(message, source)
      .then((safe) => downstream.send(safe))
      .catch(dispose);
  };
  downstream.onmessage = (message: JSONRPCMessage) => {
    const requestId = 'method' in message && 'id' in message ? message.id : undefined;
    if (requestId !== undefined && controllers.has(requestId)) {
      void dispose();
      return;
    }
    const controller = new AbortController();
    if (requestId !== undefined) controllers.set(requestId, controller);
    void (
      launchCredentials
        ? withInvocationCredentials({ ...launchCredentials, requestSignal: controller.signal }, () =>
            receive(message, controller.signal),
          )
        : receive(message, controller.signal)
    )
      .catch(async () => {
        if (controller.signal.aborted && requestId !== undefined && !closing)
          await downstream.send(proxyError(requestId, 'MCP request cancelled.'));
        else await dispose();
      })
      .finally(() => {
        if (requestId !== undefined) {
          controllers.delete(requestId);
          inflight.delete(requestId);
        }
      });
  };
  async function receive(message: JSONRPCMessage, signal: AbortSignal) {
    const inspection = await inspectMcpWire(message);
    if (inspection.rules.length) {
      const reply = blockedMcpReply(message);
      if (reply) await downstream.send(reply);
      else await dispose(); // Notifications have no reply channel. Never forward their unsafe fields.
      return;
    }
    if (launchCredentials && 'method' in message && message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      await upstream.send(message);
      if (typeof requestId === 'string' || typeof requestId === 'number') controllers.get(requestId)?.abort();
      return;
    }
    if (!('method' in message) || !('id' in message) || message.id === undefined) {
      await upstream.send(message);
      return;
    }
    const params = message.params;
    const name = requestToolName(message.method, params);
    const requestId = message.id;
    if (inflight.has(requestId) || inflight.size >= 256) {
      void dispose();
      return;
    }
    inflight.add(requestId);
    const callArguments = message.method === 'tools/call' ? (params?.arguments ?? {}) : (params ?? {});
    let rpcError: JSONRPCError['error'] | undefined;
    const run = () =>
      guardSecretToolCall(
        name,
        callArguments,
        async (safeArgs) => {
          signal.throwIfAborted();
          const response = await new Promise<JSONRPCResponse | JSONRPCError>((resolve) => {
            pending.set(requestId, resolve);
            upstream
              .send({
                ...message,
                params:
                  message.method === 'tools/call'
                    ? { ...params, arguments: safeArgs }
                    : (safeArgs as Record<string, unknown>),
              })
              .catch(() => {
                pending.delete(requestId);
                resolve(proxyError(requestId, 'External MCP send failed.'));
              });
          });
          if ('error' in response) {
            const safe = await redactMcpWire(response, source);
            if ('error' in safe) rpcError = safe.error;
            return null;
          }
          return response.result;
        },
        `${source}:${requestId}`,
        cwd,
        credentialSources,
      );
    const result = message.method === 'tools/call' ? runWithNativeTurnAuth(params?._meta, signal, run) : run();
    await result.then((value) => {
      inflight.delete(requestId);
      if (closing) return;
      return downstream.send(
        rpcError
          ? { jsonrpc: '2.0', id: requestId, error: rpcError }
          : { jsonrpc: '2.0', id: requestId, result: value as Record<string, unknown> },
      );
    });
  }
  upstream.onclose = () => {
    void dispose();
  };
  downstream.onclose = () => {
    void dispose();
  };
  upstream.onerror = () => {
    void dispose();
  };
  downstream.onerror = () => {
    void dispose();
  };
  try {
    await upstream.start();
    await downstream.start();
  } catch (error) {
    await dispose();
    throw error;
  }
  return dispose;
}

function proxyError(id: string | number, message: string): JSONRPCError {
  return { jsonrpc: '2.0', id, error: { code: -32000, message } };
}

function requestToolName(method: string, params: Record<string, unknown> | undefined): string {
  return method === 'tools/call' && typeof params?.name === 'string'
    ? params.name
    : `mcp_${method.replaceAll('/', '_')}`;
}

export async function runSecretMcpProxyFromEnvironment() {
  const raw = process.env[SECRET_MCP_PROXY_SPEC];
  delete process.env[SECRET_MCP_PROXY_SPEC];
  if (!raw || raw.length > 1024 * 1024) throw new Error('secret_mcp_proxy_spec_unavailable');
  const spec = JSON.parse(raw) as {
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    bearerTokenEnvVar?: string;
    transport?: string;
    source?: string;
    shared?: boolean;
  };
  const headers = { ...spec.headers };
  if (spec.bearerTokenEnvVar) {
    const bearer = spec.env?.[spec.bearerTokenEnvVar] ?? process.env[spec.bearerTokenEnvVar];
    if (!bearer) throw new Error('secret_mcp_transport_auth_unavailable');
    headers.Authorization = `Bearer ${bearer}`;
  }
  // Use the same absolute coordinate for spawn and all pre-call file checks.
  const cwd = resolve(spec.cwd ?? process.cwd());
  // A one-turn Host launch pins this pair once. A resumed turn gets a new relay;
  // rereading the refresh file during send would relabel late requests.
  const launchCredentials = spec.shared ? resolveInvocationCredentials() : undefined;
  if (
    spec.shared &&
    (!process.env.CAT_CAFE_CREDENTIAL_FILE || !launchCredentials?.invocationId || !launchCredentials.callbackToken)
  )
    throw new Error('shared_mcp_launch_credentials_unavailable');
  const connectionId = randomUUID();
  const invocationId = launchCredentials?.invocationId;
  const callbackToken = launchCredentials?.callbackToken;
  const requestHeaders =
    invocationId && callbackToken
      ? () => {
          const boundHeaders: Record<string, string> = {};
          boundHeaders['x-invocation-id'] = invocationId;
          boundHeaders['x-callback-token'] = callbackToken;
          boundHeaders['x-mcp-connection-id'] = connectionId;
          return boundHeaders;
        }
      : undefined;
  const upstream = spec.url
    ? new SecretRemoteTransport(
        new URL(spec.url),
        headers,
        spec.transport,
        requestHeaders,
        launchCredentials ? resolveInvocationRequestSignal : undefined,
      )
    : new StdioClientTransport({
        command: spec.command ?? '',
        args: spec.args,
        cwd,
        env: spec.env,
        stderr: 'pipe',
      });
  if (upstream instanceof StdioClientTransport) upstream.stderr?.on('data', () => {});
  // Retain upstream credential locations as guard data, never as executable proxy environment.
  const contexts = [
    credentialSourcesFromEnvironment(process.env, process.cwd()),
    credentialSourcesFromEnvironment(spec.env ?? {}, cwd),
  ];
  const credentialSources = {
    files: contexts.flatMap((context) => context.files),
    directories: contexts.flatMap((context) => context.directories),
  };
  const dispose = await startSecretMcpProxy(
    new StdioServerTransport(),
    upstream,
    spec.source,
    cwd,
    credentialSources,
    launchCredentials,
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void dispose();
    });
}

if (isDirectExecution(import.meta.url))
  runSecretMcpProxyFromEnvironment().catch(() => {
    process.stderr.write('secret_mcp_proxy_unavailable\n');
    process.exitCode = 1;
  });
