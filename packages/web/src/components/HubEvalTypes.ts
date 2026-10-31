import { evalWorkspaceCopy } from './eval-workspace/eval-workspace.shell-copy';
export interface EvalHubFrictionProjection {
  projectionStatus: 'available' | 'unavailable';
  actionableCandidates: Array<{
    clusterId: string;
    representative: string;
    channels: string[];
    count: number;
    sensorForms: string[];
    severity: 'low' | 'medium' | 'high';
    actionability: 'actionable_candidate';
    followupDraft: {
      clusterId: string;
      title: string;
      summary: string;
      evidenceRefs: string[];
      reportingMode: 'none' | 'final-only' | 'state-transitions' | 'blocking-ack';
      suggestedOwnerCatId?: string;
      projectPath?: string;
    };
    referenceOnlyEvidenceRefs: string[];
  }>;
  referenceOnly: Array<{
    clusterId: string;
    representative: string;
    channels: string[];
    count: number;
    sensorForms: string[];
    severity: 'low' | 'medium' | 'high';
    actionability: 'reference_only';
    evidenceRefs: string[];
  }>;
  source?: {
    rawReportPath: string;
  };
}

export interface EvalMetricGlossaryEntry {
  label: string;
  means: string;
  goodDirection: 'higher' | 'lower' | 'neutral';
  category?: 'activation' | 'friction' | 'derived' | 'context';
  component?: string;
  badWhen?: string;
  source?: string;
  ownerHint?: string;
}

export type EvalMetricGlossary = Record<string, EvalMetricGlossaryEntry>;

export interface EvalOperatorNarrative {
  headline: string;
  summary: string;
  action: string;
  nextCheck: string;
  evidenceQuality: 'insufficient' | 'usable';
}

export type EvalLifecycleRef =
  | {
      kind: 'verdict' | 'message' | 'task' | 'plan' | 'commit' | 'pull_request' | 'reeval' | 'sla' | 'other';
      availability: 'available';
      value: string;
    }
  | {
      kind: 'verdict' | 'message' | 'task' | 'plan' | 'commit' | 'pull_request' | 'reeval' | 'sla' | 'other';
      availability: 'unavailable';
      unavailableReason: string;
    };

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
  closureStatus:
    | 'observing'
    | 'unavailable'
    | 'open'
    | 'acknowledged'
    | 'action_planned'
    | 'fix_landed'
    | 'main_landed'
    | 'live_active'
    | 'monitoring'
    | 'reeval_pending'
    | 'resolved'
    | 'suppressed_with_reason'
    | 'escalated';
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
  domainId: string;
  packetId: string;
  feedbackType: 'live-verdict';
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  phenomenon: string;
  operatorNarrative: EvalOperatorNarrative;
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
    window: { durationHours: number };
    components: Array<{
      componentId: string;
      componentName: string;
      confidence: string;
      activationCounts: Record<string, number | null>;
      frictionCounts: Record<string, number | null>;
    }>;
  };
  systemWorkspace: {
    kind: 'eval_domain';
    id: string;
    label: string;
    threadId: string;
    stateSot: 'registry';
  };
  source: {
    verdictPath: string;
    bundleDir: string;
  };
  friction?: EvalHubFrictionProjection;
}

export interface EvalDomainSummary {
  domainId: string;
  displayName: string;
  descriptionForHuman?: string;
  metricGlossary?: EvalMetricGlossary;
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
  generatedAt?: string;
  repoProjectPath?: string;
  repoWorktreeId?: string;
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
    registeredDomains?: number;
  };
  domains: EvalDomainSummary[];
  items: EvalHubItem[];
}

export const VERDICT_LABELS: Record<EvalHubItem['verdict'] | 'stale', string> = evalWorkspaceCopy.zh.verdicts;

export type DomainScheduleLine =
  | { kind: 'sunset'; text: string }
  | { kind: 'next-eval'; text: string }
  | { kind: 'none' };

export function deriveDomainScheduleLine(
  domain: {
    enabled: boolean;
    nextCronFireAt?: string;
    frequency?: string;
  },
  language: 'zh' | 'en' = 'zh',
): DomainScheduleLine {
  const t = evalWorkspaceCopy[language];
  if (domain.enabled === false) {
    return { kind: 'sunset', text: t.sunset };
  }
  if (domain.nextCronFireAt) {
    const isNDay = domain.frequency ? /^every-\d+d$/.test(domain.frequency) : false;
    const label = isNDay ? `${t.nextProbe} (${domain.frequency})` : t.nextEval;
    return {
      kind: 'next-eval',
      text: `${label}: ${new Date(domain.nextCronFireAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}`,
    };
  }
  return { kind: 'none' };
}

export function deriveDomainStateBadge(
  domain: { enabled: boolean; hasVerdict: boolean },
  language: 'zh' | 'en' = 'zh',
): string {
  const t = evalWorkspaceCopy[language];
  if (domain.enabled === false) return 'Sunset';
  if (domain.hasVerdict) return t.active;
  return t.firstEval;
}

export function deriveDomainVerdictLabel(
  domain: {
    hasVerdict: boolean;
    latestVerdict?: EvalHubItem['verdict'];
  },
  language: 'zh' | 'en' = 'zh',
): string | undefined {
  if (domain.hasVerdict && domain.latestVerdict) {
    return evalWorkspaceCopy[language].verdicts[domain.latestVerdict];
  }
  return undefined;
}
