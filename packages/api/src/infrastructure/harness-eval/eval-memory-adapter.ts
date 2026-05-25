import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './eval-domain-registry.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from './verdict-handoff.js';

/**
 * Adapter input type matching real RecallMetricsReport shape
 * (packages/api/src/domains/memory/RecallMetricsComputer.ts).
 * Structurally compatible — a real RecallMetricsReport satisfies this interface.
 */
export interface MemoryRecallMetrics {
  period: { days: number };
  totalEvents: number;
  core: {
    consumedAt3: number;
    consumedMRR: number;
    reformulationRate: number;
    searchAbandonRate: number;
  };
  extended: {
    grepFallbackRate: number;
  };
  graph: {
    nonFirstSelectionRate: number;
    traversalCompletion: number;
  };
}

/**
 * Adapter input type matching real LibraryHealthMetrics shape
 * (packages/api/src/domains/memory/f188-library-health.ts).
 * Structurally compatible — a real LibraryHealthMetrics satisfies this interface.
 */
export interface MemoryLibraryHealth {
  staleAnchors: { count: number };
  orphanEdges: { count: number };
  verificationDebt: { needsReviewCount: number };
  searchQuality: { totalSearches: number; zeroHitCount: number; lowHitCount: number };
  knowledgeFeed: { pendingCount: number; needsReviewCount: number };
}

export interface MemoryFinding {
  id: string;
  signal: { type: string; severity: 'low' | 'medium' | 'high'; confidence: number };
  primaryLayer: string;
  evidence: Array<{ type: string; anchor: string; excerpt: string }>;
  proposedAction: Array<{ action: string; target: string; rationale: string }>;
}

export interface BuildMemoryVerdictInput {
  domain: EvalDomainRegistryEntry;
  recallMetrics: MemoryRecallMetrics;
  libraryHealth: MemoryLibraryHealth;
  finding?: MemoryFinding;
  noFindingRecord?: { reason: string; evidence: string };
}

export function buildMemoryVerdictHandoff(input: BuildMemoryVerdictInput): VerdictHandoffPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);

  if (domain.domainId !== 'eval:memory') {
    throw new Error(`Memory verdict adapter requires eval:memory domain, got ${domain.domainId}`);
  }

  if (input.recallMetrics.totalEvents === 0) {
    throw new Error('Cannot build memory verdict: no recall events recorded in evaluation window');
  }

  if (input.finding && input.finding.proposedAction.length === 0) {
    throw new Error('Finding has empty proposedAction array — cannot build verdict without at least one action');
  }

  const now = new Date().toISOString();
  const packetInput = input.finding
    ? buildFindingPacketInput(domain, input, input.finding, now)
    : buildKeepObservePacketInput(domain, input, now);

  const packet = parseVerdictHandoffPacket(packetInput);
  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    throw new Error(handoffDecision.reason ?? 'verdict handoff packet is incomplete');
  }
  return packet;
}

function buildFindingPacketInput(
  domain: EvalDomainRegistryEntry,
  input: BuildMemoryVerdictInput,
  finding: MemoryFinding,
  createdAt: string,
): unknown {
  const verdict = verdictForFinding(finding);
  const firstAction = finding.proposedAction[0];
  const resolvedFeatureId = resolveHandoffFeatureId(finding, domain);
  const windowDays = input.recallMetrics.period.days;

  return {
    id: packetId(domain, finding.id, createdAt),
    domainId: domain.domainId,
    createdAt,
    phenomenon: `${finding.signal.type} detected: ${firstAction.rationale}`,
    harnessUnderEval: {
      featureId: resolvedFeatureId,
      componentId: finding.primaryLayer,
      name: `${finding.primaryLayer} (${finding.signal.type})`,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:memory-eval/${windowDays}d`],
      attributionRefs: [`attribution:${finding.id}`],
      metricRefs: [...recallMetricRefs(), ...libraryHealthMetricRefs()],
      sampleTraceRefs: finding.evidence.map((e) => e.anchor),
    },
    dailyTrend: {
      window: `${windowDays * 24}h`,
      current: { ...recallMetricValues(input.recallMetrics), ...libraryHealthValues(input.libraryHealth) },
      baseline: {},
      threshold: {},
      direction: verdict === 'fix' ? 'regressed' : 'unknown',
    },
    rootCauseHypothesis: {
      summary: `${finding.primaryLayer}: ${firstAction.rationale}`,
      confidence: confidenceFromScore(finding.signal.confidence),
      alternatives: finding.evidence.map((e) => e.excerpt),
    },
    verdict,
    ...(verdict === 'delete_sunset' ? { governance: { cvoAcceptRequired: true } } : {}),
    ownerAsk: {
      targetFeatureId: resolvedFeatureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction: `Review ${finding.primaryLayer} and address ${firstAction.action}.`,
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(createdAt, domain),
      closureCondition: `next eval no longer reports ${finding.signal.type} above threshold`,
    },
    counterarguments: [`Finding may reflect transient data quality shift during low-volume windows.`],
  };
}

function buildKeepObservePacketInput(
  domain: EvalDomainRegistryEntry,
  input: BuildMemoryVerdictInput,
  createdAt: string,
): unknown {
  if (!input.noFindingRecord) {
    throw new Error('No-finding record is required for keep_observe verdict');
  }

  const windowDays = input.recallMetrics.period.days;

  return {
    id: packetId(domain, 'no-finding', createdAt),
    domainId: domain.domainId,
    createdAt,
    phenomenon: `No actionable memory findings: ${input.noFindingRecord.reason}`,
    harnessUnderEval: {
      featureId: domain.handoffTargetResolver.featureId,
      componentId: 'memory-recall',
      name: 'Memory Recall & Library Health',
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:memory-eval/${windowDays}d`],
      attributionRefs: ['attribution:no-finding'],
      metricRefs: [...recallMetricRefs(), ...libraryHealthMetricRefs()],
      sampleTraceRefs: [input.noFindingRecord.evidence],
    },
    dailyTrend: {
      window: `${windowDays * 24}h`,
      current: { ...recallMetricValues(input.recallMetrics), ...libraryHealthValues(input.libraryHealth) },
      baseline: {},
      threshold: {},
      direction: 'flat',
    },
    rootCauseHypothesis: {
      summary: 'No current evidence that memory recall or library health needs a fix/build/delete decision.',
      confidence: 'medium',
      alternatives: [input.noFindingRecord.evidence],
    },
    verdict: 'keep_observe',
    ownerAsk: {
      targetFeatureId: domain.handoffTargetResolver.featureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction: 'No action required; keep observing the next scheduled eval.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(createdAt, domain),
      closureCondition: 'next eval remains clean',
    },
    counterarguments: ['A clean window may hide low-volume quality degradation; keep the scheduled eval active.'],
  };
}

function verdictForFinding(finding: MemoryFinding): Exclude<VerdictHandoffPacket['verdict'], 'keep_observe'> {
  const actions = finding.proposedAction.map((a) => a.action.toLowerCase());
  if (actions.some((a) => /sunset|retire|delete/.test(a))) return 'delete_sunset';
  if (finding.primaryLayer === 'tool_gap') return 'build';
  if (actions.some((a) => /add-counter|build|instrument/.test(a))) return 'build';
  return 'fix';
}

/**
 * Extract feature ID from a finding's proposed action target.
 * If the target starts with F\d+/, use that feature ID instead of domain default.
 * E.g. "F188/orphan-edge-repair" → "F188"
 */
function resolveHandoffFeatureId(finding: MemoryFinding, domain: EvalDomainRegistryEntry): string {
  const target = finding.proposedAction[0]?.target ?? '';
  const match = target.match(/^(F\d+)\//);
  return match ? match[1] : domain.handoffTargetResolver.featureId;
}

function recallMetricRefs(): string[] {
  return [
    'consumed_mrr',
    'consumed_at_3',
    'search_abandon_rate',
    'grep_fallback_rate',
    'non_first_selection_rate',
    'traversal_completion',
  ];
}

function libraryHealthMetricRefs(): string[] {
  return ['orphan_edge_count', 'stale_anchor_count', 'verification_debt_count', 'search_zero_hit_count'];
}

function recallMetricValues(metrics: MemoryRecallMetrics): Record<string, number> {
  return {
    consumed_mrr: metrics.core.consumedMRR,
    consumed_at_3: metrics.core.consumedAt3,
    search_abandon_rate: metrics.core.searchAbandonRate,
    grep_fallback_rate: metrics.extended.grepFallbackRate,
    non_first_selection_rate: metrics.graph.nonFirstSelectionRate,
    traversal_completion: metrics.graph.traversalCompletion,
  };
}

function libraryHealthValues(health: MemoryLibraryHealth): Record<string, number> {
  return {
    orphan_edge_count: health.orphanEdges.count,
    stale_anchor_count: health.staleAnchors.count,
    verification_debt_count: health.verificationDebt.needsReviewCount,
    search_zero_hit_count: health.searchQuality.zeroHitCount,
  };
}

function packetId(_domain: EvalDomainRegistryEntry, suffix: string, createdAt: string): string {
  const slugDate = createdAt.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const slugSuffix = suffix.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `vhp_eval_memory_${slugDate}_${slugSuffix}`;
}

function nextEvalAt(createdAt: string, domain: EvalDomainRegistryEntry): string {
  return new Date(Date.parse(createdAt) + domain.sla.reevalWithinHours * 3_600_000).toISOString();
}

function confidenceFromScore(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.85) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}
