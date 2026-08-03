import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { EvalLifecycleRef, EvalVerdictLifecycleStatus } from '../reeval-closure-schema.js';
import type { EvalHubFrictionProjection } from './eval-hub-friction-projection.js';
import type { EvalHubOperatorNarrative } from './eval-hub-operator-narrative.js';

type CountRecord = Record<string, number | null>;

export interface LoadEvalHubSummaryInput {
  harnessFeedbackRoot: string;
  /** Injectable wall clock for deterministic staleness checks. */
  now?: Date;
}

export interface EvalDomainSummary {
  domainId: string;
  displayName: string;
  descriptionForHuman?: string;
  metricGlossary?: EvalDomainRegistryEntry['metricGlossary'];
  systemThreadId: string;
  frequency: string;
  evalCatId: string;
  evalCatHandle: string;
  enabled: boolean;
  hasVerdict: boolean;
  latestVerdictId?: string;
  latestVerdict?: EvalHubItem['verdict'];
  nextCronFireAt?: string;
}

export interface EvalHubSummary {
  generatedAt: string;
  repoProjectPath: string;
  repoWorktreeId: string;
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
    registeredDomains: number;
  };
  domains: EvalDomainSummary[];
  items: EvalHubItem[];
}

export interface EvalHubDiagnosisTarget {
  featureId: string;
  componentId: string;
  name: string;
  attributionRefs: string[];
  metricRefs: string[];
}

export interface EvalHubLifecycleView {
  availability: 'available' | 'unavailable' | 'not_required';
  ownerResponseStatus: 'not_required' | 'unavailable' | 'not_started' | 'acknowledged';
  closureStatus: 'observing' | 'unavailable' | EvalVerdictLifecycleStatus;
  stale: boolean;
  unavailableReason?: string;
  sequence?: number;
  targetOwnerCatId?: string;
  lifecycleOwnerCatId?: string;
  caseId?: string;
  activeVerdictId?: string;
  observedVerdictIds?: string[];
  taskId?: string;
  leaseId?: string;
  leaseGeneration?: number;
  mainCommitSha?: string;
  liveCommitSha?: string;
  ownerResponseRefs?: EvalLifecycleRef[];
  planRefs?: EvalLifecycleRef[];
  actionRefs?: EvalLifecycleRef[];
  reevalRefs?: EvalLifecycleRef[];
  unavailableRefs?: EvalLifecycleRef[];
  reevalStatus?: 'not_required' | 'unavailable' | 'not_requested' | 'pending' | 'passed' | 'failed';
  reevalDueAt?: string;
  escalation?: { eventId: string; stage: 'acknowledgement' | 'reevaluation'; dueAt: string };
  closureReason?: string;
  diagnosisTarget?: EvalHubDiagnosisTarget;
}

export interface EvalHubItem {
  id: string;
  domainId: EvalDomainRegistryEntry['domainId'];
  packetId: string;
  feedbackType: 'live-verdict';
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  phenomenon: string;
  operatorNarrative: EvalHubOperatorNarrative;
  ownerAsk: string;
  harnessUnderEval: {
    featureId: string;
    componentId: string;
    name: string;
  };
  reeval: {
    nextEvalAt?: string;
    status: 'observing' | 'pending_owner' | 'pending_reeval';
    summary: string;
  };
  lifecycle: EvalHubLifecycleView;
  evidence: {
    snapshotRefs: string[];
    attributionRefs: string[];
    metricRefs: string[];
    otherRefs: string[];
  };
  trend: {
    generatedAt: string;
    window: { startMs?: number; endMs?: number; durationHours: number };
    components: Array<{
      componentId: string;
      componentName: string;
      confidence: string;
      activationCounts: CountRecord;
      frictionCounts: CountRecord;
    }>;
  };
  systemWorkspace: {
    kind: 'eval_domain';
    id: EvalDomainRegistryEntry['domainId'];
    label: string;
    threadId: string;
    stateSot: 'registry';
  };
  source: { verdictPath: string; bundleDir: string };
  friction?: EvalHubFrictionProjection;
}
