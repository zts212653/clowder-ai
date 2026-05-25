// F073 P1: Mission Hub 告示牌 — WorkflowSop types
// 告示牌哲学：存信息，不控制流程。猫看了自己决定行动。

import type { DevelopmentSopStageId, SopDefinitionId } from './sop-definition.generated.js';

export type SopStage = DevelopmentSopStageId;

export type CheckStatus = 'attested' | 'verified' | 'unknown';

export interface ResumeCapsule {
  readonly goal: string;
  readonly done: readonly string[];
  readonly currentFocus: string;
}

export interface SopChecks {
  readonly remoteMainSynced: CheckStatus;
  readonly qualityGatePassed: CheckStatus;
  readonly reviewApproved: CheckStatus;
  readonly visionGuardDone: CheckStatus;
}

export interface WorkflowSop {
  readonly featureId: string;
  readonly backlogItemId: string;
  readonly sopDefinitionId: SopDefinitionId;
  readonly stage: SopStage;
  readonly batonHolder: string;
  /** Manual override. Null means use SopDefinition suggestedSkill for the current stage. */
  readonly nextSkill: string | null;
  readonly resumeCapsule: ResumeCapsule;
  readonly checks: SopChecks;
  readonly version: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface UpdateWorkflowSopInput {
  readonly sopDefinitionId?: SopDefinitionId;
  readonly stage?: SopStage;
  readonly batonHolder?: string;
  readonly nextSkill?: string | null;
  readonly resumeCapsule?: Partial<ResumeCapsule>;
  readonly checks?: Partial<SopChecks>;
  readonly expectedVersion?: number;
}
