import type { AgentCarrierSession, ProviderCompactionObservation } from '../../types.js';
import {
  asCodexAppServerRecord,
  type CodexAppServerJsonObject,
  codexAppServerErrorMessage,
  mapCodexAppServerCompactionObservation,
  respondToCodexAppServerRequest,
} from './CodexAppServerEventMapper.js';
import { CodexAppServerRpcError } from './codex-app-server-rpc-error.js';

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface CompactionSettlement {
  candidate: { observation: ProviderCompactionObservation; turnId: string } | null;
  readonly terminalStatusByTurnId: Map<string, string>;
  readonly resolve: (value: ProviderCompactionObservation) => void;
  readonly reject: (error: Error) => void;
}

type ControlWrite = (message: CodexAppServerJsonObject) => Promise<void>;

export async function requestCodexAppServerCompaction(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly timeoutMs: number;
}): Promise<ProviderCompactionObservation> {
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  let resolveSettlement!: (value: ProviderCompactionObservation) => void;
  let rejectSettlement!: (error: Error) => void;
  const settledCompaction = new Promise<ProviderCompactionObservation>((resolve, reject) => {
    resolveSettlement = resolve;
    rejectSettlement = reject;
  });
  const settlement: CompactionSettlement = {
    candidate: null,
    terminalStatusByTurnId: new Map(),
    resolve: resolveSettlement,
    reject: rejectSettlement,
  };

  const write = (message: CodexAppServerJsonObject): Promise<void> => input.wire.write(message);
  const request = (method: string, params: CodexAppServerJsonObject): Promise<unknown> => {
    const id = nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => pending.set(id, { method, resolve, reject }));
    void response.catch(() => {});
    return write({ id, method, params }).then(() => response);
  };
  const pump = pumpControlMessages({
    wire: input.wire,
    threadId: input.threadId,
    pending,
    write,
    settlement,
  }).catch((error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectSettlement(failure);
    rejectPendingRequests(pending, failure);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('authoritative_compaction_observation_timeout')),
      Math.max(1, input.timeoutMs),
    );
    timer.unref?.();
  });
  const timedSettlement = Promise.race([settledCompaction, deadline]);
  // The provider may close or the shared deadline may fire while initialize is
  // still pending. Install a handler before awaiting either RPC so that the
  // observation rejection cannot become process-fatal in that window.
  void timedSettlement.catch(() => {});
  const requestBeforeDeadline = (method: string, params: CodexAppServerJsonObject): Promise<unknown> =>
    Promise.race([request(method, params), deadline]);

  try {
    await requestBeforeDeadline('initialize', {
      clientInfo: { name: 'cat-cafe', title: 'Clowder AI native session control', version: '1' },
      capabilities: {},
    });
    await write({ method: 'initialized' });
    const resumeResult = await requestBeforeDeadline('thread/resume', { threadId: input.threadId });
    assertRejoinedThread(resumeResult, input.threadId);
    await requestBeforeDeadline('thread/compact/start', { threadId: input.threadId });
    return await timedSettlement;
  } finally {
    if (timer) clearTimeout(timer);
    await input.wire.close().catch(async () => input.wire.terminate?.());
    await pump.catch(() => {});
    const closed = new Error('authoritative_compaction_control_closed');
    rejectPendingRequests(pending, closed);
  }
}

function assertRejoinedThread(result: unknown, expectedThreadId: string): void {
  const resultRecord = asCodexAppServerRecord(result);
  const threadRecord = asCodexAppServerRecord(resultRecord?.thread);
  if (threadRecord?.id !== expectedThreadId) {
    throw new Error('authoritative_compaction_rejoin_mismatch');
  }
}

async function pumpControlMessages(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly pending: Map<number, PendingRequest>;
  readonly write: ControlWrite;
  readonly settlement: CompactionSettlement;
}): Promise<void> {
  for await (const value of input.wire.read()) {
    const message = asCodexAppServerRecord(value);
    if (message) await handleControlMessage(message, input);
  }
  const closed = new Error('authoritative_compaction_stream_closed');
  input.settlement.reject(closed);
  rejectPendingRequests(input.pending, closed);
}

async function handleControlMessage(
  message: CodexAppServerJsonObject,
  input: {
    readonly threadId: string;
    readonly pending: Map<number, PendingRequest>;
    readonly write: ControlWrite;
    readonly settlement: CompactionSettlement;
  },
): Promise<void> {
  if (settlePendingRequest(message, input.pending)) return;
  if (await respondToServerRequest(message, input.write)) return;
  observeBoundCompaction(message, input.threadId, input.settlement);
  observeBoundCompactionTurnSettlement(message, input.threadId, input.settlement);
}

function rejectPendingRequests(pending: Map<number, PendingRequest>, error: Error): void {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

function settlePendingRequest(message: CodexAppServerJsonObject, pending: Map<number, PendingRequest>): boolean {
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
  const errorRecord = asCodexAppServerRecord(message.error);
  waiter.reject(
    new CodexAppServerRpcError({
      method: waiter.method,
      message: codexAppServerErrorMessage(message.error),
      ...(typeof errorRecord?.code === 'number' ? { code: errorRecord.code } : {}),
    }),
  );
  return true;
}

async function respondToServerRequest(message: CodexAppServerJsonObject, write: ControlWrite): Promise<boolean> {
  if (typeof message.id !== 'number' || typeof message.method !== 'string') return false;
  const response = respondToCodexAppServerRequest(message);
  if (response) await write(response);
  return true;
}

function observeBoundCompaction(
  message: CodexAppServerJsonObject,
  threadId: string,
  settlement: CompactionSettlement,
): void {
  const mapped = mapCodexAppServerCompactionObservation(message);
  if (mapped?.runtimeSessionId !== threadId) return;
  const params = asCodexAppServerRecord(message.params);
  if (typeof params?.turnId !== 'string' || !params.turnId) return;
  settlement.candidate = { observation: mapped, turnId: params.turnId };
  settleCompactionWhenTurnCompleted(settlement);
}

function observeBoundCompactionTurnSettlement(
  message: CodexAppServerJsonObject,
  threadId: string,
  settlement: CompactionSettlement,
): void {
  if (message.method !== 'turn/completed') return;
  const params = asCodexAppServerRecord(message.params);
  const turn = asCodexAppServerRecord(params?.turn);
  if (params?.threadId !== threadId || typeof turn?.id !== 'string' || typeof turn.status !== 'string') return;
  settlement.terminalStatusByTurnId.set(turn.id, turn.status);
  settleCompactionWhenTurnCompleted(settlement);
}

function settleCompactionWhenTurnCompleted(settlement: CompactionSettlement): void {
  if (!settlement.candidate) return;
  const status = settlement.terminalStatusByTurnId.get(settlement.candidate.turnId);
  if (!status) return;
  if (status !== 'completed') {
    settlement.reject(new Error(`authoritative_compaction_turn_failed:${status}`));
    return;
  }
  settlement.resolve(settlement.candidate.observation);
}
