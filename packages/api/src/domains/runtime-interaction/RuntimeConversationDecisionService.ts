import type {
  RuntimeConversationDecisionRequest,
  RuntimeConversationResponse,
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionTerminal,
} from '@cat-cafe/shared';
import { parseRuntimeConversationResponse, redactRuntimeConversationResponse } from '@cat-cafe/shared';
import type { RuntimeConversationReturnGateway } from './ports/RuntimeConversationReturnGateway.js';
import type { RuntimeInteractionCardPublisher } from './ports/RuntimeInteractionCardPublisher.js';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';
import { RuntimeConversationDecisionCreation } from './RuntimeConversationDecisionCreation.js';
import { RuntimeConversationDecisionDelivery } from './RuntimeConversationDecisionDelivery.js';
import {
  conversationResponseDigest,
  type RuntimeConversationInteractionRecord,
  type RuntimeConversationOwnerMessageAuth,
  type RuntimeConversationRequester,
  runtimeInteractionErrorMessage,
  sameConversationOperation,
  sameRuntimeInteractionCard,
} from './RuntimeConversationDecisionModel.js';
import { RuntimeInteractionError } from './RuntimeInteractionError.js';
import { isConversationRuntimeInteraction } from './RuntimeInteractionRecordModel.js';

export class RuntimeConversationDecisionService {
  private gateway?: RuntimeConversationReturnGateway;
  private readonly creation: RuntimeConversationDecisionCreation;
  private readonly delivery: RuntimeConversationDecisionDelivery;

  constructor(
    private readonly deps: {
      store: RuntimeInteractionStore;
      cardPublisher: RuntimeInteractionCardPublisher;
      hostEpoch: string;
      now: () => number;
      onRecordUpdated?: (record: RuntimeInteractionRecord) => void;
      onRecoveryError?: (error: unknown, record?: RuntimeInteractionRecord) => void;
      gateway?: RuntimeConversationReturnGateway;
    },
  ) {
    this.gateway = deps.gateway;
    this.creation = new RuntimeConversationDecisionCreation({
      store: deps.store,
      cardPublisher: deps.cardPublisher,
      hostEpoch: deps.hostEpoch,
      now: deps.now,
      emit: (record) => this.emit(record),
    });
    this.delivery = new RuntimeConversationDecisionDelivery({
      store: deps.store,
      cardPublisher: deps.cardPublisher,
      now: deps.now,
      gateway: () => this.gateway,
      emit: (record) => this.emit(record),
      ...(deps.onRecoveryError ? { onRecoveryError: deps.onRecoveryError } : {}),
    });
  }

  bindGateway(gateway: RuntimeConversationReturnGateway): void {
    this.gateway = gateway;
  }

  async create(input: RuntimeConversationDecisionRequest): Promise<RuntimeInteractionRecord> {
    return this.creation.create(input);
  }

  async respond(input: {
    interactionId: string;
    ownerUserId: string;
    cardRef: RuntimeInteractionCardRef;
    expectedRevision: number;
    operationId: string;
    response: unknown;
  }): Promise<RuntimeInteractionRecord> {
    const record = await this.requireConversation(input.interactionId);
    if (
      record.request.owner.userId !== input.ownerUserId ||
      !sameRuntimeInteractionCard(record.cardRef, input.cardRef)
    ) {
      throw new RuntimeInteractionError('unauthorized', 'runtime interaction is not owned by this surface');
    }
    let response: RuntimeConversationResponse;
    try {
      response = parseRuntimeConversationResponse(record.request, input.response);
    } catch (error) {
      throw new RuntimeInteractionError('invalid_response', runtimeInteractionErrorMessage(error));
    }
    const digest = conversationResponseDigest(response);
    const replay = sameConversationOperation(record, input.operationId, digest);
    if (replay) return replay;
    if (record.submission?.operationId === input.operationId) return this.delivery.finishSubmission(record);
    this.requirePendingRevision(record, input.expectedRevision);
    const respondedAt = this.deps.now();
    await this.rejectIfDeadlineElapsed(record, respondedAt);
    const terminal: RuntimeInteractionTerminal = {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: respondedAt,
      response: redactRuntimeConversationResponse(response),
      operationId: input.operationId,
      responseDigest: digest,
    };
    return this.delivery.claimAndFinish(record, response, terminal, 'owner');
  }

  async settleFromOwnerMessage(input: {
    interactionId: string;
    requester: RuntimeConversationRequester;
    ownerMessageAuth: RuntimeConversationOwnerMessageAuth;
    expectedRevision: number;
    operationId: string;
    responseMessageId: string;
  }): Promise<RuntimeInteractionRecord> {
    // Immediate owner turns have no Queue custody. Their unforgeable authority is the
    // strict callback invocation bound to this exact origin trigger message.
    if (
      input.ownerMessageAuth.ownerAuthProvenance !== 'strict' ||
      input.ownerMessageAuth.originTriggerMessageId !== input.responseMessageId
    ) {
      throw new RuntimeInteractionError('unauthorized', 'owner response is not the strict invocation trigger');
    }
    const record = await this.requireConversation(input.interactionId);
    this.requireRequester(record, input.requester);
    const digest = conversationResponseDigest({
      kind: 'referenced_message',
      responseMessageId: input.responseMessageId,
    });
    const replay = sameConversationOperation(record, input.operationId, digest);
    if (replay) return replay;
    this.requirePendingRevision(record, input.expectedRevision);
    await this.delivery.ensureLive(record);
    const message = await this.requireGateway().readOwnerMessage(input.responseMessageId);
    const publishedAt = record.cardRef?.publishedAt ?? record.request.createdAt;
    if (
      !message ||
      message.userId !== record.request.owner.userId ||
      message.threadId !== record.request.owner.threadId ||
      message.from?.kind !== 'user' ||
      message.from.userId !== record.request.owner.userId ||
      message.deletedAt !== undefined ||
      message.tombstone ||
      message.timestamp <= publishedAt
    ) {
      throw new RuntimeInteractionError('unauthorized', 'referenced owner response is not canonical');
    }
    await this.rejectIfDeadlineElapsed(record, message.timestamp);
    const terminal: RuntimeInteractionTerminal = {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: this.deps.now(),
      response: { kind: 'text' },
      operationId: input.operationId,
      responseDigest: digest,
      responseMessageId: input.responseMessageId,
    };
    return this.settleDirect(record, terminal);
  }

  async withdraw(input: {
    interactionId: string;
    requester: RuntimeConversationRequester;
    expectedRevision: number;
    operationId: string;
  }): Promise<RuntimeInteractionRecord> {
    const record = await this.requireConversation(input.interactionId);
    this.requireRequester(record, input.requester);
    const digest = conversationResponseDigest({ kind: 'withdrawn' });
    const replay = sameConversationOperation(record, input.operationId, digest);
    if (replay) return replay;
    this.requirePendingRevision(record, input.expectedRevision);
    await this.rejectIfDeadlineElapsed(record, this.deps.now());
    await this.delivery.ensureLive(record);
    return this.settleDirect(record, {
      status: 'cancelled',
      reasonCode: 'withdrawn',
      settledAt: this.deps.now(),
      operationId: input.operationId,
      responseDigest: digest,
    });
  }

  async supersede(input: {
    interactionId: string;
    requester: RuntimeConversationRequester;
    expectedRevision: number;
    operationId: string;
    replacementInteractionId: string;
  }): Promise<RuntimeInteractionRecord> {
    if (input.interactionId === input.replacementInteractionId) {
      throw new RuntimeInteractionError('invalid_response', 'replacement interaction must be different');
    }
    const [record, replacement] = await Promise.all([
      this.requireConversation(input.interactionId),
      this.requireConversation(input.replacementInteractionId),
    ]);
    this.requireRequester(record, input.requester);
    this.requireRequester(replacement, input.requester);
    const digest = conversationResponseDigest({
      kind: 'superseded',
      replacementInteractionId: input.replacementInteractionId,
    });
    const replay = sameConversationOperation(record, input.operationId, digest);
    if (replay) return replay;
    this.requirePendingRevision(record, input.expectedRevision);
    await this.rejectIfDeadlineElapsed(record, this.deps.now());
    if (replacement.status !== 'pending' || replacement.request.createdAt <= record.request.createdAt) {
      throw new RuntimeInteractionError('stale', 'replacement interaction is not a later pending question');
    }
    await Promise.all([this.delivery.ensureLive(record), this.delivery.ensureLive(replacement)]);
    return this.settleDirect(record, {
      status: 'cancelled',
      reasonCode: 'superseded',
      settledAt: this.deps.now(),
      operationId: input.operationId,
      responseDigest: digest,
      supersededByInteractionId: replacement.request.interactionId,
    });
  }

  async recoverSubmissions(): Promise<RuntimeInteractionRecord[]> {
    return this.delivery.recoverSubmissions();
  }

  async recoverCreations(): Promise<RuntimeInteractionRecord[]> {
    const active = await this.deps.store.listActive();
    const recovered: RuntimeInteractionRecord[] = [];
    for (const record of active) {
      if (record.request.kind !== 'conversation_decision' || record.status !== 'staged') continue;
      try {
        recovered.push(await this.creation.create(record.request));
      } catch (error) {
        this.deps.onRecoveryError?.(error, record);
      }
    }
    return recovered;
  }

  async reconcileDeadlines(): Promise<RuntimeInteractionRecord[]> {
    return this.delivery.reconcileDeadlines();
  }

  async pendingPrompt(
    userId: string,
    threadId: string,
    catId: string,
    originTriggerMessageId?: string,
  ): Promise<string> {
    const pending = (await this.deps.store.listPendingByUser(userId))
      .filter(
        (record) =>
          record.request.kind === 'conversation_decision' &&
          !record.submission &&
          record.request.owner.threadId === threadId &&
          record.request.owner.catId === catId,
      )
      .slice(0, 5);
    if (pending.length === 0) return '';
    return [
      '[Pending Conversation Decisions]',
      '这些问题仍在等当前用户；不要从裸文字猜结论。若本轮触发消息明确回答了其中一项，用具名管理工具引用这条 exact owner message；不再需要则显式撤回或改问。',
      ...(originTriggerMessageId ? [`currentOwnerMessageId=${originTriggerMessageId}`] : []),
      ...pending.map((record) => {
        const question = [record.request.title, record.request.description]
          .filter((part): part is string => Boolean(part))
          .join(' — ')
          .slice(0, 400);
        return `- interactionId=${record.request.interactionId} revision=${record.revision} cardMessageId=${record.cardRef?.messageId ?? 'unavailable'} question=${JSON.stringify(question)}`;
      }),
      '[/Pending Conversation Decisions]',
    ].join('\n');
  }

  private async settleDirect(
    record: RuntimeInteractionRecord,
    terminal: RuntimeInteractionTerminal,
  ): Promise<RuntimeInteractionRecord> {
    const operationId = terminal.operationId;
    const responseDigest = terminal.responseDigest;
    if (!operationId || !responseDigest) {
      throw new RuntimeInteractionError('invalid_response', 'conversation terminal requires operation identity');
    }
    const settled = await this.deps.store.settleConversation({
      interactionId: record.request.interactionId,
      expectedRevision: record.revision,
      terminal,
      now: terminal.settledAt,
    });
    if (!settled) {
      const latest = await this.requireConversation(record.request.interactionId);
      const replay = sameConversationOperation(latest, operationId, responseDigest);
      if (replay) return replay;
      throw new RuntimeInteractionError('stale', 'runtime interaction revision changed');
    }
    this.emit(settled);
    return settled;
  }

  private async requireConversation(interactionId: string): Promise<RuntimeConversationInteractionRecord> {
    const record = await this.deps.store.get(interactionId);
    if (!record) throw new RuntimeInteractionError('not_found', 'runtime interaction not found');
    if (!isConversationRuntimeInteraction(record) || record.request.kind !== 'conversation_decision') {
      throw new RuntimeInteractionError('invalid_response', 'runtime interaction is not a conversation decision');
    }
    return record as RuntimeConversationInteractionRecord;
  }

  private requireRequester(record: RuntimeInteractionRecord, requester: RuntimeConversationRequester): void {
    if (
      record.request.owner.userId !== requester.userId ||
      record.request.owner.threadId !== requester.threadId ||
      record.request.owner.catId !== requester.catId
    ) {
      throw new RuntimeInteractionError('unauthorized', 'requester does not own this conversation decision');
    }
  }

  private requirePendingRevision(record: RuntimeInteractionRecord, expectedRevision: number): void {
    if (record.status !== 'pending' || record.submission || record.revision !== expectedRevision) {
      throw new RuntimeInteractionError('stale', 'runtime interaction revision changed');
    }
  }

  private async rejectIfDeadlineElapsed(record: RuntimeInteractionRecord, observedAt: number): Promise<void> {
    if (
      record.request.kind !== 'conversation_decision' ||
      record.request.deadlineAt === undefined ||
      observedAt < record.request.deadlineAt
    )
      return;
    await this.delivery.settleElapsedDeadline(record, observedAt);
    throw new RuntimeInteractionError('stale', 'conversation decision deadline elapsed');
  }

  private requireGateway(): RuntimeConversationReturnGateway {
    if (!this.gateway) throw new RuntimeInteractionError('unavailable', 'conversation return gateway unavailable');
    return this.gateway;
  }

  private emit(record: RuntimeInteractionRecord): void {
    this.deps.onRecordUpdated?.(record);
  }
}
