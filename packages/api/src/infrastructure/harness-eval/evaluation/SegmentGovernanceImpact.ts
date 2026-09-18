import type { CycleRecord, SegmentCycleSummary } from '@cat-cafe/shared';
import type { HarnessGovernanceProposalStore } from '../governance/HarnessGovernanceProposalStore.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export async function projectSegmentGovernanceImpact(
  runtime: ObjectiveEvaluationRuntime,
  proposals: Pick<HarnessGovernanceProposalStore, 'get'> | undefined,
  record: CycleRecord,
  nextRecord: CycleRecord | undefined,
  segmentId: string,
): Promise<SegmentCycleSummary['governanceImpact']> {
  const proposal = record.approval?.cardId && proposals ? await proposals.get(record.approval.cardId) : null;
  if (!proposal) return null;
  const changedUnitIds = [...new Set(proposal.changes.map((change) => change.unitId))].sort();
  const appliedNext = record.approval?.state === 'approved' ? nextRecord : undefined;
  const changes = await Promise.all(
    proposal.changes.map(async (change) => {
      const [frozenVersion, resultingVersion] = await Promise.all([
        runtime.resolveSegmentVersion(record.versionContentRef, change.unitId),
        appliedNext
          ? runtime.resolveSegmentVersion(appliedNext.versionContentRef, change.unitId)
          : Promise.resolve(null),
      ]);
      return {
        action: change.action,
        unitId: change.unitId,
        sourceVersion: 'sourceVersion' in change ? change.sourceVersion : frozenVersion,
        targetVersion:
          change.action === 'rollback'
            ? change.targetVersion
            : change.action === 'modify' || change.action === 'add'
              ? resultingVersion
              : (resultingVersion ?? frozenVersion),
      };
    }),
  );
  return { changedUnitIds, selectedSegmentChanged: changedUnitIds.includes(segmentId), changes };
}
