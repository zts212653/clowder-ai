import { createCatId } from '@cat-cafe/shared';
import type { AppendMessageInput, IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  type LegacyLocalReviewSourceResolverDeps,
  type ResolvedLegacyLocalReviewSource,
  resolveLegacyLocalReviewSource,
} from './LegacyLocalReviewSourceResolver.js';

export const LEGACY_LOCAL_REVIEW_DISPOSITION_VERDICTS = ['approved', 'changes_requested'] as const;
export type LegacyLocalReviewDispositionVerdict = (typeof LEGACY_LOCAL_REVIEW_DISPOSITION_VERDICTS)[number];

export interface LegacyLocalReviewEligibility {
  outcome: 'eligible';
  sourceMessageId: string;
  leaseId: string;
  generation: number;
  subjectRef: string;
  reviewerCatId: string;
  predecessorCatId: string;
  predecessorThreadId: string;
  reviewedHeadSha: string;
}

export type LegacyLocalReviewInspectionResult =
  | LegacyLocalReviewEligibility
  | { outcome: 'ineligible' | 'stale'; reason: string };

export type LegacyLocalReviewSettlementResult =
  | {
      outcome: 'committed';
      replayed: boolean;
      leaseId: string;
      generation: number;
      decisionMessageId: string;
      queueEntryId: string;
    }
  | {
      outcome: 'continuation_pending';
      reason: string;
      leaseId: string;
      generation: number;
      decisionMessageId: string;
    }
  | { outcome: 'ineligible' | 'stale' | 'conflict'; reason: string };

export interface LegacyLocalReviewDispositionServiceDeps extends LegacyLocalReviewSourceResolverDeps {
  messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'appendIdempotent' | 'prepareQueueAdmission'>;
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'recoverLocalReviewVerdict'>;
  enqueueContinuation(input: {
    decisionMessage: StoredMessage;
    leaseId: string;
    generation: number;
    reviewerCatId: string;
    predecessorCatId: string;
    predecessorThreadId: string;
  }): Promise<{ outcome: 'enqueued' | 'replayed'; queueEntryId: string }>;
}

function routesTo(message: StoredMessage, catId: string): boolean {
  return message.extra?.targetCats?.includes(catId) === true || message.mentions.includes(createCatId(catId));
}

function validateLease(
  resolved: ResolvedLegacyLocalReviewSource,
  lease: ActionSuccessorLease | null,
): LegacyLocalReviewInspectionResult {
  if (!lease) return { outcome: 'stale', reason: 'review_lease_missing' };
  const { source, subjectRef, reviewerCatId } = resolved;
  if (lease.leaseId !== resolved.leaseRef.leaseId || lease.generation !== resolved.leaseRef.generation) {
    return { outcome: 'stale', reason: 'review_source_generation_mismatch' };
  }
  const predecessorCatId = lease.predecessorCatId;
  const predecessorThreadId = lease.predecessorThreadId;
  if (
    lease.tenantScope !== source.userId ||
    lease.subjectRef !== subjectRef ||
    lease.actionFamily !== 'review' ||
    lease.successorSlot !== 'reviewer' ||
    lease.mode !== 'single' ||
    lease.claimOrigin !== 'structured_transfer' ||
    lease.holderCatIds.length !== 1 ||
    lease.holderCatIds[0] !== reviewerCatId ||
    !predecessorCatId ||
    !predecessorThreadId ||
    lease.holderThreadId.length === 0
  ) {
    return { outcome: 'ineligible', reason: 'review_lease_identity_mismatch' };
  }
  if (source.threadId !== predecessorThreadId || !routesTo(source, predecessorCatId)) {
    return { outcome: 'ineligible', reason: 'review_terminal_predecessor_route_mismatch' };
  }
  if (
    lease.holderThreadId !== predecessorThreadId &&
    source.extra?.crossPost?.sourceThreadId !== lease.holderThreadId
  ) {
    return { outcome: 'ineligible', reason: 'review_terminal_holder_route_mismatch' };
  }
  if (lease.terminalPredicate?.kind !== 'review_delivered' || !lease.terminalPredicate.headSha) {
    return { outcome: 'ineligible', reason: 'review_terminal_predicate_missing' };
  }
  if (lease.returnTransitions.length > 0) {
    return { outcome: 'stale', reason: 'review_lease_already_returned' };
  }
  if (Object.keys(lease.completionCandidates).length > 0) {
    return { outcome: 'ineligible', reason: 'review_lease_has_completion_candidate' };
  }
  if (lease.status === 'active' && Object.keys(lease.holderOutcomes).length > 0) {
    return { outcome: 'stale', reason: 'review_lease_has_holder_outcome' };
  }
  return {
    outcome: 'eligible',
    sourceMessageId: source.id,
    leaseId: lease.leaseId,
    generation: lease.generation,
    subjectRef,
    reviewerCatId,
    predecessorCatId,
    predecessorThreadId,
    reviewedHeadSha: lease.terminalPredicate.headSha,
  };
}

function decisionIdempotencyKey(sourceMessageId: string): string {
  return `legacy-local-review-disposition:${sourceMessageId}`;
}

function decisionEvidenceRef(input: {
  decisionMessageId: string;
  sourceMessageId: string;
  generation: number;
  verdict: LegacyLocalReviewDispositionVerdict;
}): string {
  for (const [field, value] of [
    ['decisionMessageId', input.decisionMessageId],
    ['sourceMessageId', input.sourceMessageId],
  ] as const) {
    if (!value || /[:\s]/.test(value)) throw new Error(`${field} is not a canonical message id`);
  }
  return `legacy-local-review-disposition:${input.decisionMessageId}:source:${input.sourceMessageId}:g${input.generation}:${input.verdict}`;
}

function decisionMatches(
  message: StoredMessage,
  eligibility: LegacyLocalReviewEligibility,
  ownerUserId: string,
  verdict: LegacyLocalReviewDispositionVerdict,
): boolean {
  const disposition = message.extra?.legacyLocalReviewDisposition;
  return Boolean(
    disposition &&
      message.userId === ownerUserId &&
      message.catId === null &&
      message.threadId === eligibility.predecessorThreadId &&
      disposition.sourceMessageId === eligibility.sourceMessageId &&
      disposition.leaseId === eligibility.leaseId &&
      disposition.generation === eligibility.generation &&
      disposition.subjectRef === eligibility.subjectRef &&
      disposition.reviewerCatId === eligibility.reviewerCatId &&
      disposition.predecessorCatId === eligibility.predecessorCatId &&
      disposition.reviewedHeadSha === eligibility.reviewedHeadSha &&
      disposition.verdict === verdict &&
      (message.deliveryStatus === undefined ||
        message.deliveryStatus === 'queued' ||
        message.deliveryStatus === 'delivered') &&
      message.mentions.length === 1 &&
      message.mentions[0] === eligibility.predecessorCatId &&
      message.extra?.targetCats?.length === 1 &&
      message.extra.targetCats[0] === eligibility.predecessorCatId,
  );
}

function createDecisionMessage(
  eligibility: LegacyLocalReviewEligibility,
  ownerUserId: string,
  decisionId: string,
  verdict: LegacyLocalReviewDispositionVerdict,
  now: number,
): AppendMessageInput {
  const verdictLabel = verdict === 'approved' ? '通过' : '需要修改';
  return {
    userId: ownerUserId,
    catId: null,
    threadId: eligibility.predecessorThreadId,
    content:
      `operator 对旧 Review 的结算选择为“${verdictLabel}”。` +
      `来源消息：${eligibility.sourceMessageId}；冻结 HEAD：${eligibility.reviewedHeadSha}。` +
      '系统未解析原评论正文。',
    mentions: [createCatId(eligibility.predecessorCatId)],
    timestamp: now,
    idempotencyKey: decisionIdempotencyKey(eligibility.sourceMessageId),
    extra: {
      targetCats: [eligibility.predecessorCatId],
      legacyLocalReviewDisposition: {
        sourceMessageId: eligibility.sourceMessageId,
        leaseId: eligibility.leaseId,
        generation: eligibility.generation,
        subjectRef: eligibility.subjectRef,
        reviewerCatId: eligibility.reviewerCatId,
        predecessorCatId: eligibility.predecessorCatId,
        reviewedHeadSha: eligibility.reviewedHeadSha,
        verdict,
        decisionId,
      },
    },
  };
}

async function prepareDecisionForQueue(
  messageStore: LegacyLocalReviewDispositionServiceDeps['messageStore'],
  decisionMessage: StoredMessage,
): Promise<StoredMessage> {
  if (decisionMessage.deliveryStatus === 'delivered') return decisionMessage;
  const prepared = await messageStore.prepareQueueAdmission(decisionMessage.id);
  if (prepared.kind !== 'prepared' && prepared.kind !== 'existing') {
    throw new Error(`legacy review decision Queue admission failed: ${prepared.kind}`);
  }
  return prepared.message;
}

export class LegacyLocalReviewDispositionService {
  constructor(private readonly deps: LegacyLocalReviewDispositionServiceDeps) {}

  private resolveSource(sourceMessageId: string, ownerUserId: string): Promise<ResolvedLegacyLocalReviewSource | null> {
    return resolveLegacyLocalReviewSource(this.deps, sourceMessageId, ownerUserId);
  }

  async inspect(input: { sourceMessageId: string; ownerUserId: string }): Promise<LegacyLocalReviewInspectionResult> {
    const resolved = await this.resolveSource(input.sourceMessageId, input.ownerUserId);
    if (!resolved) return { outcome: 'ineligible', reason: 'review_terminal_source_ineligible' };
    const lease = await this.deps.leaseStore.get(resolved.leaseRef.leaseId);
    const eligibility = validateLease(resolved, lease);
    if (eligibility.outcome !== 'eligible') return eligibility;
    if (lease?.status !== 'active') return { outcome: 'stale', reason: 'review_lease_not_active' };
    return eligibility;
  }

  async settle(input: {
    sourceMessageId: string;
    ownerUserId: string;
    decisionId: string;
    verdict: LegacyLocalReviewDispositionVerdict;
    now: number;
  }): Promise<LegacyLocalReviewSettlementResult> {
    if (!LEGACY_LOCAL_REVIEW_DISPOSITION_VERDICTS.includes(input.verdict)) {
      return { outcome: 'ineligible', reason: 'invalid_verdict' };
    }
    const resolved = await this.resolveSource(input.sourceMessageId, input.ownerUserId);
    if (!resolved) return { outcome: 'ineligible', reason: 'review_terminal_source_ineligible' };
    const idempotencyKey = decisionIdempotencyKey(input.sourceMessageId);
    const existingDecision = await this.deps.messageStore.getByIdempotencyKey(
      input.ownerUserId,
      resolved.source.threadId,
      idempotencyKey,
    );
    const lease = await this.deps.leaseStore.get(resolved.leaseRef.leaseId);
    const eligibility = validateLease(resolved, lease);
    if (eligibility.outcome !== 'eligible') return eligibility;
    if (existingDecision && !decisionMatches(existingDecision, eligibility, input.ownerUserId, input.verdict)) {
      return { outcome: 'conflict', reason: 'decision_verdict_mismatch' };
    }

    const append = existingDecision
      ? { message: existingDecision, idempotent: true }
      : await this.deps.messageStore.appendIdempotent(
          createDecisionMessage(eligibility, input.ownerUserId, input.decisionId, input.verdict, input.now),
        );
    const decisionMessage = append.message;
    if (!decisionMatches(decisionMessage, eligibility, input.ownerUserId, input.verdict)) {
      return { outcome: 'conflict', reason: 'decision_message_mismatch' };
    }
    const evidenceRef = decisionEvidenceRef({
      decisionMessageId: decisionMessage.id,
      sourceMessageId: input.sourceMessageId,
      generation: eligibility.generation,
      verdict: input.verdict,
    });

    const recovery = await this.deps.leaseStore.recoverLocalReviewVerdict(eligibility.leaseId, {
      expectedGeneration: eligibility.generation,
      reviewerCatId: eligibility.reviewerCatId,
      predecessorCatId: eligibility.predecessorCatId,
      predecessorThreadId: eligibility.predecessorThreadId,
      tenantScope: input.ownerUserId,
      headSha: eligibility.reviewedHeadSha,
      evidenceRef,
      now: input.now,
    });
    if (recovery.outcome !== 'recovered' && recovery.outcome !== 'replayed') {
      return { outcome: 'stale', reason: recovery.outcome };
    }

    try {
      const admittedDecision = await prepareDecisionForQueue(this.deps.messageStore, decisionMessage);
      if (!decisionMatches(admittedDecision, eligibility, input.ownerUserId, input.verdict)) {
        return { outcome: 'conflict', reason: 'decision_message_mismatch' };
      }
      const continuation = await this.deps.enqueueContinuation({
        decisionMessage: admittedDecision,
        leaseId: eligibility.leaseId,
        generation: eligibility.generation,
        reviewerCatId: eligibility.reviewerCatId,
        predecessorCatId: eligibility.predecessorCatId,
        predecessorThreadId: eligibility.predecessorThreadId,
      });
      return {
        outcome: 'committed',
        replayed: recovery.outcome === 'replayed',
        leaseId: eligibility.leaseId,
        generation: eligibility.generation,
        decisionMessageId: decisionMessage.id,
        queueEntryId: continuation.queueEntryId,
      };
    } catch (error) {
      return {
        outcome: 'continuation_pending',
        reason: error instanceof Error ? error.message : String(error),
        leaseId: eligibility.leaseId,
        generation: eligibility.generation,
        decisionMessageId: decisionMessage.id,
      };
    }
  }
}
