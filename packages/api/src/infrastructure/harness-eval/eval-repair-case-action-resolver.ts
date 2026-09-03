import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import type { EvalRepairCaseAction } from './eval-repair-approval-contracts.js';
import { scanLifecycleRootArtifacts } from './publish-verdict/lifecycle-root-artifact.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

type ReadyEvent = Extract<EvalLifecycleEvent, { type: 'case_ready_for_proposal' }>;
type SupersededEvent = Extract<EvalLifecycleEvent, { type: 'approval_superseded' }>;
type ProposedEvent = Extract<EvalLifecycleEvent, { type: 'approval_proposed' }>;

export class EvalRepairCaseActionResolver {
  constructor(
    private readonly harnessFeedbackRoot: string,
    private readonly eventLog: IReevalClosureEventLog,
  ) {}

  async resolve(caseActionRef: string): Promise<EvalRepairCaseAction | null> {
    for (const subjectId of await this.eventLog.listSubjectIds()) {
      const events = await this.eventLog.read(subjectId);
      const ready = events.find(
        (event): event is ReadyEvent =>
          event.type === 'case_ready_for_proposal' && event.caseActionRef === caseActionRef,
      );
      const superseded = events.find(
        (event): event is SupersededEvent =>
          event.type === 'approval_superseded' && event.freshCaseActionRef === caseActionRef,
      );
      if (!ready && !superseded) continue;
      const sourceProposal =
        superseded?.type === 'approval_superseded'
          ? events.find(
              (event): event is ProposedEvent =>
                event.type === 'approval_proposed' && event.proposalId === superseded.proposalId,
            )
          : undefined;
      const findingArtifactRef = ready ? ready.findingArtifactRef : sourceProposal?.findingArtifactRef;
      if (!findingArtifactRef) return null;
      const trigger = ready ?? superseded;
      if (!trigger) continue;
      const root = scanLifecycleRootArtifacts(this.harnessFeedbackRoot).find(
        (candidate) =>
          candidate.schemaVersion === 3 &&
          candidate.caseId === trigger.caseId &&
          candidate.verdictId === trigger.verdictId &&
          candidate.findingBinding.artifactRef === findingArtifactRef,
      );
      if (!root || root.schemaVersion !== 3) return null;
      const targetVersionRef = trigger.requestSnapshot?.targetVersionRef as ExactAssetVersionRefV1 | undefined;
      return {
        caseId: root.caseId,
        verdictId: root.verdictId,
        domainId: root.domainId,
        findingKey: root.findingKey,
        analysisDisposition: root.findingBinding.analysisDisposition,
        approvalRequirement: root.findingBinding.approvalRequirement,
        findingArtifactRef: root.findingBinding.artifactRef,
        repairTarget: {
          featureId: root.repairTarget.featureId,
          ...(root.repairTarget.componentId ? { componentId: root.repairTarget.componentId } : {}),
          version: targetVersionRef?.version ?? root.repairTarget.version,
        },
        expectedChange: root.ownerAsk.requestedAction,
        costAndRollback:
          'Execution is limited by the owner-backed authorization and exact target refs; rollback remains with the canonical asset owner.',
        withdrawalCondition: 'Supersede this proposal whenever owner, authorization, or exact target truth changes.',
        ...(trigger.type === 'approval_superseded'
          ? { supersedesProposalId: trigger.proposalId }
          : trigger.supersedesProposalId
            ? { supersedesProposalId: trigger.supersedesProposalId }
            : {}),
      };
    }
    return null;
  }
}
