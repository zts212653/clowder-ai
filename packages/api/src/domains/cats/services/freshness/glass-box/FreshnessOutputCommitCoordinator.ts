import type {
  FreshnessClosureAggregate,
  FreshnessClosureProjection,
  FreshnessSupplementAggregate,
  FreshnessSupplementFailureReason,
  FreshnessSupplementProjection,
  OutputCommitDecision,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { FreshnessClosureStore } from '../FreshnessClosureStore.js';
import { FreshnessOutputRefiner } from './FreshnessOutputRefiner.js';
import { recordFreshnessGlassBoxTransition } from './freshness-glass-box-telemetry.js';
import {
  committedDegradedDecision,
  type FreshnessEvaluation,
  type FreshnessOutputCommitInput,
  freshnessClosureFinalIdempotencyKey,
  projectFreshnessClosure,
  projectFreshnessSupplement,
  SUPPLEMENT_DECLINE_MARKER,
  supplementDeclinedDecision,
} from './freshness-output-contract.js';

export {
  freshnessClosureFinalIdempotencyKey,
  projectFreshnessClosure,
  projectFreshnessSupplement,
  SUPPLEMENT_DECLINE_MARKER,
};
export type { FreshnessEvaluation, FreshnessOutputCommitInput };

interface FreshnessOutputCommitCoordinatorDeps {
  messageStore: IMessageStore;
  closureStore: FreshnessClosureStore;
  onProjection?: (projection: FreshnessClosureProjection) => void | Promise<void>;
  onSupplementProjection?: (projection: FreshnessSupplementProjection) => void | Promise<void>;
}

type SupplementMessageResolution =
  | { message: StoredMessage; priorFrontierMessageId: string | null }
  | { decision: OutputCommitDecision };

function publishedOriginalIdempotencyKey(input: FreshnessOutputCommitInput): string {
  return `f254-published-original:${input.catId}:${input.turnInvocationId ?? input.invocationId}`;
}

export class FreshnessOutputCommitCoordinator {
  private readonly refiner: FreshnessOutputRefiner;

  constructor(private readonly deps: FreshnessOutputCommitCoordinatorDeps) {
    this.refiner = new FreshnessOutputRefiner({
      messageStore: deps.messageStore,
      closureStore: deps.closureStore,
      emitSupplementProjection: (supplement) => this.emitSupplementProjection(supplement),
    });
  }

  private emitProjection(closure: FreshnessClosureAggregate, status: FreshnessClosureProjection['status']): void {
    if (!this.deps.onProjection) return;
    const projection = projectFreshnessClosure(closure, status);
    try {
      Promise.resolve(this.deps.onProjection(projection)).catch(() => {});
    } catch {
      // Projection is rebuildable from closure truth and never owns commit success.
    }
  }

  private emitSupplementProjection(supplement: FreshnessSupplementAggregate): void {
    if (!this.deps.onSupplementProjection) return;
    const projection = projectFreshnessSupplement(supplement);
    try {
      Promise.resolve(this.deps.onSupplementProjection(projection)).catch(() => {});
    } catch {
      // Projection is rebuildable from durable supplement truth.
    }
  }

  async getClosure(closureId: string) {
    return this.deps.closureStore.get(closureId);
  }

  async getSupplement(supplementId: string) {
    return this.deps.closureStore.getSupplement(supplementId);
  }

  async failSupplement(
    supplementId: string,
    reason: FreshnessSupplementFailureReason,
    invocationId?: string,
  ): Promise<FreshnessSupplementAggregate | null> {
    const supplement = await this.deps.closureStore.getSupplement(supplementId);
    if (!supplement || (supplement.status !== 'pending' && supplement.status !== 'running')) return supplement;
    if (supplement.status === 'running' && !invocationId) return supplement;
    const failed = await this.deps.closureStore.failSupplement(supplementId, {
      ...(supplement.status === 'running' && invocationId ? { invocationId } : {}),
      reason,
      now: Date.now(),
    });
    this.emitSupplementProjection(failed);
    return failed;
  }

  async commit(input: FreshnessOutputCommitInput): Promise<OutputCommitDecision> {
    if (input.freshnessSupplementId) return this.commitSupplement(input);
    return this.commitOriginal(input);
  }

  private async commitOriginal(input: FreshnessOutputCommitInput): Promise<OutputCommitDecision> {
    const observed = await this.deps.messageStore.appendAndObservePriorFrontier({
      ...input.message,
      idempotencyKey: input.message.idempotencyKey ?? publishedOriginalIdempotencyKey(input),
    });
    try {
      await this.finalizeLegacyClosure(input, observed.message, observed.priorFrontierMessageId);
    } catch {
      // The original is already durable. A legacy-closure cleanup failure cannot revoke publication;
      // an idempotent retry or startup recovery may close the old responsibility later.
    }
    const terminal = await this.refiner.decisionFromFinalAnnotation(input, observed.message);
    if (terminal) return terminal;
    return this.refiner.evaluateAndRefine(input, observed.message, observed.priorFrontierMessageId, {
      lineageId: observed.message.id,
      originalMessageId: observed.message.id,
    });
  }

  private async commitSupplement(input: FreshnessOutputCommitInput): Promise<OutputCommitDecision> {
    const supplementId = input.freshnessSupplementId;
    if (!supplementId) throw new Error('freshness supplement identity is required');
    const supplement = await this.deps.closureStore.getSupplement(supplementId);
    if (!supplement) throw new Error(`freshness supplement not found: ${supplementId}`);
    this.assertSupplementScope(input, supplement);

    const trimmedContent = input.message.content.trim();
    if (trimmedContent.startsWith(SUPPLEMENT_DECLINE_MARKER)) {
      if (trimmedContent !== SUPPLEMENT_DECLINE_MARKER && supplement.status === 'running') {
        recordFreshnessGlassBoxTransition('supplement_decline_protocol_recovered');
      }
      return this.commitSupplementDecline(input, supplement);
    }

    const resolution = await this.resolveSupplementMessage(input, supplement);
    if ('decision' in resolution) return resolution.decision;
    const { message, priorFrontierMessageId } = resolution;

    const terminal = await this.refiner.decisionFromFinalAnnotation(input, message, supplement);
    if (terminal) return terminal;
    return this.refiner.evaluateAndRefine(input, message, priorFrontierMessageId, {
      lineageId: supplement.lineageId,
      originalMessageId: supplement.originalMessageId,
      sourceSupplement: supplement,
    });
  }

  private async commitSupplementDecline(
    input: FreshnessOutputCommitInput,
    supplement: FreshnessSupplementAggregate,
  ): Promise<OutputCommitDecision> {
    if (supplement.status === 'declined') return supplementDeclinedDecision(input, supplement);
    const declined = await this.deps.closureStore.declineSupplement(supplement.id, {
      invocationId: input.invocationId,
      now: Date.now(),
    });
    recordFreshnessGlassBoxTransition('supplement_declined');
    this.emitSupplementProjection(declined);
    return supplementDeclinedDecision(input, declined);
  }

  private async resolveSupplementMessage(
    input: FreshnessOutputCommitInput,
    supplement: FreshnessSupplementAggregate,
  ): Promise<SupplementMessageResolution> {
    if (supplement.status === 'committed') {
      if (!supplement.committedMessageId) throw new Error('committed freshness supplement is missing message identity');
      const message = await this.deps.messageStore.getById(supplement.committedMessageId);
      if (!message) throw new Error('committed freshness supplement message is missing');
      const annotation = message.extra?.freshness;
      const priorFrontierMessageId =
        annotation && 'priorFrontierMessageId' in annotation ? annotation.priorFrontierMessageId : null;
      return { message, priorFrontierMessageId };
    }
    if (supplement.status !== 'running' || supplement.runningInvocationId !== input.invocationId) {
      throw new Error('only the claimed invocation may publish a freshness supplement');
    }
    const observed = await this.deps.messageStore.appendAndObservePriorFrontier({
      ...input.message,
      timestamp: Date.now(),
      replyTo: supplement.originalMessageId,
      idempotencyKey: supplement.id,
      extra: {
        ...input.message.extra,
        supplement: {
          lineageId: supplement.lineageId,
          supplementId: supplement.id,
          seq: supplement.seq,
          originalMessageId: supplement.originalMessageId,
        },
      },
    });
    const committed = await this.commitSupplementState(supplement, input.invocationId, observed.message.id);
    if (!committed) {
      return {
        decision: committedDegradedDecision(input, observed.message.id, 'supplement_state_commit_failed'),
      };
    }
    recordFreshnessGlassBoxTransition('supplement_produced');
    this.emitSupplementProjection(committed);
    return { message: observed.message, priorFrontierMessageId: observed.priorFrontierMessageId };
  }

  private async commitSupplementState(
    supplement: FreshnessSupplementAggregate,
    invocationId: string,
    messageId: string,
  ): Promise<FreshnessSupplementAggregate | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.deps.closureStore.commitSupplement(supplement.id, {
          invocationId,
          messageId,
          now: Date.now(),
        });
      } catch {
        // The message append is idempotent and already durable. Retry the CAS transition;
        // startup reconciliation uses the same message identity if the process dies here.
      }
    }
    return null;
  }

  private async finalizeLegacyClosure(
    input: FreshnessOutputCommitInput,
    message: StoredMessage,
    observedRawFrontierMessageId: string | null,
  ): Promise<void> {
    if (!input.freshnessClosureId) return;
    const closure = await this.deps.closureStore.get(input.freshnessClosureId);
    if (
      !closure ||
      closure.status !== 'running' ||
      closure.activeAttempt?.invocationId !== input.invocationId ||
      closure.userId !== input.userId ||
      closure.threadId !== input.threadId ||
      closure.catId !== input.catId
    ) {
      return;
    }
    const committed = await this.deps.closureStore.commit(closure.id, {
      invocationId: input.invocationId,
      messageId: message.id,
      observedRawFrontierMessageId,
      draftContent: input.message.content,
      evidenceRefs: [`message:${message.id}`, 'migration:adr-042-published'],
      now: Date.now(),
    });
    this.emitProjection(committed, 'committed');
  }

  private assertSupplementScope(input: FreshnessOutputCommitInput, supplement: FreshnessSupplementAggregate): void {
    if (
      supplement.userId !== input.userId ||
      supplement.threadId !== input.threadId ||
      supplement.catId !== input.catId
    ) {
      throw new Error('freshness supplement scope mismatch');
    }
  }
}
