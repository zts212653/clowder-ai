import { createHash } from 'node:crypto';
import { type OwnerTruthRefV1, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import { locateEvalRepairApproval } from '../../harness-eval/eval-repair-approval-contracts.js';
import type { EvalRepairBoundRefs } from '../../harness-eval/eval-repair-outcome-contracts.js';
import { evalRepairCaseRef, evalRepairProposalRef } from '../../harness-eval/eval-repair-outcome-refs.js';
import { REQUEST_REVIEW_OWNER_FEATURE_ID } from '../adapters/request-review/request-review-owner-identity.js';

type Located = NonNullable<Awaited<ReturnType<typeof locateEvalRepairApproval>>>;

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function ownerRef(kind: string, value: unknown): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
    ownerStateRef: `${kind}:request-review-${digest(value)}`,
  });
}

export function sameRef(left: unknown, right: unknown): boolean {
  try {
    return refIdentity(left as never) === refIdentity(right as never);
  } catch {
    return false;
  }
}

export function validTime(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function boundRefs(located: Located): EvalRepairBoundRefs | null {
  const record = located.record;
  if (!record.approvalRef || !record.proposal.ownerLineage) return null;
  return {
    caseRef: evalRepairCaseRef(located.caseId, record.proposal.verdictId),
    proposalRef: evalRepairProposalRef(record.proposal.proposalId),
    approvalRef: record.approvalRef,
    ownerAuthorizationRef: record.proposal.requestSnapshot.ownerAuthorizationRef,
    targetVersionRef: record.proposal.requestSnapshot.targetVersionRef,
    interventionRef: record.proposal.ownerLineage.interventionRef,
  };
}
