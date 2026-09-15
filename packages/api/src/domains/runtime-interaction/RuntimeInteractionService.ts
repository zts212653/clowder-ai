import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import {
  parseRuntimeInteractionRequest,
  parseRuntimeInteractionResponse,
  redactRuntimeInteractionResponse,
} from '@cat-cafe/shared';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';

export type RuntimeInteractionErrorCode =
  | 'duplicate'
  | 'not_found'
  | 'unauthorized'
  | 'stale'
  | 'invalid_response'
  | 'unavailable';

export class RuntimeInteractionError extends Error {
  constructor(
    readonly code: RuntimeInteractionErrorCode,
    message: string,
    readonly reasonCode?: RuntimeInteractionTerminalReasonCode,
  ) {
    super(message);
    this.name = 'RuntimeInteractionError';
  }
}

export interface RuntimeInteractionCardPublisher {
  prepare(request: RuntimeInteractionRequest): Promise<RuntimeInteractionCardRef>;
  publish(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<void>;
  isLive(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<boolean>;
}

export interface RuntimeInteractionServiceDeps {
  store: RuntimeInteractionStore;
  cardPublisher: RuntimeInteractionCardPublisher;
  hostEpoch: string;
  now?: () => number;
  onRecordUpdated?: (record: RuntimeInteractionRecord) => void;
}

export interface RuntimeInteractionRespondInput {
  interactionId: string;
  ownerUserId: string;
  cardRef: RuntimeInteractionCardRef;
  response: unknown;
}

export type RuntimeInteractionRejectInput = Omit<RuntimeInteractionRespondInput, 'response'>;

interface ActiveWaiter {
  resolve(response: RuntimeInteractionResponse): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

export class RuntimeInteractionService {
  private readonly store: RuntimeInteractionStore;
  private readonly hostEpoch: string;
  private readonly now: () => number;
  private readonly waiters = new Map<string, ActiveWaiter>();

  constructor(private readonly deps: RuntimeInteractionServiceDeps) {
    this.store = deps.store;
    this.hostEpoch = deps.hostEpoch;
    this.now = deps.now ?? Date.now;
  }

  async request(
    input: RuntimeInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeInteractionResponse> {
    const request = parseRuntimeInteractionRequest(input);
    try {
      await this.store.createStaged({ request, hostEpoch: this.hostEpoch, now: this.now() });
    } catch (error) {
      throw new RuntimeInteractionError('duplicate', errorMessage(error));
    }

    const { responsePromise, waiter } = this.registerWaiter(request.interactionId, options?.signal);

    let cardRef: RuntimeInteractionCardRef;
    let pending: RuntimeInteractionRecord;
    try {
      if (options?.signal?.aborted) throw new Error(runtimeInteractionAbortReason(options.signal));
      cardRef = await this.deps.cardPublisher.prepare(request);
      if (options?.signal?.aborted) throw new Error(runtimeInteractionAbortReason(options.signal));
      const anchored = await this.store.anchor(request.interactionId, this.hostEpoch, cardRef, this.now());
      if (!anchored || anchored.status !== 'pending') throw new Error('runtime interaction could not be anchored');
      pending = anchored;
      if (options?.signal?.aborted) throw new Error(runtimeInteractionAbortReason(options.signal));
      await this.deps.cardPublisher.publish(request, cardRef);
      if (options?.signal?.aborted) throw new Error(runtimeInteractionAbortReason(options.signal));
    } catch (error) {
      const failureReason = errorMessage(error);
      const invalidationReason =
        failureReason === 'provider_cancelled' || failureReason === 'transport_lost'
          ? failureReason
          : 'surface_publication_failed';
      this.discardWaiter(request.interactionId, waiter);
      const invalidated = await this.store.invalidate({
        interactionId: request.interactionId,
        reasonCode: invalidationReason,
        now: this.now(),
      });
      if (invalidated) this.emit(invalidated);
      const terminalReason =
        invalidated?.terminal?.reasonCode ??
        (options?.signal?.aborted ? runtimeInteractionAbortReason(options.signal) : 'surface_publication_failed');
      throw new RuntimeInteractionError('unavailable', terminalReason, terminalReason);
    }

    if (this.waiters.get(request.interactionId) === waiter) this.emit(pending);
    return responsePromise;
  }

  async respond(input: RuntimeInteractionRespondInput): Promise<RuntimeInteractionRecord> {
    const record = await this.store.get(input.interactionId);
    if (!record) throw new RuntimeInteractionError('not_found', 'runtime interaction not found');
    if (record.request.owner.userId !== input.ownerUserId || !sameCard(record.cardRef, input.cardRef)) {
      throw new RuntimeInteractionError('unauthorized', 'runtime interaction is not owned by this surface');
    }
    if (record.status !== 'pending') throw new RuntimeInteractionError('stale', 'runtime interaction is not pending');

    let response: RuntimeInteractionResponse;
    try {
      response = parseRuntimeInteractionResponse(record.request, input.response);
    } catch (error) {
      throw new RuntimeInteractionError('invalid_response', errorMessage(error));
    }

    const waiter = this.waiters.get(input.interactionId);
    if (!waiter) {
      await this.invalidateOne(input.interactionId, 'transport_lost');
      throw new RuntimeInteractionError('stale', 'runtime interaction has no active provider waiter', 'transport_lost');
    }

    let canonicalCardIsLive: boolean;
    try {
      canonicalCardIsLive = await this.deps.cardPublisher.isLive(record.request, input.cardRef);
    } catch {
      throw new RuntimeInteractionError('unavailable', 'runtime interaction confirmation check unavailable; retry');
    }
    if (!canonicalCardIsLive) {
      await this.invalidateOne(input.interactionId, 'confirmation_unavailable');
      throw new RuntimeInteractionError(
        'stale',
        'runtime interaction canonical card is no longer available',
        'confirmation_unavailable',
      );
    }

    const terminal = terminalFrom(record.request, response, this.now());
    const settled = await this.store.settle({
      interactionId: input.interactionId,
      hostEpoch: this.hostEpoch,
      terminal,
      now: terminal.settledAt,
    });
    if (!settled) throw new RuntimeInteractionError('stale', 'runtime interaction was already settled');

    this.waiters.delete(input.interactionId);
    waiter.cleanup();
    this.emit(settled);
    waiter.resolve(response);
    return settled;
  }

  async reject(input: RuntimeInteractionRejectInput): Promise<RuntimeInteractionRecord> {
    const record = await this.store.get(input.interactionId);
    if (!record) throw new RuntimeInteractionError('not_found', 'runtime interaction not found');
    if (record.request.owner.userId !== input.ownerUserId || !sameCard(record.cardRef, input.cardRef)) {
      throw new RuntimeInteractionError('unauthorized', 'runtime interaction is not owned by this surface');
    }
    if (record.status !== 'pending') throw new RuntimeInteractionError('stale', 'runtime interaction is not pending');
    if (record.request.kind !== 'question') {
      throw new RuntimeInteractionError('invalid_response', 'only question interactions can use explicit rejection');
    }

    const waiter = this.waiters.get(input.interactionId);
    if (!waiter) {
      await this.invalidateOne(input.interactionId, 'transport_lost');
      throw new RuntimeInteractionError('stale', 'runtime interaction has no active provider waiter', 'transport_lost');
    }

    let canonicalCardIsLive: boolean;
    try {
      canonicalCardIsLive = await this.deps.cardPublisher.isLive(record.request, input.cardRef);
    } catch {
      throw new RuntimeInteractionError('unavailable', 'runtime interaction confirmation check unavailable; retry');
    }
    if (!canonicalCardIsLive) {
      await this.invalidateOne(input.interactionId, 'confirmation_unavailable');
      throw new RuntimeInteractionError(
        'stale',
        'runtime interaction canonical card is no longer available',
        'confirmation_unavailable',
      );
    }

    const settledAt = this.now();
    const settled = await this.store.settle({
      interactionId: input.interactionId,
      hostEpoch: this.hostEpoch,
      terminal: { status: 'declined', reasonCode: 'user_rejected', settledAt },
      now: settledAt,
    });
    if (!settled) throw new RuntimeInteractionError('stale', 'runtime interaction was already settled');

    this.waiters.delete(input.interactionId);
    waiter.cleanup();
    this.emit(settled);
    waiter.reject(new RuntimeInteractionError('stale', 'user_rejected', 'user_rejected'));
    return settled;
  }

  async invalidateInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
  ): Promise<RuntimeInteractionRecord[]> {
    const records = await this.store.invalidateByInvocation(invocationId, reasonCode, this.now());
    for (const record of records) this.finishInvalidated(record);
    return records;
  }

  async invalidateOrphansOnStartup(): Promise<RuntimeInteractionRecord[]> {
    const records = await this.store.invalidateActiveFromOtherHostEpoch(this.hostEpoch, 'host_restarted', this.now());
    for (const record of records) this.finishInvalidated(record);
    return records;
  }

  async getForOwner(interactionId: string, ownerUserId: string): Promise<RuntimeInteractionRecord | null> {
    const record = await this.store.get(interactionId);
    return record?.request.owner.userId === ownerUserId ? record : null;
  }

  private async invalidateOne(
    interactionId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
  ): Promise<RuntimeInteractionRecord | null> {
    const record = await this.store.invalidate({ interactionId, reasonCode, now: this.now() });
    if (record) this.finishInvalidated(record);
    return record;
  }

  private registerWaiter(
    interactionId: string,
    signal?: AbortSignal,
  ): { responsePromise: Promise<RuntimeInteractionResponse>; waiter: ActiveWaiter } {
    const response = deferred<RuntimeInteractionResponse>();
    void response.promise.catch(() => {});
    const abort = (): void => {
      void this.invalidateOne(interactionId, runtimeInteractionAbortReason(signal));
    };
    const waiter: ActiveWaiter = {
      resolve: response.resolve,
      reject: response.reject,
      cleanup: () => signal?.removeEventListener('abort', abort),
    };
    this.waiters.set(interactionId, waiter);
    signal?.addEventListener('abort', abort, { once: true });
    return { responsePromise: response.promise, waiter };
  }

  private discardWaiter(interactionId: string, waiter: ActiveWaiter): void {
    if (this.waiters.get(interactionId) !== waiter) return;
    this.waiters.delete(interactionId);
    waiter.cleanup();
  }

  private finishInvalidated(record: RuntimeInteractionRecord): void {
    const waiter = this.waiters.get(record.request.interactionId);
    if (waiter) {
      this.waiters.delete(record.request.interactionId);
      waiter.cleanup();
      const reasonCode = record.terminal?.reasonCode ?? 'transport_lost';
      waiter.reject(new RuntimeInteractionError('stale', reasonCode, reasonCode));
    }
    this.emit(record);
  }

  private emit(record: RuntimeInteractionRecord): void {
    this.deps.onRecordUpdated?.(record);
  }
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function terminalFrom(
  request: RuntimeInteractionRequest,
  response: RuntimeInteractionResponse,
  settledAt: number,
): RuntimeInteractionTerminal {
  if (response.kind === 'answers') {
    return {
      status: 'answered',
      reasonCode: 'answered',
      settledAt,
      response: redactRuntimeInteractionResponse(request, response),
    };
  }
  const decision =
    request.kind === 'question' ? undefined : request.decisions.find(({ id }) => id === response.decisionId);
  if (!decision) throw new RuntimeInteractionError('invalid_response', 'decision is not allowed');
  const status = decision.outcome === 'accept' ? 'answered' : decision.outcome === 'decline' ? 'declined' : 'cancelled';
  const reasonCode =
    decision.outcome === 'accept' ? 'answered' : decision.outcome === 'decline' ? 'user_rejected' : 'user_cancelled';
  return { status, reasonCode, settledAt, response: redactRuntimeInteractionResponse(request, response) };
}

function sameCard(left: RuntimeInteractionCardRef | undefined, right: RuntimeInteractionCardRef): boolean {
  return Boolean(
    left && left.threadId === right.threadId && left.messageId === right.messageId && left.blockId === right.blockId,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeInteractionAbortReason(signal: AbortSignal | undefined): RuntimeInteractionTerminalReasonCode {
  return signal?.reason === 'provider_cancelled' ? 'provider_cancelled' : 'transport_lost';
}
