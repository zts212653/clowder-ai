import type { CycleCoverageAssessment, CycleMetricEvaluation } from './cycle-evaluation.js';
import type { CycleTriggerRoute, CycleWindow } from './harness-evaluation.js';
import type { HookCondition } from './hook-override.js';
import type { HookManifest } from './prompt-hook.js';

/** F257 TC-8/9: the eval cat's structured governance writeback. */
export type CycleGovernanceDecision = 'keep' | 'rollback' | 'evolve';

export interface HarnessUnitAddDraft {
  unitId: string;
  assetSlug: string;
  manifest: HookManifest;
  content: string;
  objectives: Array<{ objectiveId: string; clauseId?: string }>;
}

/** Merge is expressed without a fourth action: disable A and modify B. */
export type HarnessGovernanceChangeDraft =
  | { action: 'enable'; unitId: string; reason: string }
  | { action: 'disable'; unitId: string; reason: string }
  | {
      action: 'modify';
      unitId: string;
      reason: string;
      proposedContent?: string;
      /** null clears a prior narrowing override; omission leaves it unchanged. */
      proposedCondition?: HookCondition | null;
    }
  | { action: 'add'; reason: string; unit: HarnessUnitAddDraft };

export interface CycleGovernanceSubmission {
  objectiveId: string;
  cycleId: string;
  decision: CycleGovernanceDecision;
  reason: string;
  rollback?: { unitId: string; targetVersion: number };
  v2Draft?: { changes: HarnessGovernanceChangeDraft[] };
}

export interface CycleGovernanceHistorySummary {
  cycleId: string;
  version: string;
  windows: CycleWindow[];
  evaluation: {
    overall: 'complete' | 'partial' | 'insufficient_evidence';
    metrics: CycleMetricEvaluation[];
    writtenAt: number;
    coverageAssessment?: CycleCoverageAssessment;
  };
  governance?: { decision: CycleGovernanceDecision; reason: string; writtenAt: number; by: string };
  approval?: { state: 'approved' | 'skipped' | 'rejected'; reason?: string; by?: string; at: number };
}

export interface CycleGovernanceAssignment {
  objective: { id: string; label: string; statement: string };
  cycleId: string;
  version: string;
  versionContentRef: string;
  windows: CycleWindow[];
  triggeredBy: CycleTriggerRoute[];
  evaluation: {
    overall: 'complete' | 'partial';
    metrics: CycleMetricEvaluation[];
    writtenAt: number;
    coverageAssessment?: CycleCoverageAssessment;
  };
  history: CycleGovernanceHistorySummary[];
  rejectedProposalReasons: string[];
  unitTool: 'cat_cafe_describe_harness_unit(unitId)';
  writebackTool: 'cat_cafe_submit_cycle_governance(objectiveId, cycleId, decision, reason, rollback?, v2Draft?)';
}

export type HarnessGovernanceProposalStatus = 'pending' | 'approved' | 'skipped' | 'rejected';

export type HarnessGovernanceProposalChange =
  | {
      action: 'enable';
      unitId: string;
      hookId: string;
      reason: string;
      beforeEnabled: boolean;
      beforeContent: string;
      objectiveImpact: { objectiveId: string; remainingMemberCount: number };
    }
  | {
      action: 'disable';
      unitId: string;
      hookId: string;
      reason: string;
      beforeEnabled: boolean;
      beforeContent: string;
      objectiveImpact: { objectiveId: string; remainingMemberCount: number };
    }
  | {
      action: 'modify';
      unitId: string;
      hookId: string;
      reason: string;
      sourceVersion: number;
      beforeContent: string;
      proposedContent?: string;
      beforeCondition: HookCondition | null;
      proposedCondition?: HookCondition | null;
    }
  | {
      action: 'rollback';
      unitId: string;
      hookId: string;
      reason: string;
      sourceVersion: number;
      targetVersion: number;
      beforeContent: string;
      targetContent: string;
    }
  | {
      action: 'add';
      unitId: string;
      hookId: string;
      assetSlug: string;
      reason: string;
      manifest: HookManifest;
      content: string;
      objectives: Array<{ objectiveId: string; clauseId?: string }>;
    };

/** Canonical operator card. Prompt content is stored; trace bodies never are. */
export interface HarnessGovernanceProposal {
  schemaVersion: 1;
  proposalId: string;
  ownerUserId: string;
  objective: { id: string; label: string; statement: string };
  objectiveId: string;
  cycleId: string;
  threadId: string;
  cardOrdinal: number;
  decision: Exclude<CycleGovernanceDecision, 'keep'>;
  status: HarnessGovernanceProposalStatus;
  reason: string;
  version: string;
  versionContentRef: string;
  windows: CycleWindow[];
  triggeredBy: CycleTriggerRoute[];
  triggerCounts: {
    cumulative: { count: number; threshold: number };
    counterexamples: { count: number; threshold: number };
  };
  evaluation: {
    overall: 'complete' | 'partial';
    metrics: CycleMetricEvaluation[];
    writtenAt: number;
    coverageAssessment?: CycleCoverageAssessment;
  };
  history: CycleGovernanceHistorySummary[];
  rejectReasons: string[];
  changes: HarnessGovernanceProposalChange[];
  evidenceRefs: string[];
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionReason?: string;
}
