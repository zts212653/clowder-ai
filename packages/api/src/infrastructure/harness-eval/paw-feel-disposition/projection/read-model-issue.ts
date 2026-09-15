import type {
  PawFeelDispositionProjection,
  PawFeelInboxItem,
  PawFeelIssueCounts,
  PawFeelIssueProjection,
} from '@cat-cafe/shared';
import { PAW_FEEL_OVERDUE_MS } from '../read-model-pagination.js';

export interface PawFeelIssueEvidence {
  resolution?: 'open' | 'resolved';
  continuation?: PawFeelIssueProjection['continuation'];
  resumeAt?: string;
  resolvedAt?: string;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function repairIdentity(projection: PawFeelDispositionProjection) {
  return {
    ...(projection.ownerCatId ? { ownerCatId: projection.ownerCatId } : {}),
    ...(projection.taskId ? { taskId: projection.taskId } : {}),
    ...(projection.actionLeaseRef ? { leaseId: projection.actionLeaseRef.leaseId } : {}),
  };
}

function verifiedOutcomeContinuation(projection: PawFeelDispositionProjection): PawFeelIssueProjection['continuation'] {
  const outcome = projection.repairOutcome;
  if (!outcome) throw new Error('verified outcome continuation requires an outcome');
  const binding = projection.directRepairBinding;
  return {
    kind: 'verified_outcome',
    evidenceRefs: compact([
      binding?.bindingRef.ownerStateRef,
      binding?.sourceSignalRef.ownerStateRef,
      binding?.sourceToolRef.ownerStateRef,
      binding?.providerRouteRef.ownerStateRef,
      binding?.resolvedActionRef.ownerStateRef,
      binding?.actionScopeRef.ownerStateRef,
      binding?.ownerAuthorizationRef.ownerStateRef,
      binding?.targetVersionRef.ownerStateRef,
      binding?.outcomeVerifierRef.ownerStateRef,
      outcome.taskTerminalRef.ownerStateRef,
      outcome.leaseTerminalRef.ownerStateRef,
      outcome.ownerOutcomeRef.ownerStateRef,
      ...outcome.verificationRefs.map((ref) => ref.ownerStateRef),
    ]),
    ...repairIdentity(projection),
  };
}

function blockedContinuation(projection: PawFeelDispositionProjection): PawFeelIssueProjection['continuation'] {
  if (!projection.blocker) return { kind: 'review_required', evidenceRefs: [] };
  return {
    kind: projection.blocker.resumeCondition ? 'blocked' : 'legacy_blocker_unbound',
    evidenceRefs: [projection.blocker.ref],
  };
}

function repairContinuation(projection: PawFeelDispositionProjection): PawFeelIssueProjection['continuation'] {
  return {
    kind: 'repair_active',
    evidenceRefs: compact([
      projection.taskId,
      projection.actionLeaseRef?.leaseId,
      projection.directRepairBinding?.bindingRef.ownerStateRef,
    ]),
    ...repairIdentity(projection),
  };
}

function routeContinuation(projection: PawFeelDispositionProjection): PawFeelIssueProjection['continuation'] {
  return {
    kind: 'route_pending',
    evidenceRefs: compact([projection.proposalId, projection.targetThreadId]),
    ...(projection.proposalId ? { proposalId: projection.proposalId } : {}),
  };
}

function defaultContinuation(projection: PawFeelDispositionProjection): PawFeelIssueProjection['continuation'] {
  if (projection.repairOutcome) return verifiedOutcomeContinuation(projection);
  switch (projection.state) {
    case 'no_action':
      return {
        kind: 'no_action',
        evidenceRefs: compact([projection.reasonCode]),
        ...(projection.ownerCatId ? { ownerCatId: projection.ownerCatId } : {}),
      };
    case 'closed':
      return {
        kind: 'done_unverified',
        evidenceRefs: compact([projection.outcomeRef, projection.reasonCode]),
      };
    case 'duplicate':
      return {
        kind: 'duplicate_following',
        evidenceRefs: [projection.duplicateOf].filter((value): value is string => Boolean(value)),
        ...(projection.duplicateOf ? { canonicalSignalId: projection.duplicateOf } : {}),
      };
    case 'blocked':
      return blockedContinuation(projection);
    case 'fix':
      return repairContinuation(projection);
    case 'signature_waiting':
      return {
        kind: 'signature_required',
        evidenceRefs: compact([projection.signatureRequest?.requestId]),
      };
    case 'route_pending':
    case 'routed':
      return routeContinuation(projection);
    default:
      return { kind: 'review_required', evidenceRefs: [] };
  }
}

export function derivePawFeelIssue(
  projection: PawFeelDispositionProjection,
  nowMs: number,
  evidence: PawFeelIssueEvidence = {},
): PawFeelIssueProjection {
  const resolution =
    evidence.resolution ?? (projection.state === 'no_action' || projection.repairOutcome ? 'resolved' : 'open');
  const resolvedAt = evidence.resolvedAt ?? (resolution === 'resolved' ? projection.lastTransitionAt : undefined);
  const discoveredAtMs = Date.parse(projection.discoveredAt);
  const endAtMs = resolvedAt ? Date.parse(resolvedAt) : nowMs;
  const ageMs = Math.max(0, (Number.isFinite(endAtMs) ? endAtMs : nowMs) - discoveredAtMs);
  const resumeAt =
    evidence.resumeAt ??
    (projection.blocker?.resumeCondition?.selector.kind === 'bounded_time'
      ? projection.blocker.resumeCondition.selector.recheckAt
      : undefined);
  return {
    resolution,
    continuation: evidence.continuation ?? defaultContinuation(projection),
    ageMs,
    ...(resumeAt ? { resumeAt } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  };
}

export function deriveBundleIssue(members: readonly PawFeelInboxItem[]): PawFeelIssueProjection {
  const issues = members.map((member) => member.issue);
  if (issues.length === 0) throw new Error('paw-feel issue bundle has no members');
  const open = issues.filter((issue) => issue.resolution === 'open');
  const selected = open[0] ?? issues[0];
  if (!selected) throw new Error('paw-feel issue bundle has no projection');
  const evidenceRefs = [
    ...new Set((open.length > 0 ? open : issues).flatMap((issue) => issue.continuation.evidenceRefs)),
  ];
  const resumeAt = (open.length > 0 ? open : issues)
    .map((issue) => issue.resumeAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const resolvedAt =
    open.length === 0
      ? issues
          .map((issue) => issue.resolvedAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1)
      : undefined;
  return {
    resolution: open.length > 0 ? 'open' : 'resolved',
    continuation: { ...selected.continuation, evidenceRefs },
    ageMs: Math.max(...issues.map((issue) => issue.ageMs)),
    ...(resumeAt ? { resumeAt } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  };
}

export function emptyPawFeelIssueCounts(): PawFeelIssueCounts {
  return { open: 0, resolved: 0, overdue: 0 };
}

export function countPawFeelIssues(items: readonly PawFeelInboxItem[]): PawFeelIssueCounts {
  const counts = emptyPawFeelIssueCounts();
  for (const item of items) {
    counts[item.issue.resolution] += 1;
    if (item.issue.resolution === 'open' && item.issue.ageMs >= PAW_FEEL_OVERDUE_MS) counts.overdue += 1;
  }
  return counts;
}
