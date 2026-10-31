import type {
  RuntimeConversationResponse,
  RuntimeInteractionRecord,
  RuntimeInteractionSubmission,
  RuntimeInteractionTerminal,
} from '@cat-cafe/shared';
import { redactRuntimeConversationResponse } from '@cat-cafe/shared';
import type { RuntimeConversationReturnGateway } from './ports/RuntimeConversationReturnGateway.js';
import type { RuntimeInteractionCardPublisher } from './ports/RuntimeInteractionCardPublisher.js';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';
import {
  conversationDeliveryContent,
  conversationResponseDigest,
  type RuntimeConversationInteractionRecord,
  runtimeInteractionErrorMessage,
  sameConversationOperation,
} from './RuntimeConversationDecisionModel.js';
import { RuntimeInteractionError } from './RuntimeInteractionError.js';
import { isConversationRuntimeInteraction } from './RuntimeInteractionRecordModel.js';

export class RuntimeConversationDecisionDelivery {
  constructor(
    private readonly deps: {
      store: RuntimeInteractionStore;
      cardPublisher: RuntimeInteractionCardPublisher;
      now: () => number;
      gateway: () => RuntimeConversationReturnGateway | undefined;
      emit: (record: RuntimeInteractionRecord) => void;
      onRecoveryError?: (error: unknown, record?: RuntimeInteractionRecord) => void;
    },
  ) {}

  async claimAndFinish(
    record: RuntimeInteractionRecord,
    response: RuntimeConversationResponse | undefined,
    terminal: RuntimeInteractionTerminal,
    author: 'owner' | 'host',
  ): Promise<RuntimeInteractionRecord> {
    const operationId = terminal.operationId;
    const responseDigest = terminal.responseDigest;
    if (!operationId || !responseDigest) {
      throw new RuntimeInteractionError('invalid_response', 'conversation terminal requires operation identity');
    }
    await this.ensureLive(record);
    const submission: RuntimeInteractionSubmission = {
      operationId,
      responseDigest,
      author,
      ...(response ? { response } : {}),
      terminal,
      claimedAt: terminal.settledAt,
    };
    const claimed = await this.deps.store.claimSubmission({
      interactionId: record.request.interactionId,
      expectedRevision: record.revision,
      submission,
      now: terminal.settledAt,
    });
    if (!claimed) {
      const latest = await this.requireConversation(record.request.interactionId);
      const replay = sameConversationOperation(latest, submission.operationId, submission.responseDigest);
      if (replay) return replay;
      if (latest.submission?.operationId === submission.operationId) return this.finishSubmission(latest);
      throw new RuntimeInteractionError('stale', 'runtime interaction revision changed');
    }
    this.deps.emit(claimed);
    return this.finishSubmission(claimed);
  }

  async finishSubmission(record: RuntimeInteractionRecord): Promise<RuntimeInteractionRecord> {
    const submission = record.submission;
    if (!submission) throw new RuntimeInteractionError('stale', 'conversation submission is unavailable');
    const request = record.request;
    if (request.kind !== 'conversation_decision') throw new RuntimeInteractionError('stale', 'wrong interaction kind');
    let delivered: { messageId: string };
    try {
      delivered = await this.requireGateway().deliver({
        interactionId: request.interactionId,
        operationId: submission.operationId,
        author: submission.author,
        content: conversationDeliveryContent(request, submission),
        record,
      });
    } catch (error) {
      throw new RuntimeInteractionError('unavailable', runtimeInteractionErrorMessage(error));
    }
    return this.completeSubmission(record, { ...submission.terminal, responseMessageId: delivered.messageId });
  }

  async recoverSubmissions(): Promise<RuntimeInteractionRecord[]> {
    const active = await this.deps.store.listActive();
    const results: RuntimeInteractionRecord[] = [];
    for (const record of active) {
      if (!isConversationRuntimeInteraction(record) || !record.submission) continue;
      try {
        results.push(await this.finishSubmission(record));
      } catch (error) {
        // A transient message/card dependency remains recoverable on the next sweep.
        this.deps.onRecoveryError?.(error, record);
      }
    }
    return results;
  }

  async reconcileDeadlines(): Promise<RuntimeInteractionRecord[]> {
    const now = this.deps.now();
    const active = await this.deps.store.listActive();
    const settled: RuntimeInteractionRecord[] = [];
    for (const record of active) {
      if (
        record.request.kind !== 'conversation_decision' ||
        record.status !== 'pending' ||
        record.submission ||
        record.request.deadlineAt === undefined ||
        record.request.deadlineAt > now
      )
        continue;
      try {
        settled.push(await this.settleElapsedDeadline(record, now));
      } catch (error) {
        if (!(error instanceof RuntimeInteractionError) || error.code !== 'stale') {
          this.deps.onRecoveryError?.(error, record);
        }
      }
    }
    return settled;
  }

  async settleElapsedDeadline(
    record: RuntimeInteractionRecord,
    observedAt = this.deps.now(),
  ): Promise<RuntimeInteractionRecord> {
    if (
      record.request.kind !== 'conversation_decision' ||
      record.status !== 'pending' ||
      record.submission ||
      record.request.deadlineAt === undefined ||
      record.request.deadlineAt > observedAt
    ) {
      throw new RuntimeInteractionError('stale', 'conversation decision deadline is not currently claimable');
    }
    const response = record.request.defaultResponse;
    const operationId = `deadline:${record.request.deadlineAt}`;
    const digest = conversationResponseDigest(response ?? { kind: 'expired' });
    const terminal: RuntimeInteractionTerminal = response
      ? {
          status: 'answered',
          reasonCode: 'defaulted',
          settledAt: observedAt,
          response: redactRuntimeConversationResponse(response),
          operationId,
          responseDigest: digest,
        }
      : {
          status: 'invalidated',
          reasonCode: 'expired',
          settledAt: observedAt,
          operationId,
          responseDigest: digest,
        };
    return this.claimAndFinish(record, response, terminal, 'host');
  }

  async ensureLive(record: RuntimeInteractionRecord): Promise<void> {
    if (!record.cardRef) throw new RuntimeInteractionError('stale', 'runtime interaction has no canonical card');
    try {
      if (await this.deps.cardPublisher.isLive(record.request, record.cardRef)) return;
    } catch {
      throw new RuntimeInteractionError('unavailable', 'runtime interaction confirmation check unavailable; retry');
    }
    if (!record.submission) {
      const invalidated = await this.deps.store.invalidate({
        interactionId: record.request.interactionId,
        reasonCode: 'confirmation_unavailable',
        now: this.deps.now(),
        expectedRevision: record.revision,
      });
      if (invalidated) this.deps.emit(invalidated);
    }
    throw new RuntimeInteractionError(
      'stale',
      'runtime interaction canonical card is no longer available',
      'confirmation_unavailable',
    );
  }

  private async completeSubmission(
    claimed: RuntimeInteractionRecord,
    terminal: RuntimeInteractionTerminal,
  ): Promise<RuntimeInteractionRecord> {
    const operationId = claimed.submission?.operationId;
    if (!operationId) throw new RuntimeInteractionError('stale', 'conversation submission is unavailable');
    const settled = await this.deps.store.completeSubmission({
      interactionId: claimed.request.interactionId,
      expectedRevision: claimed.revision,
      operationId,
      terminal,
      now: this.deps.now(),
    });
    if (settled) {
      this.deps.emit(settled);
      return settled;
    }
    const latest = await this.requireConversation(claimed.request.interactionId);
    const replay = sameConversationOperation(latest, operationId, claimed.submission.responseDigest);
    if (replay) return replay;
    throw new RuntimeInteractionError('stale', 'runtime interaction completion changed');
  }

  private async requireConversation(interactionId: string): Promise<RuntimeConversationInteractionRecord> {
    const record = await this.deps.store.get(interactionId);
    if (!record) throw new RuntimeInteractionError('not_found', 'runtime interaction not found');
    if (!isConversationRuntimeInteraction(record) || record.request.kind !== 'conversation_decision') {
      throw new RuntimeInteractionError('invalid_response', 'runtime interaction is not a conversation decision');
    }
    return record as RuntimeConversationInteractionRecord;
  }

  private requireGateway(): RuntimeConversationReturnGateway {
    const gateway = this.deps.gateway();
    if (!gateway) throw new RuntimeInteractionError('unavailable', 'conversation return gateway unavailable');
    return gateway;
  }
}
