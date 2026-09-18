import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { EvalLifecycleRef, EvalVerdictLifecycleStatus } from '../reeval-closure-schema.js';
import type { EvalHubFrictionProjection } from './eval-hub-friction-projection.js';
import type { EvalHubOperatorNarrative } from './eval-hub-operator-narrative.js';

type CountRecord = Record<string, number | null>;

export interface LoadEvalHubSummaryInput {
  harnessFeedbackRoot: string;
  /**
   * Durable runtime verdict store outside the product Git repository. The store is
   * partitioned by owner, so it can only be read on behalf of one.
   */
  artifactStore?: { root: string; ownerUserId: string };
  /** Injectable wall clock for deterministic staleness checks. */
  now?: Date;
}

/**
 * Where a verdict's evidence can be opened. A verdict committed to the product
 * repository is a workspace file; a runtime artifact lives outside every workspace
 * and is addressed by its coordinates, read through the owner-scoped artifact route.
 */
export type EvalHubItemSource =
  | { kind: 'workspace'; verdictPath: string; bundleDir: string }
  /** A runtime verdict: the artifact that holds it, and its own id inside that artifact. */
  | { kind: 'artifact'; domainSlug: string; artifactId: string; verdictId: string };

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
  responsibilityBlocker?: {
    eventId: string;
    reasonCode: 'feature_thread_not_found' | 'feature_thread_ambiguous';
    featureId: string;
    ownerCatId: string;
    candidateThreadIds: string[];
  };
  custodyDispatchBlocker?: {
    eventId: string;
    stage: 'responsibility' | 'reevaluation';
    reasonCode: 'carrier_persist_failed' | 'carrier_delivery_failed' | 'carrier_not_enqueued';
    taskId: string;
    leaseId: string;
    leaseGeneration: number;
    carrierMessageId?: string;
  };
  mainCommitSha?: string;
  liveCommitSha?: string;
  ownerResponseRefs?: EvalLifecycleRef[];
  planRefs?: EvalLifecycleRef[];
  actionRefs?: EvalLifecycleRef[];
  reevalRefs?: EvalLifecycleRef[];
  unavailableRefs?: EvalLifecycleRef[];
  reevalStatus?: 'not_required' | 'unavailable' | 'not_requested' | 'pending' | 'passed' | 'failed';
  repairDebtStatus?: 'not_required' | 'active' | 'cleared';
  reevalDebtStatus?: 'not_scheduled' | 'scheduled' | 'due' | 'in_progress' | 'passed' | 'failed';
  reevalTaskId?: string;
  reevalLeaseId?: string;
  reevalLeaseGeneration?: number;
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
  source: EvalHubItemSource;
  friction?: EvalHubFrictionProjection;
}
