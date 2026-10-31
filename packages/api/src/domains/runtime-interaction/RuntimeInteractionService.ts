import type {
  RuntimeConversationDecisionRequest,
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import { parseRuntimeInteractionRequest, parseRuntimeInteractionResponse } from '@cat-cafe/shared';
import type { RuntimeConversationReturnGateway } from './ports/RuntimeConversationReturnGateway.js';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';
import type {
  RuntimeConversationOwnerMessageAuth,
  RuntimeConversationRequester,
} from './RuntimeConversationDecisionModel.js';
import { RuntimeConversationDecisionService } from './RuntimeConversationDecisionService.js';
import { RuntimeInteractionError } from './RuntimeInteractionError.js';
import type {
  RuntimeInteractionRejectInput,
  RuntimeInteractionRespondInput,
  RuntimeInteractionServiceDeps,
} from './RuntimeInteractionServiceContract.js';
import { RuntimeInteractionWaiterRegistry } from './RuntimeInteractionWaiterRegistry.js';
import {
  providerInteractionErrorMessage,
  providerTerminalFrom,
  runtimeInteractionAbortReason,
  sameProviderCard,
  throwIfRuntimeInteractionAborted,
} from './RuntimeProviderInteractionModel.js';

export type { RuntimeConversationReturnGateway } from './ports/RuntimeConversationReturnGateway.js';
export type { RuntimeInteractionCardPublisher } from './ports/RuntimeInteractionCardPublisher.js';
export { RuntimeInteractionError, type RuntimeInteractionErrorCode } from './RuntimeInteractionError.js';
export type {
  RuntimeInteractionRejectInput,
  RuntimeInteractionRespondInput,
  RuntimeInteractionServiceDeps,
} from './RuntimeInteractionServiceContract.js';

export class RuntimeInteractionService {
  private readonly store: RuntimeInteractionStore;
  private readonly hostEpoch: string;
  private readonly now: () => number;
  private readonly waiters = new RuntimeInteractionWaiterRegistry();
  private readonly conversation: RuntimeConversationDecisionService;

  constructor(private readonly deps: RuntimeInteractionServiceDeps) {
    this.store = deps.store;
    this.hostEpoch = deps.hostEpoch;
    this.now = deps.now ?? Date.now;
    this.conversation = new RuntimeConversationDecisionService({
      store: this.store,
      cardPublisher: deps.cardPublisher,
      hostEpoch: this.hostEpoch,
      now: this.now,
      ...(deps.onRecordUpdated ? { onRecordUpdated: deps.onRecordUpdated } : {}),
      ...(deps.onRecoveryError ? { onRecoveryError: deps.onRecoveryError } : {}),
      ...(deps.conversationReturnGateway ? { gateway: deps.conversationReturnGateway } : {}),
    });
  }

  async request(
    input: RuntimeInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeInteractionResponse> {
    const request = parseRuntimeInteractionRequest(input);
    if (request.kind === 'conversation_decision') {
      throw new RuntimeInteractionError('invalid_response', 'use createConversationDecision for conversation requests');
    }
    try {
      const staged = await this.store.createStaged({ request, hostEpoch: this.hostEpoch, now: this.now() });
      return this.requestProvider(request, staged, options);
    } catch (error) {
      if (error instanceof RuntimeInteractionError) throw error;
      throw new RuntimeInteractionError('duplicate', providerInteractionErrorMessage(error));
    }
  }

  private async requestProvider(
    request: Exclude<RuntimeInteractionRequest, { kind: 'conversation_decision' }>,
    staged: RuntimeInteractionRecord,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeInteractionResponse> {
    const { responsePromise, waiter } = this.waiters.register(request.interactionId, options?.signal, () => {
      void this.invalidateOne(request.interactionId, runtimeInteractionAbortReason(options?.signal));
    });

    let cardRef: RuntimeInteractionCardRef;
    let pending: RuntimeInteractionRecord;
    try {
      throwIfRuntimeInteractionAborted(options?.signal);
      cardRef = await this.deps.cardPublisher.prepare(request);
      throwIfRuntimeInteractionAborted(options?.signal);
      const anchored = await this.store.anchor(
        request.interactionId,
        this.hostEpoch,
        cardRef,
        this.now(),
        staged.revision,
      );
      if (!anchored || anchored.status !== 'pending') throw new Error('runtime interaction could not be anchored');
      pending = anchored;
      throwIfRuntimeInteractionAborted(options?.signal);
      await this.deps.cardPublisher.publish(request, cardRef);
      throwIfRuntimeInteractionAborted(options?.signal);
    } catch (error) {
      const failureReason = providerInteractionErrorMessage(error);
      const invalidationReason =
        failureReason === 'provider_cancelled' || failureReason === 'transport_lost'
          ? failureReason
          : 'surface_publication_failed';
      this.waiters.discard(request.interactionId, waiter);
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
    if (record.request.kind === 'conversation_decision') {
      return this.respondConversation(input);
    }
    if (record.request.owner.userId !== input.ownerUserId || !sameProviderCard(record.cardRef, input.cardRef)) {
      throw new RuntimeInteractionError('unauthorized', 'runtime interaction is not owned by this surface');
    }
    if (record.status !== 'pending') throw new RuntimeInteractionError('stale', 'runtime interaction is not pending');
    if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
      throw new RuntimeInteractionError('stale', 'runtime interaction revision changed');
    }

    let response: RuntimeInteractionResponse;
    try {
      response = parseRuntimeInteractionResponse(record.request, input.response);
    } catch (error) {
      throw new RuntimeInteractionError('invalid_response', providerInteractionErrorMessage(error));
    }
    if (response.kind === 'selection' || response.kind === 'text') {
      throw new RuntimeInteractionError('invalid_response', 'provider interaction requires a provider response');
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

    const terminal = providerTerminalFrom(record.request, response, this.now());
    const settled = await this.store.settle({
      interactionId: input.interactionId,
      hostEpoch: this.hostEpoch,
      terminal,
      now: terminal.settledAt,
      expectedRevision: record.revision,
    });
    if (!settled) throw new RuntimeInteractionError('stale', 'runtime interaction was already settled');

    this.waiters.delete(input.interactionId);
    waiter.cleanup();
    this.emit(settled);
    waiter.resolve(response);
    return settled;
  }

  private respondConversation(input: RuntimeInteractionRespondInput): Promise<RuntimeInteractionRecord> {
    if (input.expectedRevision === undefined || !input.operationId) {
      throw new RuntimeInteractionError('invalid_response', 'expectedRevision and operationId are required');
    }
    return this.conversation.respond({
      ...input,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
    });
  }

  async reject(input: RuntimeInteractionRejectInput): Promise<RuntimeInteractionRecord> {
    const record = await this.store.get(input.interactionId);
    if (!record) throw new RuntimeInteractionError('not_found', 'runtime interaction not found');
    if (record.request.kind === 'conversation_decision') {
      throw new RuntimeInteractionError('invalid_response', 'conversation decisions do not use provider rejection');
    }
    if (record.request.owner.userId !== input.ownerUserId || !sameProviderCard(record.cardRef, input.cardRef)) {
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
      expectedRevision: record.revision,
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

  createConversationDecision(input: RuntimeConversationDecisionRequest): Promise<RuntimeInteractionRecord> {
    return this.conversation.create(input);
  }

  bindConversationReturnGateway(gateway: RuntimeConversationReturnGateway): void {
    this.conversation.bindGateway(gateway);
  }

  settleFromOwnerMessage(input: {
    interactionId: string;
    requester: RuntimeConversationRequester;
    ownerMessageAuth: RuntimeConversationOwnerMessageAuth;
    expectedRevision: number;
    operationId: string;
    responseMessageId: string;
  }): Promise<RuntimeInteractionRecord> {
    return this.conversation.settleFromOwnerMessage(input);
  }

  withdrawConversationDecision(input: {
    interactionId: string;
    requester: RuntimeConversationRequester;
    expectedRevision: number;
    operationId: string;
  }): Promise<RuntimeInteractionRecord> {
    return this.conversation.withdraw(input);
  }

  supersedeConversationDecision(input: {
    interactionId: string;
    requester: RuntimeConversationRequester;
    expectedRevision: number;
    operationId: string;
    replacementInteractionId: string;
  }): Promise<RuntimeInteractionRecord> {
    return this.conversation.supersede(input);
  }

  recoverConversationSubmissions(): Promise<RuntimeInteractionRecord[]> {
    return this.conversation.recoverSubmissions();
  }

  recoverConversationCreations(): Promise<RuntimeInteractionRecord[]> {
    return this.conversation.recoverCreations();
  }

  reconcileConversationDeadlines(): Promise<RuntimeInteractionRecord[]> {
    return this.conversation.reconcileDeadlines();
  }

  pendingConversationDecisionPrompt(
    userId: string,
    threadId: string,
    catId: string,
    originTriggerMessageId?: string,
  ): Promise<string> {
    return this.conversation.pendingPrompt(userId, threadId, catId, originTriggerMessageId);
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
