import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface LegacyLocalReviewContinuationStartupRecoveryDeps {
  messageStore: Pick<IMessageStore, 'getById' | 'prepareQueueAdmission' | 'scanPendingLegacyLocalReviewDispositions'>;
  leaseStore?: Pick<ActionSuccessorLeaseStore, 'get'>;
  log: { info(message: string): void; warn(message: string): void };
}

export interface LegacyLocalReviewContinuationStartupRecoveryResult {
  scanned: number;
  admitted: number;
  deferred: number;
  failed: number;
}

async function recoverCandidate(
  deps: LegacyLocalReviewContinuationStartupRecoveryDeps,
  id: string,
): Promise<'admitted' | 'deferred' | 'ignored'> {
  const message = await deps.messageStore.getById(id);
  const disposition = message?.extra?.legacyLocalReviewDisposition;
  if (!message || !disposition || message.deliveryStatus !== undefined || message.queueCustody) return 'ignored';
  const lease = await deps.leaseStore?.get(disposition.leaseId);
  if (!exactSettledDecision(message, lease ?? null)) return 'deferred';
  const prepared = await deps.messageStore.prepareQueueAdmission(message.id);
  if (prepared.kind !== 'prepared' && prepared.kind !== 'existing') {
    throw new Error(`Queue admission failed: ${prepared.kind}`);
  }
  return 'admitted';
}

async function scanPendingDecisionIds(
  deps: LegacyLocalReviewContinuationStartupRecoveryDeps,
): Promise<string[] | null> {
  const scan = deps.messageStore.scanPendingLegacyLocalReviewDispositions;
  if (!scan) return [];
  try {
    return await scan.call(deps.messageStore);
  } catch (error) {
    deps.log.warn(
      `[legacy-review-startup] failed to scan pending decisions: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function exactDecisionEvidenceRef(message: StoredMessage): string | null {
  const disposition = message.extra?.legacyLocalReviewDisposition;
  if (!disposition) return null;
  for (const value of [message.id, disposition.sourceMessageId]) {
    if (!value || /[:\s]/.test(value)) return null;
  }
  return (
    `legacy-local-review-disposition:${message.id}:source:${disposition.sourceMessageId}:` +
    `g${disposition.generation}:${disposition.verdict}`
  );
}

function exactSettledDecision(message: StoredMessage, lease: ActionSuccessorLease | null): boolean {
  const disposition = message.extra?.legacyLocalReviewDisposition;
  const evidenceRef = exactDecisionEvidenceRef(message);
  if (
    !disposition ||
    !evidenceRef ||
    !lease ||
    message.deliveryStatus !== undefined ||
    message.queueCustody ||
    message.deletedAt ||
    message.catId !== null ||
    message.userId !== lease.tenantScope ||
    message.mentions.length !== 1 ||
    message.mentions[0] !== disposition.predecessorCatId ||
    message.extra?.targetCats?.length !== 1 ||
    message.extra.targetCats[0] !== disposition.predecessorCatId
  ) {
    return false;
  }
  return (
    lease.leaseId === disposition.leaseId &&
    lease.generation === disposition.generation &&
    lease.subjectRef === disposition.subjectRef &&
    lease.actionFamily === 'review' &&
    lease.successorSlot === 'reviewer' &&
    lease.mode === 'single' &&
    lease.claimOrigin === 'structured_transfer' &&
    lease.holderCatIds.length === 1 &&
    lease.holderCatIds[0] === disposition.reviewerCatId &&
    lease.predecessorCatId === disposition.predecessorCatId &&
    lease.predecessorThreadId === message.threadId &&
    lease.terminalPredicate?.kind === 'review_delivered' &&
    lease.terminalPredicate.headSha === disposition.reviewedHeadSha &&
    lease.status === 'completed' &&
    lease.holderOutcomes[disposition.reviewerCatId]?.outcome === 'succeeded' &&
    lease.holderOutcomes[disposition.reviewerCatId]?.evidenceRef === evidenceRef
  );
}

export async function recoverLegacyLocalReviewContinuationAdmissions(
  deps: LegacyLocalReviewContinuationStartupRecoveryDeps,
): Promise<LegacyLocalReviewContinuationStartupRecoveryResult> {
  if (!deps.leaseStore) return { scanned: 0, admitted: 0, deferred: 0, failed: 0 };
  const ids = await scanPendingDecisionIds(deps);
  if (!ids) return { scanned: 0, admitted: 0, deferred: 0, failed: 1 };
  let admitted = 0;
  let deferred = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const result = await recoverCandidate(deps, id);
      if (result === 'admitted') admitted += 1;
      if (result === 'deferred') deferred += 1;
    } catch (error) {
      failed += 1;
      deps.log.warn(
        `[legacy-review-startup] failed to recover decision ${id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (admitted > 0) {
    deps.log.info(
      `[legacy-review-startup] admitted ${admitted} exact post-CAS decision(s) from ${ids.length} candidate(s)`,
    );
  }
  return { scanned: ids.length, admitted, deferred, failed };
}
