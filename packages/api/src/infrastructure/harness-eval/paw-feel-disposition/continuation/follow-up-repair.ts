import type {
  PawFeelContinuationProjection,
  PawFeelDispositionProjection,
  PawFeelIssueProjection,
} from '@cat-cafe/shared';
import { derivePawFeelIssue } from '../projection/read-model-issue.js';

export type PawFeelRepairProgress =
  | { status: 'active'; evidenceRefs: string[] }
  | { status: 'done_unverified'; evidenceRefs: string[] }
  | { status: 'interrupted'; evidenceRefs: string[] };

export interface PawFeelRepairProgressResolver {
  resolve(projection: PawFeelDispositionProjection): Promise<PawFeelRepairProgress>;
}

export interface PawFeelDirectRepairBindingStatusResolver {
  resolveStatus(
    projection: PawFeelDispositionProjection,
  ): Promise<
    { status: 'current'; evidenceRefs: string[] } | { status: 'blocked'; reasonCode: string; evidenceRefs: string[] }
  >;
}

function progressKind(status: PawFeelRepairProgress['status']): PawFeelContinuationProjection['kind'] {
  if (status === 'active') return 'repair_active';
  return status === 'done_unverified' ? 'done_unverified' : 'repair_interrupted';
}

function identityFields(projection: PawFeelDispositionProjection) {
  return {
    ...(projection.ownerCatId ? { ownerCatId: projection.ownerCatId } : {}),
    ...(projection.taskId ? { taskId: projection.taskId } : {}),
    ...(projection.actionLeaseRef ? { leaseId: projection.actionLeaseRef.leaseId } : {}),
  };
}

export async function resolvePawFeelRepairFollowUp(input: {
  projection: PawFeelDispositionProjection;
  nowMs: number;
  base: PawFeelIssueProjection;
  progressResolver?: PawFeelRepairProgressResolver;
  bindingResolver?: PawFeelDirectRepairBindingStatusResolver;
}): Promise<PawFeelIssueProjection | undefined> {
  const { projection, progressResolver } = input;
  if (projection.state !== 'fix' || projection.repairOutcome || !progressResolver) return undefined;
  try {
    const bindingStatus = projection.directRepairBinding
      ? await input.bindingResolver?.resolveStatus(projection)
      : undefined;
    if (bindingStatus?.status === 'blocked') {
      return derivePawFeelIssue(projection, input.nowMs, {
        continuation: {
          kind: 'direct_route_blocked',
          reasonCode: bindingStatus.reasonCode,
          evidenceRefs: bindingStatus.evidenceRefs,
          ...identityFields(projection),
        },
      });
    }
    const progress = await progressResolver.resolve(projection);
    return derivePawFeelIssue(projection, input.nowMs, {
      continuation: {
        kind: progressKind(progress.status),
        evidenceRefs: [...new Set([...(bindingStatus?.evidenceRefs ?? []), ...progress.evidenceRefs])],
        ...identityFields(projection),
      },
    });
  } catch {
    return derivePawFeelIssue(projection, input.nowMs, {
      continuation: {
        kind: 'repair_interrupted',
        evidenceRefs: input.base.continuation.evidenceRefs,
        ...identityFields(projection),
      },
    });
  }
}
