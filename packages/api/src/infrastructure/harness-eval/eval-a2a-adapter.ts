import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './eval-domain-registry.js';
import type { ComponentHealth } from './f167-eval.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from './verdict-handoff.js';

type FindingVerdict = Exclude<VerdictHandoffPacket['verdict'], 'keep_observe'>;

interface A2aSnapshotLike {
  featureId: string;
  generatedAt: string;
  window: { durationHours: number };
  components: Array<
    Pick<ComponentHealth, 'componentId' | 'componentName' | 'activationCounts' | 'frictionCounts' | 'confidence'>
  >;
}

interface AttributionFindingLike {
  id: string;
  frictionSignal: { type: string; severity: 'low' | 'medium' | 'high'; confidence: number };
  attribution: {
    primaryLayer: string;
    evidence: Array<{ type: string; anchor: string; excerpt: string }>;
  };
  proposedAction: Array<{ action: string; target: string; rationale: string }>;
}

interface AttributionReportLike {
  featureId: string;
  evalSnapshotId: string;
  generatedAt: string;
  findings: AttributionFindingLike[];
  noFindingRecord?: { reason: string; evidence: string };
}

export interface BuildA2aVerdictInput {
  domain: EvalDomainRegistryEntry;
  snapshot: A2aSnapshotLike;
  attributionReport: AttributionReportLike;
}

export function buildA2aVerdictHandoff(input: BuildA2aVerdictInput): VerdictHandoffPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);
  if (input.snapshot.components.length === 0) {
    throw new Error('evidence packet cannot be built without snapshot components');
  }
  assertFeatureIdentity(domain, input);

  const packetInput =
    input.attributionReport.findings.length > 0
      ? buildFixPacketInput(domain, input, strongestFinding(input.attributionReport.findings))
      : buildKeepObservePacketInput(domain, input);

  const packet = parseVerdictHandoffPacket(packetInput);

  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    if (handoffDecision.reason) {
      throw new Error(handoffDecision.reason);
    }
    throw new Error('verdict handoff packet is incomplete');
  }
  return packet;
}

function assertFeatureIdentity(domain: EvalDomainRegistryEntry, input: BuildA2aVerdictInput): void {
  const snapshotFeatureId = input.snapshot.featureId;
  const attributionFeatureId = input.attributionReport.featureId;
  const targetFeatureId = domain.handoffTargetResolver.featureId;

  if (snapshotFeatureId === attributionFeatureId && snapshotFeatureId === targetFeatureId) return;

  throw new Error(
    `feature identity mismatch: snapshot=${snapshotFeatureId} attribution=${attributionFeatureId} target=${targetFeatureId}`,
  );
}

function strongestFinding(findings: AttributionFindingLike[]): AttributionFindingLike {
  return findings.reduce((strongest, candidate) =>
    findingRank(candidate) > findingRank(strongest) ? candidate : strongest,
  );
}

function findingRank(finding: AttributionFindingLike): number {
  return severityRank(finding.frictionSignal.severity) * 1_000 + finding.frictionSignal.confidence;
}

function severityRank(severity: AttributionFindingLike['frictionSignal']['severity']): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function buildFixPacketInput(
  domain: EvalDomainRegistryEntry,
  input: BuildA2aVerdictInput,
  finding: AttributionFindingLike,
): unknown {
  if (finding.attribution.evidence.length === 0) {
    throw new Error('evidence packet cannot be built without attribution evidence');
  }
  if (finding.proposedAction.length === 0) {
    throw new Error('evidence packet cannot be built without proposed action evidence');
  }

  const component = componentForFinding(input.snapshot, finding);
  const firstAction = finding.proposedAction[0];
  const firstEvidence = finding.attribution.evidence[0];
  const verdict = verdictForFinding(finding);
  return {
    id: handoffPacketId(domain, input, finding.id),
    domainId: domain.domainId,
    createdAt: input.attributionReport.generatedAt,
    phenomenon: `${finding.frictionSignal.type} detected for ${component.componentName}`,
    harnessUnderEval: {
      featureId: input.snapshot.featureId,
      componentId: component.componentId,
      name: component.componentName,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:${input.attributionReport.evalSnapshotId}`],
      attributionRefs: [`attribution:${finding.id}`],
      metricRefs: [finding.frictionSignal.type],
      sampleTraceRefs: finding.attribution.evidence.map((evidence) => evidence.anchor),
    },
    dailyTrend: {
      window: `${input.snapshot.window.durationHours}h`,
      current: numericRecord(component.frictionCounts),
      baseline: {},
      threshold: {},
      direction: trendDirectionForVerdict(verdict),
    },
    rootCauseHypothesis: {
      summary: `${finding.attribution.primaryLayer}: ${firstAction.rationale}`,
      confidence: confidenceFromScore(finding.frictionSignal.confidence),
      alternatives: finding.attribution.evidence.map((evidence) => evidence.excerpt),
    },
    verdict,
    ...(verdict === 'delete_sunset' ? { governance: { cvoAcceptRequired: true } } : {}),
    ownerAsk: {
      targetFeatureId: domain.handoffTargetResolver.featureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction: requestedActionForVerdict(verdict, component, firstAction),
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(input.attributionReport.generatedAt, domain),
      closureCondition: `next eval no longer reports ${finding.frictionSignal.type} above threshold`,
    },
    counterarguments: [`Finding may be a telemetry artifact if ${firstEvidence.anchor} is duplicated.`],
  };
}

function verdictForFinding(finding: AttributionFindingLike): FindingVerdict {
  const actionNames = finding.proposedAction.map((action) => action.action.toLowerCase());
  if (actionNames.some(isSunsetAction)) return 'delete_sunset';
  if (finding.attribution.primaryLayer === 'tool_gap') return 'build';
  if (actionNames.some((action) => /add-counter|build|instrument/.test(action))) return 'build';
  return 'fix';
}

function isSunsetAction(action: string): boolean {
  return /sunset|retire|delete-harness|remove-harness/.test(action);
}

function trendDirectionForVerdict(verdict: FindingVerdict): 'regressed' | 'unknown' {
  if (verdict === 'fix') return 'regressed';
  return 'unknown';
}

function requestedActionForVerdict(
  verdict: FindingVerdict,
  component: A2aSnapshotLike['components'][number],
  action: AttributionFindingLike['proposedAction'][number],
): string {
  if (verdict === 'build') return `Build missing eval coverage for ${component.componentId}: ${action.action}.`;
  if (verdict === 'delete_sunset') return `Prepare sunset review for ${component.componentId}: ${action.action}.`;
  return `Review ${component.componentId} and address ${action.action}.`;
}

function buildKeepObservePacketInput(domain: EvalDomainRegistryEntry, input: BuildA2aVerdictInput): unknown {
  const component = componentForCleanWindow(input.snapshot);
  const metricRefs = metricRefsForComponent(component);
  const noFindingRecord = input.attributionReport.noFindingRecord;
  if (!noFindingRecord) {
    throw new Error('evidence packet cannot be built without a no-finding record');
  }
  return {
    id: handoffPacketId(domain, input, `${input.attributionReport.evalSnapshotId}:no-finding`),
    domainId: domain.domainId,
    createdAt: input.attributionReport.generatedAt,
    phenomenon: `No actionable A2A findings: ${noFindingRecord.reason}`,
    harnessUnderEval: {
      featureId: input.snapshot.featureId,
      componentId: component.componentId,
      name: component.componentName,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:${input.attributionReport.evalSnapshotId}`],
      attributionRefs: [`attribution:${input.attributionReport.evalSnapshotId}:no-finding`],
      metricRefs,
      sampleTraceRefs: [noFindingRecord.evidence],
    },
    dailyTrend: {
      window: `${input.snapshot.window.durationHours}h`,
      current: numericRecord(metricSourceForComponent(component)),
      baseline: {},
      threshold: {},
      direction: 'flat',
    },
    rootCauseHypothesis: {
      summary: 'No current evidence that the A2A harness needs a fix/build/delete decision.',
      confidence: 'medium',
      alternatives: [noFindingRecord.evidence],
    },
    verdict: 'keep_observe',
    ownerAsk: {
      targetFeatureId: domain.handoffTargetResolver.featureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction: 'No action required; keep observing the next scheduled eval.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(input.attributionReport.generatedAt, domain),
      closureCondition: 'next eval remains clean',
    },
    counterarguments: ['A clean window may hide low-volume failures; keep the scheduled eval active.'],
  };
}

function componentForFinding(
  snapshot: A2aSnapshotLike,
  finding: AttributionFindingLike,
): A2aSnapshotLike['components'][number] {
  for (const evidence of finding.attribution.evidence) {
    const matched = snapshot.components.find((candidate) =>
      componentAnchorMatches(evidence.anchor, candidate.componentId),
    );
    if (matched) return matched;
  }

  throw new Error('evidence packet cannot be built without a component anchor matching snapshot components');
}

function componentAnchorMatches(evidenceAnchor: string, componentId: string): boolean {
  return evidenceAnchor === componentId || evidenceAnchor.startsWith(`${componentId}/`);
}

function componentForCleanWindow(snapshot: A2aSnapshotLike): A2aSnapshotLike['components'][number] {
  const componentWithFrictionMetrics = snapshot.components.find(
    (candidate) => Object.keys(candidate.frictionCounts).length > 0,
  );
  if (componentWithFrictionMetrics) return componentWithFrictionMetrics;

  const componentWithActivationMetrics = snapshot.components.find(
    (candidate) => Object.keys(candidate.activationCounts).length > 0,
  );
  if (componentWithActivationMetrics) return componentWithActivationMetrics;

  return snapshot.components[0];
}

function metricRefsForComponent(component: A2aSnapshotLike['components'][number]): string[] {
  const frictionMetricRefs = Object.keys(component.frictionCounts);
  if (frictionMetricRefs.length > 0) return frictionMetricRefs;
  return Object.keys(component.activationCounts);
}

function metricSourceForComponent(component: A2aSnapshotLike['components'][number]): Record<string, number | null> {
  if (Object.keys(component.frictionCounts).length > 0) return component.frictionCounts;
  return component.activationCounts;
}

function handoffPacketId(domain: EvalDomainRegistryEntry, input: BuildA2aVerdictInput, suffix: string): string {
  return `vhp_${slugId(domain.domainId)}_${slugId(input.attributionReport.generatedAt)}_${slugId(suffix)}`;
}

function slugId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function nextEvalAt(createdAt: string, domain: EvalDomainRegistryEntry): string {
  return new Date(Date.parse(createdAt) + domain.sla.reevalWithinHours * 3_600_000).toISOString();
}

function numericRecord(values: Record<string, number | null>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}

function confidenceFromScore(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.85) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}
