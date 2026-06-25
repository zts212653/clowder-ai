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

export interface EvalHubItem {
  id: string;
  domainId: string;
  packetId: string;
  feedbackType: 'live-verdict';
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  phenomenon: string;
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
  lifecycle: {
    ownerResponseStatus: 'not_required' | 'not_started';
    closureStatus: 'observing' | 'open';
    stale: boolean;
  };
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

export const VERDICT_LABELS: Record<EvalHubItem['verdict'] | 'stale', string> = {
  keep_observe: '持续观察',
  fix: '需修复',
  build: '需新建',
  delete_sunset: '可下线',
  stale: '已过期',
};
