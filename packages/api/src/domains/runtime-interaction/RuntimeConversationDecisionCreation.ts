import { isDeepStrictEqual } from 'node:util';
import type { RuntimeConversationDecisionRequest, RuntimeInteractionRecord } from '@cat-cafe/shared';
import { parseRuntimeInteractionRequest } from '@cat-cafe/shared';
import type { RuntimeInteractionCardPublisher } from './ports/RuntimeInteractionCardPublisher.js';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';
import { runtimeInteractionErrorMessage } from './RuntimeConversationDecisionModel.js';
import { RuntimeInteractionError } from './RuntimeInteractionError.js';
import { isConversationRuntimeInteraction } from './RuntimeInteractionRecordModel.js';

export class RuntimeConversationDecisionCreation {
  constructor(
    private readonly deps: {
      store: RuntimeInteractionStore;
      cardPublisher: RuntimeInteractionCardPublisher;
      hostEpoch: string;
      now: () => number;
      emit: (record: RuntimeInteractionRecord) => void;
    },
  ) {}

  async create(input: RuntimeConversationDecisionRequest): Promise<RuntimeInteractionRecord> {
    const loaded = await this.loadOrCreate(input);
    const { request, record: staged } = loaded;
    if (staged.status === 'pending' && staged.cardRef) {
      return this.republish(request, staged);
    }
    if (staged.status !== 'staged') {
      if (staged.terminal?.reasonCode === 'surface_publication_failed') {
        throw new RuntimeInteractionError(
          'unavailable',
          'conversation decision publication previously failed',
          'surface_publication_failed',
        );
      }
      return staged;
    }
    let publicationRecord = staged;
    try {
      const cardRef = await this.deps.cardPublisher.prepare(request);
      const anchored = await this.deps.store.anchor(
        request.interactionId,
        this.deps.hostEpoch,
        cardRef,
        this.deps.now(),
        staged.revision,
      );
      if (!anchored) {
        const concurrent = await this.readExact(request);
        if (concurrent?.status === 'pending' && concurrent.cardRef) return this.republish(request, concurrent);
        throw new Error('conversation decision could not be anchored');
      }
      publicationRecord = anchored;
      await this.deps.cardPublisher.publish(request, cardRef);
      return this.returnPublishedRecord(request, anchored);
    } catch (error) {
      return this.failPublication(publicationRecord, error);
    }
  }

  private async loadOrCreate(input: RuntimeConversationDecisionRequest): Promise<{
    request: RuntimeConversationDecisionRequest;
    record: RuntimeInteractionRecord;
  }> {
    const beforeCreate = await this.deps.store.get(input.interactionId);
    if (beforeCreate) return { request: this.requireReplay(input, beforeCreate), record: beforeCreate };
    const request = parseConversationRequest(input);
    try {
      const record = await this.deps.store.createStaged({
        request,
        hostEpoch: this.deps.hostEpoch,
        now: this.deps.now(),
      });
      if (record.request.kind !== 'conversation_decision') {
        throw new RuntimeInteractionError('invalid_response', 'conversation decision store returned the wrong kind');
      }
      return { request: record.request, record };
    } catch (error) {
      const existing = await this.deps.store.get(request.interactionId);
      if (existing) return { request: this.requireReplay(input, existing), record: existing };
      throw new RuntimeInteractionError('duplicate', runtimeInteractionErrorMessage(error));
    }
  }

  private requireReplay(
    input: RuntimeConversationDecisionRequest,
    existing: RuntimeInteractionRecord,
  ): RuntimeConversationDecisionRequest {
    if (!isConversationRuntimeInteraction(existing) || existing.request.kind !== 'conversation_decision') {
      throw new RuntimeInteractionError('duplicate', 'interaction id belongs to another runtime interaction');
    }
    const replay = parseConversationRequest({ ...input, createdAt: existing.request.createdAt });
    if (!isDeepStrictEqual(existing.request, replay)) {
      throw new RuntimeInteractionError('duplicate', 'interaction id was already used with different content');
    }
    return existing.request;
  }

  private async readExact(request: RuntimeConversationDecisionRequest): Promise<RuntimeInteractionRecord | null> {
    const existing = await this.deps.store.get(request.interactionId);
    return existing && isConversationRuntimeInteraction(existing) && isDeepStrictEqual(existing.request, request)
      ? existing
      : null;
  }

  private async republish(
    request: RuntimeConversationDecisionRequest,
    pending: RuntimeInteractionRecord,
  ): Promise<RuntimeInteractionRecord> {
    const cardRef = pending.cardRef;
    if (!cardRef) throw new RuntimeInteractionError('stale', 'pending conversation decision has no canonical card');
    try {
      await this.deps.cardPublisher.publish(request, cardRef);
      return this.returnPublishedRecord(request, pending);
    } catch (error) {
      return this.failPublication(pending, error);
    }
  }

  private async returnPublishedRecord(
    request: RuntimeConversationDecisionRequest,
    published: RuntimeInteractionRecord,
  ): Promise<RuntimeInteractionRecord> {
    const latest = (await this.readExact(request)) ?? published;
    if (latest.revision === published.revision) this.deps.emit(latest);
    return latest;
  }

  private async failPublication(record: RuntimeInteractionRecord, error: unknown): Promise<never> {
    const invalidated = record.submission
      ? null
      : await this.deps.store.invalidate({
          interactionId: record.request.interactionId,
          reasonCode: 'surface_publication_failed',
          now: this.deps.now(),
          expectedRevision: record.revision,
        });
    if (invalidated) this.deps.emit(invalidated);
    throw new RuntimeInteractionError(
      'unavailable',
      runtimeInteractionErrorMessage(error),
      'surface_publication_failed',
    );
  }
}

function parseConversationRequest(input: RuntimeConversationDecisionRequest): RuntimeConversationDecisionRequest {
  const request = parseRuntimeInteractionRequest(input);
  if (request.kind !== 'conversation_decision') {
    throw new RuntimeInteractionError('invalid_response', 'conversation decision request required');
  }
  return request;
}
