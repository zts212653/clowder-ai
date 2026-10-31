/**
 * F245 Phase C P1-3 — FrictionRollupReport producer.
 *
 * Pure projection: FrictionRollupInput → FrictionRollupReport (zero storage).
 * Ranks clusters by severity × count × channelDiversity (severity = max member
 * severity, joined from input.signals), keeps Top-N for deep-dive, folds the rest
 * into a per-channel tail summary, and enforces a hard token cap (folds more
 * top→tail until the serialized report fits — AC-C2 "防 context 打爆").
 *
 * P1-4 enriches topClusters with sensorForms only (ClassifiedFrictionCluster); rootCause
 * (7-class) is the eval cat's verdict-layer judgment, NOT producer-assigned (KD-8).
 */

import type {
  ActionableFrictionCandidate,
  ClassifiedFrictionCluster,
  FrictionChannel,
  FrictionCluster,
  FrictionFollowupDraft,
  FrictionRollupInput,
  FrictionRollupReport,
  FrictionSensorForm,
  FrictionSeverity,
  ReferenceOnlyFrictionCluster,
} from '@cat-cafe/shared';

const SEVERITY_RANK: Record<FrictionSeverity, number> = { low: 1, medium: 2, high: 3 };
const DEFAULT_TOP_N = 10;
const DEFAULT_TOKEN_CAP = 4000;
const DEFAULT_MAX_PROPOSALS = 3;

/**
 * Deterministic channel → sensor-form label (F192 §8.1). Data-labeling, NOT judgment
 * (KD-8): each friction channel has a dominant sensor nature. world_truth / absence have
 * no direct channel — the eval cat refines those from deeper analysis in the verdict.
 */
const CHANNEL_SENSOR_FORM: Record<FrictionChannel, FrictionSensorForm> = {
  'paw-feel': 'reason', // 猫显式 articulate 摩擦 = 中断理由
  cancel: 'act', // 中断动作
  'user-feedback': 'reason', // 用户显式反馈 = 中断理由
  'eval-domain': 'aggregate_proxy', // eval 域 metric = 聚合 proxy
};

/** Enrich a cluster with sensorForms (distinct, sorted) + max severity (surfaced for the eval cat). */
function classify(cluster: FrictionCluster, severity: FrictionSeverity): ClassifiedFrictionCluster {
  const forms = new Set<FrictionSensorForm>();
  for (const ch of cluster.channels) forms.add(CHANNEL_SENSOR_FORM[ch]);
  return { ...cluster, sensorForms: [...forms].sort(), severity };
}

export interface FrictionRollupReportOpts {
  /** Deep-dive quota (default 10). Clusters beyond this fold into the tail summary. */
  topN?: number;
  /** Hard token ceiling for the serialized report (default ~4000). */
  tokenCap?: number;
  /** Phase D: max number of actionable candidate drafts (default 3). */
  maxProposals?: number;
}

// Upper-bound digit width for `estimated` (7 digits ≫ any realistic token estimate).
// Measuring with this fixed placeholder removes the self-reference: the estimate no
// longer drifts when the real (larger) value is written back, so the fold-down loop
// can't under-fold a boundary-sized report and break the hard cap (cloud R3 P2).
const MAX_ESTIMATE_PLACEHOLDER = 9_999_999;

/**
 * Rough token estimate: serialized JSON length / 4 (chars→tokens heuristic), measured
 * with a fixed max-width `estimated` placeholder so the value's own digits don't make
 * the measurement under-count at the cap boundary (conservative: never under-folds).
 */
function estimateTokens(report: FrictionRollupReport): number {
  const measured = { ...report, tokenBudget: { ...report.tokenBudget, estimated: MAX_ESTIMATE_PLACEHOLDER } };
  return Math.ceil(JSON.stringify(measured).length / 4);
}

function buildEvidenceRefs(cluster: FrictionCluster, predicate?: (channel: FrictionChannel) => boolean): string[] {
  return cluster.members
    .filter((member) => (predicate ? predicate(member.channel) : true))
    .map((member) => member.rawRef);
}

function isReferenceOnlyCluster(cluster: FrictionCluster): boolean {
  return cluster.channels.length > 0 && cluster.channels.every((channel) => channel === 'eval-domain');
}

function toReferenceOnlyCluster(cluster: ClassifiedFrictionCluster): ReferenceOnlyFrictionCluster {
  return {
    ...cluster,
    actionability: 'reference_only',
    evidenceRefs: buildEvidenceRefs(cluster),
  };
}

function toFollowupDraft(cluster: ClassifiedFrictionCluster): FrictionFollowupDraft {
  const evidenceRefs = buildEvidenceRefs(cluster, (channel) => channel !== 'eval-domain');
  return {
    clusterId: cluster.clusterId,
    title: `Investigate friction cluster: ${cluster.representative}`,
    summary: cluster.representative,
    evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : buildEvidenceRefs(cluster),
    reportingMode: 'final-only',
  };
}

function toActionableCandidate(cluster: ClassifiedFrictionCluster): ActionableFrictionCandidate {
  return {
    ...cluster,
    actionability: 'actionable_candidate',
    followupDraft: toFollowupDraft(cluster),
    referenceOnlyEvidenceRefs: buildEvidenceRefs(cluster, (channel) => channel === 'eval-domain'),
  };
}

export function buildFrictionRollupReport(
  input: FrictionRollupInput,
  generatedAt: string,
  opts: FrictionRollupReportOpts = {},
): FrictionRollupReport {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const tokenCap = opts.tokenCap ?? DEFAULT_TOKEN_CAP;
  const maxProposals = opts.maxProposals ?? DEFAULT_MAX_PROPOSALS;

  // severity lookup: signalId → severity (cluster members carry no severity; join signals)
  const severityById = new Map<string, FrictionSeverity>();
  for (const s of input.signals) severityById.set(s.id, s.severity);

  // max member severity — drives ordering AND surfaced on the cluster for the eval cat (cloud R2 P2).
  const clusterMaxSeverity = (c: FrictionCluster): FrictionSeverity => {
    let max: FrictionSeverity = 'low';
    for (const m of c.members) {
      const sv = severityById.get(m.signalId);
      if (sv !== undefined && SEVERITY_RANK[sv] > SEVERITY_RANK[max]) max = sv;
    }
    return max;
  };

  const score = (c: FrictionCluster): number =>
    SEVERITY_RANK[clusterMaxSeverity(c)] * c.count * Math.max(1, c.channels.length);

  // deterministic: score desc, then count desc, then clusterId asc (stable tie-break)
  const ranked = [...input.clusters].sort((a, b) => {
    const ds = score(b) - score(a);
    if (ds !== 0) return ds;
    const dc = b.count - a.count;
    if (dc !== 0) return dc;
    return a.clusterId.localeCompare(b.clusterId);
  });

  const assemble = (cut: number): FrictionRollupReport => {
    const tail = ranked.slice(cut);
    const classifiedTop = ranked.slice(0, cut).map((c) => classify(c, clusterMaxSeverity(c)));
    const referenceOnly = classifiedTop
      .filter((cluster) => isReferenceOnlyCluster(cluster))
      .map(toReferenceOnlyCluster);
    const actionableCandidates = classifiedTop
      .filter((cluster) => !isReferenceOnlyCluster(cluster))
      .slice(0, maxProposals)
      .map(toActionableCandidate);
    const byChannel: Partial<Record<FrictionChannel, number>> = {};
    let tailSignalCount = 0;
    for (const c of tail) {
      for (const m of c.members) {
        byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
        tailSignalCount += 1;
      }
    }
    const report: FrictionRollupReport = {
      window: input.window,
      generatedAt,
      topClusters: classifiedTop,
      actionableCandidates,
      referenceOnly,
      tailSummary: { clusterCount: tail.length, signalCount: tailSignalCount, byChannel },
      degraded: input.degraded,
      droppedChannels: input.droppedChannels,
      tokenBudget: { cap: tokenCap, estimated: 0 },
    };
    report.tokenBudget.estimated = estimateTokens(report);
    return report;
  };

  // Hard cap: start at topN, demote lowest-ranked deep clusters into the tail
  // (a full cluster is far heavier than its tail counter) until within budget.
  let cut = Math.min(topN, ranked.length);
  let report = assemble(cut);
  while (report.tokenBudget.estimated > tokenCap && cut > 0) {
    cut -= 1;
    report = assemble(cut);
  }
  return report;
}
