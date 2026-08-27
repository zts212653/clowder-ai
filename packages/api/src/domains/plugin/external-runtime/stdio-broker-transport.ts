import {
  DEADLINE_EXPIRED_CODE,
  DEADLINE_EXPIRED_MESSAGE,
  DOMAIN_ERROR_CODE,
  DOMAIN_ERROR_MESSAGE,
  ERROR_CODE_TO_MESSAGE,
  HANDSHAKE_REJECTED_CODE,
  INTERNAL_ERROR_CODE,
  INVALID_PARAMS_CODE,
  type M0CDeliverInput,
  type M0CDeliverResult,
  MESSAGING_ROW_METHODS,
  PARSE_ERROR_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  SNAPSHOT_UNAVAILABLE_MESSAGE,
  validateMessagingRowInput,
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
import { MessagingError, SnapshotUnavailableHostError } from '../../messaging/contract/host-types.js';
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
  call(method: 'host.messaging.deliver', input: M0CDeliverInput): Promise<M0CDeliverResult>;
  close(): void;
}

interface PendingHostCall {
  readonly method: 'host.lifecycle.ping' | 'host.messaging.deliver';
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
const PLUGIN_TO_HOST_MESSAGING_METHODS = new Set<WireMethodName>(
  MESSAGING_ROW_METHODS.filter((method) => method !== 'host.messaging.deliver'),
);

function closedHostCallError(method: PendingHostCall['method'], cause?: Error): ExternalPluginRuntimeError {
  const options = cause === undefined ? undefined : { cause };
  return method === 'host.lifecycle.ping'
    ? new ExternalPluginRuntimeError('HEARTBEAT_REJECTED', 'runtime transport closed', options)
    : new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'runtime transport closed', options);
}

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
  readonly deadlineUnixMs: number;
} {
  const value = frame.value;
  const params = value.params as { readonly meta: { readonly deadlineUnixMs: number }; readonly input: unknown };
  return {
    id: value.id as string,
    method: value.method as WireMethodName,
    input: params.input,
    deadlineUnixMs: params.meta.deadlineUnixMs,
  };
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
  if ('result' in value) pending.resolve(value.result);
  else if (pending.method === 'host.lifecycle.ping') {
    pending.reject(new ExternalPluginRuntimeError('HEARTBEAT_REJECTED', 'plugin rejected Host heartbeat'));
  } else {
    pending.reject(new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'plugin rejected Host message delivery'));
  }
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

type BrokerFailure = { readonly response: JsonObject; readonly close: boolean };

function hostBrokerFailureResponse(id: string, method: WireMethodName, error: HostBrokerError): BrokerFailure {
  if (method === 'broker.hello' || method === 'broker.ready') {
    return { response: handshakeError(id, error), close: true };
  }
  if (error.code === 'INVALID_CALL_INPUT' || error.code === 'METHOD_NOT_READY') {
    return { response: standardError(id, INVALID_PARAMS_CODE), close: false };
  }
  if (error.code === 'CAPABILITY_DENIED') {
    if (PLUGIN_TO_HOST_MESSAGING_METHODS.has(method)) {
      return {
        response: {
          jsonrpc: '2.0',
          id,
          error: { code: DOMAIN_ERROR_CODE, message: DOMAIN_ERROR_MESSAGE, data: { code: 'PERMISSION' } },
        },
        close: false,
      };
    }
    return { response: standardError(id, INVALID_PARAMS_CODE), close: false };
  }
  if (error.code === 'AUTHORITY_CHANGED' || error.code === 'SESSION_NOT_ACTIVE' || error.code === 'SESSION_NOT_FOUND') {
    return { response: standardError(id, INTERNAL_ERROR_CODE), close: true };
  }
  return { response: standardError(id, INTERNAL_ERROR_CODE), close: false };
}

function brokerFailureResponse(id: string, method: WireMethodName, error: unknown): BrokerFailure {
  if (error instanceof SnapshotUnavailableHostError) {
    return {
      response: {
        jsonrpc: '2.0',
        id,
        error: {
          code: SNAPSHOT_UNAVAILABLE_CODE,
          message: SNAPSHOT_UNAVAILABLE_MESSAGE,
          data: { reason: error.reason },
        },
      },
      close: false,
    };
  }
  if (error instanceof MessagingError) {
    return {
      response: {
        jsonrpc: '2.0',
        id,
        error: { code: DOMAIN_ERROR_CODE, message: DOMAIN_ERROR_MESSAGE, data: { code: error.code } },
      },
      close: false,
    };
  }
  if (error instanceof HostBrokerError) {
    return hostBrokerFailureResponse(id, method, error);
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

  const rejectPendingHostCalls = (cause: Error): void => {
    for (const [id, pending] of pendingHostCalls) {
      clearTimeout(pending.timer);
      pending.reject(closedHostCallError(pending.method, cause));
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
    const { id, method, input, deadlineUnixMs } = requestParts(frame);
    if (now() >= deadlineUnixMs) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: DEADLINE_EXPIRED_CODE, message: DEADLINE_EXPIRED_MESSAGE, data: {} },
      };
    }
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
      const cause = error.cause instanceof Error ? error.cause : error;
      rejectPendingHostCalls(cause);
      options.onFatal(cause);
    },
  });

  const sendHostRequest = <Result>(
    method: 'host.lifecycle.ping' | 'host.messaging.deliver',
    requestInput: JsonObject | ((id: string) => JsonObject),
  ): Promise<Result> => {
    if (closing) {
      return Promise.reject(closedHostCallError(method));
    }
    hostRequestSequence += 1;
    const id = `host-call-${hostRequestSequence}`;
    const input = typeof requestInput === 'function' ? requestInput(id) : requestInput;
    const result = new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingHostCalls.delete(id);
        inFlight.delete(id);
        reject(
          new ExternalPluginRuntimeError(
            method === 'host.lifecycle.ping' ? 'HEARTBEAT_TIMEOUT' : 'DELIVERY_REJECTED',
            method === 'host.lifecycle.ping'
              ? 'plugin missed the Host heartbeat deadline'
              : 'plugin missed the Host delivery deadline',
          ),
        );
      }, heartbeatTimeoutMs);
      timer.unref();
      pendingHostCalls.set(id, { method, resolve: (value) => resolve(value as Result), reject, timer });
      inFlight.set(id, {
        method,
        requestSnapshot:
          method === 'host.lifecycle.ping'
            ? { nonce: input.nonce as string }
            : { deliveryId: input.deliveryId as string },
      });
    });
    void channel
      .send({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          meta: { deadlineUnixMs: now() + heartbeatTimeoutMs },
          input,
        },
      })
      .catch((error: unknown) => {
        const pending = pendingHostCalls.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pendingHostCalls.delete(id);
        inFlight.delete(id);
        const cause = error instanceof Error ? error : new Error('Host request write failed');
        pending.reject(closedHostCallError(pending.method, cause));
      });
    return result;
  };
  const ping = async (): Promise<void> => {
    await sendHostRequest<{ nonce: string }>('host.lifecycle.ping', (id) => ({ nonce: id }));
  };
  return {
    ping,
    call: (method, input) => {
      const validation = validateMessagingRowInput(method, input);
      if (!validation.valid) {
        return Promise.reject(new TypeError(`${method} input failed the published contract`));
      }
      return sendHostRequest<M0CDeliverResult>(method, validation.value as unknown as JsonObject);
    },
    close: () => {
      closing = true;
      for (const [id, pending] of pendingHostCalls) {
        clearTimeout(pending.timer);
        pending.reject(closedHostCallError(pending.method));
        pendingHostCalls.delete(id);
        inFlight.delete(id);
      }
      channel.close();
    },
  };
}
