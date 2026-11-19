import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { respondToAcpPermission } from '@clowder-ai/agent-access/runtime/acp/permissions/acp-permission-response';
import { ACP_METHODS, type AcpAgentRequest, type AgentAccessAcpOutputFrame } from '@clowder-ai/agent-contract/acp';
import {
  DSH_TURN_METHODS,
  type DshTurnBridgeEvent,
  parseDshTurnBridgeEvent,
} from '@clowder-ai/agent-contract/dsh-turn';
import { z } from 'zod';
import type {
  AcpPermissionHandler,
  AcpSessionRequestHandler,
} from '../../cats/services/agents/providers/acp/AcpClient.js';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';

const agentRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  params: z.record(z.unknown()).default({}),
});

/** Agent-initiated requests execute on the Host under the registered session's authority. */
export function createNativeAcpRequests(input: {
  defaultDecision?: 'allow' | 'reject';
  defaultHandler?: AcpPermissionHandler;
  write: (line: string) => Promise<void>;
  onWriteError: (error: unknown) => void;
  knownCredentials: readonly string[];
  onDshTurnEvent?: (event: DshTurnBridgeEvent) => void;
}) {
  const permissions = new Map<string, AcpPermissionHandler>();
  const requests = new Map<string, AcpSessionRequestHandler>();
  const write = (value: unknown) => input.write(JSON.stringify(value) + '\n');
  return {
    setSessionPermissionHandler(sessionId: string, handler?: AcpPermissionHandler) {
      if (!handler) {
        permissions.delete(sessionId);
        return;
      }
      const run = AsyncLocalStorage.snapshot();
      permissions.set(sessionId, (...args) => run(handler, ...args));
    },
    setSessionRequestHandler(sessionId: string, handler?: AcpSessionRequestHandler) {
      if (!handler) {
        requests.delete(sessionId);
        return;
      }
      const run = AsyncLocalStorage.snapshot();
      requests.set(sessionId, (request) => run(handler, request));
    },
    project(stdout: Readable, framed = false) {
      return Readable.from(
        (async function* (): AsyncGenerator<AgentAccessAcpOutputFrame> {
          const readline = framed ? undefined : createInterface({ input: stdout, crlfDelay: Infinity });
          const frames = readline ?? (stdout as AsyncIterable<AgentAccessAcpOutputFrame>);
          try {
            for await (const frame of frames) {
              if (typeof frame !== 'string' && frame.kind === 'request_error') {
                yield { ...frame, message: String(sanitizeRawEvent(frame.message, input.knownCredentials)) };
                continue;
              }
              const line = typeof frame === 'string' ? frame : frame.line;
              let decoded: unknown;
              try {
                decoded = JSON.parse(line);
              } catch {
                continue;
              }
              const message = agentRequestSchema.safeParse(decoded);
              if (message.success && message.data.id == null && message.data.method === DSH_TURN_METHODS.event) {
                const event = parseDshTurnBridgeEvent(message.data.params);
                if (event) input.onDshTurnEvent?.(event);
                continue;
              }
              if (
                !message.success ||
                (message.data.id == null && message.data.method !== ACP_METHODS.requestPermission)
              ) {
                yield { kind: 'line', line: JSON.stringify(sanitizeRawEvent(decoded, input.knownCredentials)) };
                continue;
              }
              const { method, params, id } = message.data;
              const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
              if (method === ACP_METHODS.requestPermission) {
                const request = { ...message.data, id: id ?? `synth-perm-${Date.now()}` } as AcpAgentRequest;
                const handler = permissions.get(sessionId);
                void respondToAcpPermission({
                  request,
                  handler: handler ?? input.defaultHandler,
                  defaultDecision: input.defaultDecision,
                  write(response) {
                    return write(
                      permissions.get(sessionId) === handler
                        ? response
                        : { jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } },
                    );
                  },
                }).catch(input.onWriteError);
                if (id == null) {
                  yield {
                    kind: 'line',
                    line: JSON.stringify({
                      jsonrpc: '2.0',
                      method: ACP_METHODS.sessionUpdate,
                      params: { sessionId, sessionUpdate: 'permission_pending' },
                    }),
                  };
                }
                continue;
              }
              const handler = method === ACP_METHODS.chrysRequestInput ? requests.get(sessionId) : undefined;
              if (handler) {
                void Promise.resolve()
                  .then(() => handler(message.data as AcpAgentRequest))
                  .then(
                    (result) => write({ jsonrpc: '2.0', id, result }),
                    (error: unknown) =>
                      write({
                        jsonrpc: '2.0',
                        id,
                        error: {
                          code: -32603,
                          message: `request_input handler error: ${error instanceof Error ? error.message : String(error)}`,
                        },
                      }),
                  )
                  .catch(input.onWriteError);
              } else {
                const error =
                  method === ACP_METHODS.chrysRequestInput
                    ? { code: -32603, message: `No request handler for session ${sessionId || '<missing>'}` }
                    : { code: -32601, message: `Client does not handle ${method}` };
                void write({ jsonrpc: '2.0', id, error }).catch(input.onWriteError);
              }
            }
          } finally {
            readline?.close();
          }
        })(),
        { objectMode: true, highWaterMark: 1 },
      );
    },
  };
}
