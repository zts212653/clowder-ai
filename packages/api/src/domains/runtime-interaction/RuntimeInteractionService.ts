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
  publish(request: RuntimeInteractionRequest): Promise<RuntimeInteractionCardRef>;
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

interface ActiveWaiter {
  resolve(response: RuntimeInteractionResponse): void;
  reject(error: Error): void;
  cleanup(): void;
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

    let cardRef: RuntimeInteractionCardRef;
    let pending: RuntimeInteractionRecord;
    try {
      cardRef = await this.deps.cardPublisher.publish(request);
      if (options?.signal?.aborted) throw new Error(runtimeInteractionAbortReason(options.signal));
      const anchored = await this.store.anchor(request.interactionId, this.hostEpoch, cardRef, this.now());
      if (!anchored || anchored.status !== 'pending') throw new Error('runtime interaction could not be anchored');
      pending = anchored;
    } catch (error) {
      const failureReason = errorMessage(error);
      const invalidationReason =
        failureReason === 'provider_cancelled' || failureReason === 'transport_lost'
          ? failureReason
          : 'surface_publication_failed';
      const invalidated = await this.store.invalidate({
        interactionId: request.interactionId,
        reasonCode: invalidationReason,
        now: this.now(),
      });
      if (invalidated) this.emit(invalidated);
      const terminalReason = invalidated?.terminal?.reasonCode ?? 'surface_publication_failed';
      throw new RuntimeInteractionError('unavailable', terminalReason, terminalReason);
    }

    return new Promise<RuntimeInteractionResponse>((resolve, reject) => {
      const abort = (): void => {
        void this.invalidateOne(request.interactionId, runtimeInteractionAbortReason(options?.signal));
      };
      options?.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = (): void => options?.signal?.removeEventListener('abort', abort);
      this.waiters.set(request.interactionId, { resolve, reject, cleanup });
      this.emit(pending);
      if (options?.signal?.aborted) abort();
    });
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
