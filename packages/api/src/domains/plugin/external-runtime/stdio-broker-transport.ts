import {
  ERROR_CODE_TO_MESSAGE,
  HANDSHAKE_REJECTED_CODE,
  INTERNAL_ERROR_CODE,
  INVALID_PARAMS_CODE,
  PARSE_ERROR_CODE,
  type WireMethodName,
} from '@clowder-ai/plugin-contract';
import {
  classifyFrame,
  createStdioChannel,
  type InFlightEntry,
  type JsonObject,
  type StdioChannel,
  type StdioFrame,
} from '@clowder-ai/plugin-sdk';
import type { BrokerConnection } from '../host-broker/builtin-loopback.js';
import { HostBrokerError } from '../host-broker/types.js';
import type { ExternalPluginProcess } from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

export interface ExternalStdioBrokerTransportOptions {
  readonly process: ExternalPluginProcess;
  readonly connection: BrokerConnection;
  readonly onReady: () => void;
  readonly onFatal: (error: Error) => void;
  readonly now?: () => number;
  readonly heartbeatTimeoutMs?: number;
}

export interface ExternalStdioBrokerTransport {
  ping(): Promise<void>;
  close(): void;
}

interface PendingHostCall {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

function standardError(id: string, code: number): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message: ERROR_CODE_TO_MESSAGE[code as keyof typeof ERROR_CODE_TO_MESSAGE] },
  };
}

function handshakeError(id: string, error: HostBrokerError): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: HANDSHAKE_REJECTED_CODE,
      message: ERROR_CODE_TO_MESSAGE[HANDSHAKE_REJECTED_CODE],
      data: { reason: error.reason ?? 'AUTHORITY_VIOLATION' },
    },
  };
}

function requestParts(frame: StdioFrame): {
  readonly id: string;
  readonly method: WireMethodName;
  readonly input: unknown;
} {
  const value = frame.value;
  const params = value.params as { readonly input: unknown };
  return { id: value.id as string, method: value.method as WireMethodName, input: params.input };
}

function settleHostResponse(
  value: StdioFrame['value'],
  inFlight: Map<string, InFlightEntry>,
  pendingHostCalls: Map<string, PendingHostCall>,
): undefined {
  const id = value.id;
  if (typeof id !== 'string') {
    throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'plugin response omitted its request id');
  }
  const pending = pendingHostCalls.get(id);
  if (pending === undefined) {
    throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'plugin response has no pending Host request');
  }
  clearTimeout(pending.timer);
  pendingHostCalls.delete(id);
  inFlight.delete(id);
  if ('result' in value) pending.resolve();
  else pending.reject(new ExternalPluginRuntimeError('HEARTBEAT_REJECTED', 'plugin rejected Host heartbeat'));
  return undefined;
}

async function invokeBroker(
  connection: BrokerConnection,
  method: WireMethodName,
  input: unknown,
  onReady: () => void,
): Promise<unknown> {
  if (method === 'broker.hello') return connection.hello(input);
  if (method === 'broker.ready') {
    const result = await connection.ready(input);
    onReady();
    return result;
  }
  return connection.call(method, input);
}

function brokerFailureResponse(
  id: string,
  method: WireMethodName,
  error: unknown,
): { readonly response: JsonObject; readonly close: boolean } {
  if (error instanceof HostBrokerError) {
    if (method === 'broker.hello' || method === 'broker.ready') {
      return { response: handshakeError(id, error), close: true };
    }
    if (error.code === 'INVALID_CALL_INPUT' || error.code === 'METHOD_NOT_READY') {
      return { response: standardError(id, INVALID_PARAMS_CODE), close: false };
    }
    if (
      error.code === 'AUTHORITY_CHANGED' ||
      error.code === 'SESSION_NOT_ACTIVE' ||
      error.code === 'SESSION_NOT_FOUND'
    ) {
      return { response: standardError(id, INTERNAL_ERROR_CODE), close: true };
    }
  }
  return { response: standardError(id, INTERNAL_ERROR_CODE), close: false };
}

export function createExternalStdioBrokerTransport(
  options: ExternalStdioBrokerTransportOptions,
): ExternalStdioBrokerTransport {
  const inFlight = new Map<string, InFlightEntry>();
  const pendingHostCalls = new Map<string, PendingHostCall>();
  const now = options.now ?? Date.now;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1) {
    throw new TypeError('heartbeat timeout must be a positive safe integer');
  }
  let channel: StdioChannel;
  let closing = false;
  let hostRequestSequence = 0;

  const rejectPendingHostCalls = (error: Error): void => {
    for (const [id, pending] of pendingHostCalls) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingHostCalls.delete(id);
      inFlight.delete(id);
    }
  };

  const closeAfterResponse = async (response: JsonObject, error: Error): Promise<undefined> => {
    await channel.send(response);
    setImmediate(() => options.onFatal(error));
    return undefined;
  };

  const dispatch = async (frame: StdioFrame): Promise<JsonObject | undefined> => {
    const disposition = classifyFrame(frame, inFlight);
    if (disposition.outcome === 'close') {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `plugin frame failed closed at ${disposition.disposition}`,
      );
    }
    if (disposition.outcome === 'respond') return disposition.response;
    if (!('method' in frame.value)) {
      return settleHostResponse(frame.value, inFlight, pendingHostCalls);
    }
    const { id, method, input } = requestParts(frame);
    try {
      const result = await invokeBroker(options.connection, method, input, options.onReady);
      return { jsonrpc: '2.0', id, result } as JsonObject;
    } catch (error) {
      const failure = brokerFailureResponse(id, method, error);
      return failure.close
        ? closeAfterResponse(failure.response, error instanceof Error ? error : new Error('Broker request failed'))
        : failure.response;
    }
  };

  channel = createStdioChannel(options.process.stdout, options.process.stdin, {
    onFrame: dispatch,
    onFrameError: (error) =>
      error.code === 'INVALID_JSON'
        ? {
            jsonrpc: '2.0',
            id: null,
            error: { code: PARSE_ERROR_CODE, message: ERROR_CODE_TO_MESSAGE[PARSE_ERROR_CODE] },
          }
        : undefined,
    onFatal: (error) => {
      if (closing) return;
      rejectPendingHostCalls(error);
      options.onFatal(error);
    },
  });

  const ping = (): Promise<void> => {
    if (closing) {
      return Promise.reject(new ExternalPluginRuntimeError('HEARTBEAT_REJECTED', 'runtime transport is closed'));
    }
    hostRequestSequence += 1;
    const id = `host-ping-${hostRequestSequence}`;
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingHostCalls.delete(id);
        inFlight.delete(id);
        reject(new ExternalPluginRuntimeError('HEARTBEAT_TIMEOUT', 'plugin missed the Host heartbeat deadline'));
      }, heartbeatTimeoutMs);
      timer.unref();
      pendingHostCalls.set(id, { resolve, reject, timer });
      inFlight.set(id, { method: 'host.lifecycle.ping', requestSnapshot: { nonce: id } });
    });
    void channel
      .send({
        jsonrpc: '2.0',
        id,
        method: 'host.lifecycle.ping',
        params: {
          meta: { deadlineUnixMs: now() + heartbeatTimeoutMs },
          input: { nonce: id },
        },
      })
      .catch((error: unknown) => {
        const pending = pendingHostCalls.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pendingHostCalls.delete(id);
        inFlight.delete(id);
        pending.reject(error instanceof Error ? error : new Error('Host heartbeat write failed'));
      });
    return result;
  };
  return {
    ping,
    close: () => {
      closing = true;
      rejectPendingHostCalls(new ExternalPluginRuntimeError('HEARTBEAT_REJECTED', 'runtime transport closed'));
      channel.close();
    },
  };
}
