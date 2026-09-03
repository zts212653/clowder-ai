import type { AgentCarrierSession } from '../../types.js';
import {
  asCodexAppServerRecord,
  type CodexAppServerJsonObject,
  codexAppServerErrorMessage,
  respondToCodexAppServerRequest,
} from './CodexAppServerEventMapper.js';
import { CodexAppServerRpcError } from './codex-app-server-rpc-error.js';

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface CodexAppServerNativeRpcClient {
  request(method: string, params: CodexAppServerJsonObject): Promise<unknown>;
}

/** One bounded, exact-runtime app-server control session shared by Phase C controls. */
export async function runCodexAppServerNativeRpc<T>(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly timeoutMs: number;
  readonly run: (client: CodexAppServerNativeRpcClient, resumed: unknown) => Promise<T>;
  readonly onNotification?: (message: CodexAppServerJsonObject) => void | Promise<void>;
}): Promise<T> {
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  let rejectStream!: (error: Error) => void;
  const streamFailure = new Promise<never>((_, reject) => {
    rejectStream = reject;
  });
  void streamFailure.catch(() => {});

  const write = (message: CodexAppServerJsonObject): Promise<void> => input.wire.write(message);
  const request = (method: string, params: CodexAppServerJsonObject): Promise<unknown> => {
    const id = nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => pending.set(id, { method, resolve, reject }));
    void response.catch(() => {});
    return write({ id, method, params }).then(() => response);
  };

  const pump = pumpNativeRpcMessages({
    wire: input.wire,
    pending,
    write,
    rejectStream,
    onNotification: input.onNotification,
  }).catch((error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectStream(failure);
    rejectPending(pending, failure);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('authoritative_native_rpc_timeout')), Math.max(1, input.timeoutMs));
    timer.unref?.();
  });
  const bounded = <V>(operation: Promise<V>): Promise<V> => Promise.race([operation, deadline, streamFailure]);

  try {
    await bounded(
      request('initialize', {
        clientInfo: { name: 'cat-cafe', title: 'Clowder AI native thread controls', version: '1' },
        capabilities: {},
      }),
    );
    await write({ method: 'initialized' });
    const resumed = await bounded(request('thread/resume', { threadId: input.threadId }));
    assertRejoinedThread(resumed, input.threadId);
    return await bounded(input.run({ request: (method, params) => bounded(request(method, params)) }, resumed));
  } finally {
    if (timer) clearTimeout(timer);
    await input.wire.close().catch(async () => input.wire.terminate?.());
    await pump.catch(() => {});
    rejectPending(pending, new Error('authoritative_native_rpc_closed'));
  }
}

function assertRejoinedThread(result: unknown, expectedThreadId: string): void {
  const thread = asCodexAppServerRecord(asCodexAppServerRecord(result)?.thread);
  if (thread?.id !== expectedThreadId) throw new Error('authoritative_native_rpc_rejoin_mismatch');
}

async function pumpNativeRpcMessages(input: {
  readonly wire: AgentCarrierSession;
  readonly pending: Map<number, PendingRequest>;
  readonly write: (message: CodexAppServerJsonObject) => Promise<void>;
  readonly rejectStream: (error: Error) => void;
  readonly onNotification?: (message: CodexAppServerJsonObject) => void | Promise<void>;
}): Promise<void> {
  for await (const value of input.wire.read()) {
    const message = asCodexAppServerRecord(value);
    if (!message) continue;
    if (settlePending(message, input.pending)) continue;
    if (await respondToServerRequest(message, input.write)) continue;
    await input.onNotification?.(message);
  }
  const closed = new Error('authoritative_native_rpc_stream_closed');
  input.rejectStream(closed);
  rejectPending(input.pending, closed);
}

function settlePending(message: CodexAppServerJsonObject, pending: Map<number, PendingRequest>): boolean {
  if (typeof message.id !== 'number' || !(Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    return false;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return true;
  pending.delete(message.id);
  if (!Object.hasOwn(message, 'error')) {
    waiter.resolve(message.result);
    return true;
  }
  const error = asCodexAppServerRecord(message.error);
  waiter.reject(
    new CodexAppServerRpcError({
      method: waiter.method,
      message: codexAppServerErrorMessage(message.error),
      ...(typeof error?.code === 'number' ? { code: error.code } : {}),
    }),
  );
  return true;
}

async function respondToServerRequest(
  message: CodexAppServerJsonObject,
  write: (message: CodexAppServerJsonObject) => Promise<void>,
): Promise<boolean> {
  if (typeof message.id !== 'number' || typeof message.method !== 'string') return false;
  const response = respondToCodexAppServerRequest(message);
  if (response) await write(response);
  return true;
}

function rejectPending(pending: Map<number, PendingRequest>, error: Error): void {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}
