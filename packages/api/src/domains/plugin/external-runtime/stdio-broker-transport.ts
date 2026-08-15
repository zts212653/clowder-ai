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
}

export interface ExternalStdioBrokerTransport {
  close(): void;
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
} {
  const value = frame.value;
  const params = value.params as { readonly input: unknown };
  return { id: value.id as string, method: value.method as WireMethodName, input: params.input };
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
  let channel: StdioChannel;
  let closing = false;

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
    const { id, method, input } = requestParts(frame);
    inFlight.set(id, { method });
    try {
      const result = await invokeBroker(options.connection, method, input, options.onReady);
      return { jsonrpc: '2.0', id, result } as JsonObject;
    } catch (error) {
      const failure = brokerFailureResponse(id, method, error);
      return failure.close
        ? closeAfterResponse(failure.response, error instanceof Error ? error : new Error('Broker request failed'))
        : failure.response;
    } finally {
      inFlight.delete(id);
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
      options.onFatal(error);
    },
  });
  return {
    close: () => {
      closing = true;
      channel.close();
    },
  };
}
