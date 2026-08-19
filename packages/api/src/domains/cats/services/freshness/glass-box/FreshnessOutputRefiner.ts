import type {
  FreshnessSupplementAggregate,
  OutputCommitDecision,
  PublishedFreshnessAnnotation,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { FreshnessClosureStore } from '../FreshnessClosureStore.js';
import { recordFreshnessGlassBoxTransition } from './freshness-glass-box-telemetry.js';
import {
  committedDecision,
  committedDegradedDecision,
  type FreshnessEvaluation,
  type FreshnessOutputCommitInput,
  freshnessUnknownReason,
  publishedWithUnseenDecision,
  scanFailure,
} from './freshness-output-contract.js';

interface FreshnessOutputRefinerDeps {
  messageStore: IMessageStore;
  closureStore: FreshnessClosureStore;
  emitSupplementProjection: (supplement: FreshnessSupplementAggregate) => void;
}

export interface FreshnessLineageContext {
  lineageId: string;
  originalMessageId: string;
  sourceSupplement?: FreshnessSupplementAggregate;
}

export class FreshnessOutputRefiner {
  constructor(private readonly deps: FreshnessOutputRefinerDeps) {}

  async evaluateAndRefine(
    input: FreshnessOutputCommitInput,
    message: StoredMessage,
    priorFrontierMessageId: string | null,
    lineage: FreshnessLineageContext,
  ): Promise<OutputCommitDecision> {
    let evaluation: FreshnessEvaluation;
    try {
      evaluation = await input.evaluateFreshness(priorFrontierMessageId);
    } catch {
      evaluation = scanFailure();
    }
    const unknownReason = freshnessUnknownReason(evaluation.freshness);
    if (unknownReason) {
      const persisted = await this.refineAnnotation(message, {
        kind: 'freshness_unknown',
        priorFrontierMessageId,
        reason: unknownReason,
      });
      if (!persisted) return committedDegradedDecision(input, message.id, 'annotation_persistence_failed');
      return committedDegradedDecision(input, message.id, unknownReason);
    }

    // Ordinary queued messages already have one durable owner: InvocationQueue.
    // They may trigger a best-effort notice, but must never open a second
    // supplement carrier or change the completed reply's publication outcome.
    if (evaluation.freshness.reason === 'queued_messages') {
      const persisted = await this.refineAnnotation(message, { kind: 'fresh', priorFrontierMessageId });
      if (!persisted) return committedDegradedDecision(input, message.id, 'annotation_persistence_failed');
      return committedDecision(input, message.id, input.freshnessSupplementId);
    }

    const requiredMessageIds = [...new Set(evaluation.freshness.unseenMessageIds)].sort();
    const requiredFrontierMessageId =
      evaluation.freshness.highWatermark ?? requiredMessageIds.at(-1) ?? priorFrontierMessageId;
    if (evaluation.freshness.stale && requiredMessageIds.length > 0 && requiredFrontierMessageId) {
      return this.offerSupplement(input, message, priorFrontierMessageId, lineage, {
        requiredMessageIds,
        requiredFrontierMessageId,
      });
    }

    const persisted = await this.refineAnnotation(message, { kind: 'fresh', priorFrontierMessageId });
    if (!persisted) return committedDegradedDecision(input, message.id, 'annotation_persistence_failed');
    return committedDecision(input, message.id, input.freshnessSupplementId);
  }

  async decisionFromFinalAnnotation(
    input: FreshnessOutputCommitInput,
    message: StoredMessage,
    sourceSupplement?: FreshnessSupplementAggregate,
  ): Promise<OutputCommitDecision | null> {
    const annotation = message.extra?.freshness;
    if (!annotation || annotation.kind === 'scan_pending' || annotation.kind === 'closure_replacement') return null;
    if (annotation.kind === 'fresh') return committedDecision(input, message.id, input.freshnessSupplementId);
    if (annotation.kind === 'freshness_unknown') {
      return committedDegradedDecision(input, message.id, annotation.reason);
    }
    if (annotation.supplementFailureReason) {
      return committedDegradedDecision(input, message.id, 'supplement_offer_failed');
    }

    const supplements = await this.deps.closureStore.listSupplementsByLineage(annotation.lineageId);
    const expectedSeq = sourceSupplement ? sourceSupplement.seq + 1 : 1;
    const offered = supplements.find((candidate) => candidate.seq === expectedSeq);
    if (!offered) return committedDegradedDecision(input, message.id, 'supplement_record_missing');
    return publishedWithUnseenDecision(
      input,
      message.id,
      annotation.lineageId,
      offered.id,
      offered.requiredFrontierMessageId,
    );
  }

  private async offerSupplement(
    input: FreshnessOutputCommitInput,
    message: StoredMessage,
    priorFrontierMessageId: string | null,
    lineage: FreshnessLineageContext,
    requirement: { requiredMessageIds: string[]; requiredFrontierMessageId: string },
  ): Promise<OutputCommitDecision> {
    let offered: Awaited<ReturnType<FreshnessClosureStore['offerSupplement']>>;
    try {
      offered = await this.deps.closureStore.offerSupplement({
        lineageId: lineage.lineageId,
        originalMessageId: lineage.originalMessageId,
        userId: input.userId,
        threadId: input.threadId,
        catId: input.catId,
        requiredMessageIds: requirement.requiredMessageIds,
        requiredFrontierMessageId: requirement.requiredFrontierMessageId,
        replayUnsafeToolNames: [
          ...(lineage.sourceSupplement?.replayUnsafeToolNames ?? []),
          ...(input.replayUnsafeToolNames ?? []),
        ],
        now: Date.now(),
      });
    } catch {
      recordFreshnessGlassBoxTransition('published_with_unseen');
      const persisted = await this.refineAnnotation(message, {
        kind: 'published_with_unseen',
        priorFrontierMessageId,
        generatedWithUnseen: requirement.requiredMessageIds,
        lineageId: lineage.lineageId,
        supplementFailureReason: 'infrastructure',
      });
      return committedDegradedDecision(
        input,
        message.id,
        persisted ? 'supplement_offer_failed' : 'annotation_persistence_failed',
      );
    }

    recordFreshnessGlassBoxTransition('published_with_unseen');
    if (offered.kind === 'offered') recordFreshnessGlassBoxTransition('supplement_offered');
    this.deps.emitSupplementProjection(offered.supplement);
    const persisted = await this.refineAnnotation(message, {
      kind: 'published_with_unseen',
      priorFrontierMessageId,
      generatedWithUnseen: requirement.requiredMessageIds,
      lineageId: lineage.lineageId,
    });
    if (!persisted) return committedDegradedDecision(input, message.id, 'annotation_persistence_failed');
    return publishedWithUnseenDecision(
      input,
      message.id,
      lineage.lineageId,
      offered.supplement.id,
      requirement.requiredFrontierMessageId,
    );
  }

  private async refineAnnotation(message: StoredMessage, freshness: PublishedFreshnessAnnotation): Promise<boolean> {
    const extra = { ...message.extra, freshness };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.deps.messageStore.updateExtra(message.id, extra);
        message.extra = extra;
        return true;
      } catch {
        // The answer is already durable. One immediate retry closes common transient
        // metadata races; persistent failure degrades the decision but never retracts it.
      }
    }
    return false;
  }
}
