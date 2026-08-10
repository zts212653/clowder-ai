import type { EvalLifecycleEvent, EvalLifecycleRef, EvalVerdictLifecycleStatus } from './reeval-closure-schema.js';

export interface ReevalCaseCycleRoot {
  verdictId: string;
  createdAt: string;
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
}

export interface ReevalCaseRoot {
  caseId: string;
  domainId: string;
  targetOwnerCatId: string;
  assignedEvalCatId?: string;
  reevalWithinHours?: number;
  cycles: readonly ReevalCaseCycleRoot[];
}

export interface ReevalCaseResponsibilityBlocker {
  eventId: string;
  reasonCode: 'feature_thread_not_found' | 'feature_thread_ambiguous';
  featureId: string;
  ownerCatId: string;
  candidateThreadIds: readonly string[];
}

export interface ReevalCaseProjection {
  caseId: string;
  domainId: string;
  status: EvalVerdictLifecycleStatus;
  sequence: number;
  targetOwnerCatId: string;
  lifecycleOwnerCatId?: string;
  activeVerdictId: string;
  observedVerdictIds: readonly string[];
  taskId?: string;
  leaseId?: string;
  leaseGeneration?: number;
  responsibilityBlocker?: ReevalCaseResponsibilityBlocker;
  mainCommitSha?: string;
  liveCommitSha?: string;
  reevalDueAt?: string;
  reevalAssignedCatId?: string;
  reevalTaskId?: string;
  reevalLeaseId?: string;
  reevalLeaseGeneration?: number;
  closureReason?: string;
  escalation?: { eventId: string; stage: 'acknowledgement' | 'reevaluation'; dueAt: string };
  refs: readonly EvalLifecycleRef[];
  ownerResponseRefs: readonly EvalLifecycleRef[];
  planRefs: readonly EvalLifecycleRef[];
  actionRefs: readonly EvalLifecycleRef[];
  reevalRefs: readonly EvalLifecycleRef[];
  history: readonly EvalLifecycleEvent[];
}
