import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import type { EvalRepairCaseAction } from './eval-repair-approval-contracts.js';
import {
  type FrictionAnalysisFindingV1,
  FrictionAnalysisFindingV1Schema,
} from './friction/friction-finding-artifact.js';
import { scanLifecycleRootArtifacts } from './publish-verdict/lifecycle-root-artifact.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

type ReadyEvent = Extract<EvalLifecycleEvent, { type: 'case_ready_for_proposal' }>;
type SupersededEvent = Extract<EvalLifecycleEvent, { type: 'approval_superseded' }>;
type ProposedEvent = Extract<EvalLifecycleEvent, { type: 'approval_proposed' }>;
type LifecycleRootV3 = Extract<ReturnType<typeof scanLifecycleRootArtifacts>[number], { schemaVersion: 3 }>;
type ActionTrigger = ReadyEvent | SupersededEvent;

interface TriggerMatch {
  trigger: ActionTrigger;
  findingArtifactRef: string;
}

function findTrigger(events: readonly EvalLifecycleEvent[], caseActionRef: string): TriggerMatch | null {
  const ready = events.find(
    (event): event is ReadyEvent => event.type === 'case_ready_for_proposal' && event.caseActionRef === caseActionRef,
  );
  if (ready) return { trigger: ready, findingArtifactRef: ready.findingArtifactRef };
  const superseded = events.find(
    (event): event is SupersededEvent =>
      event.type === 'approval_superseded' && event.freshCaseActionRef === caseActionRef,
  );
  if (!superseded) return null;
  const sourceProposal = events.find(
    (event): event is ProposedEvent => event.type === 'approval_proposed' && event.proposalId === superseded.proposalId,
  );
  return sourceProposal ? { trigger: superseded, findingArtifactRef: sourceProposal.findingArtifactRef } : null;
}

function artifactPath(harnessFeedbackRoot: string, artifactRef: string): string | null {
  const feedbackRoot = resolve(harnessFeedbackRoot);
  const candidate = resolve(feedbackRoot, '..', '..', artifactRef);
  const relativeToFeedback = relative(feedbackRoot, candidate);
  return isAbsolute(relativeToFeedback) || relativeToFeedback === '..' || relativeToFeedback.startsWith(`..${sep}`)
    ? null
    : candidate;
}

function findingMatchesRoot(finding: FrictionAnalysisFindingV1, root: LifecycleRootV3): boolean {
  return (
    finding.findingKey === root.findingKey &&
    finding.analysisDisposition === root.findingBinding.analysisDisposition &&
    isDeepStrictEqual(finding.approvalRequirement, root.findingBinding.approvalRequirement) &&
    finding.repairTargetResolution.status === 'resolved' &&
    isDeepStrictEqual(finding.repairTargetResolution.target, root.repairTarget)
  );
}

function projectAction(
  root: LifecycleRootV3,
  finding: FrictionAnalysisFindingV1,
  trigger: ActionTrigger,
): EvalRepairCaseAction {
  const targetVersionRef = trigger.requestSnapshot?.targetVersionRef as ExactAssetVersionRefV1 | undefined;
  const explanation = finding.decisionExplanation;
  const supersedesProposalId =
    trigger.type === 'approval_superseded' ? trigger.proposalId : trigger.supersedesProposalId;
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
    expectedChange: explanation?.expectedChange ?? root.ownerAsk.requestedAction,
    costAndRollback:
      explanation?.costAndRollback ??
      'Execution is limited by the owner-backed authorization and exact target refs; rollback remains with the canonical asset owner.',
    withdrawalCondition: finding.withdrawalCondition,
    ...(explanation ? { decisionExplanation: explanation } : {}),
    ...(supersedesProposalId ? { supersedesProposalId } : {}),
  };
}

export class EvalRepairCaseActionResolver {
  constructor(
    private readonly harnessFeedbackRoot: string,
    private readonly eventLog: IReevalClosureEventLog,
  ) {}

  private async readBoundFinding(root: LifecycleRootV3): Promise<FrictionAnalysisFindingV1 | null> {
    const path = artifactPath(this.harnessFeedbackRoot, root.findingBinding.artifactRef);
    if (!path) return null;
    let serialized: string;
    try {
      serialized = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    if (createHash('sha256').update(serialized, 'utf8').digest('hex') !== root.findingBinding.artifactSha256) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return null;
    }
    const finding = FrictionAnalysisFindingV1Schema.safeParse(parsed);
    return finding.success && findingMatchesRoot(finding.data, root) ? finding.data : null;
  }

  async resolve(caseActionRef: string): Promise<EvalRepairCaseAction | null> {
    const roots = scanLifecycleRootArtifacts(this.harnessFeedbackRoot);
    for (const subjectId of await this.eventLog.listSubjectIds()) {
      const events = await this.eventLog.read(subjectId);
      const match = findTrigger(events, caseActionRef);
      if (!match) continue;
      const root = roots.find(
        (candidate) =>
          candidate.schemaVersion === 3 &&
          candidate.caseId === match.trigger.caseId &&
          candidate.verdictId === match.trigger.verdictId &&
          candidate.findingBinding.artifactRef === match.findingArtifactRef,
      );
      if (!root || root.schemaVersion !== 3) return null;
      const finding = await this.readBoundFinding(root);
      if (!finding) return null;
      return projectAction(root, finding, match.trigger);
    }
    return null;
  }
}
