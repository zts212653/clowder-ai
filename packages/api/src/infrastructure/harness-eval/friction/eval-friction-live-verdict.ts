import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  ClassifiedFrictionCluster,
  FrictionRollupInput,
  FrictionRollupReport,
  FrictionRollupSourceSelector,
} from '@cat-cafe/shared';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { formatFrictionLiveVerdictMarkdown } from './eval-friction-renderer.js';
import { buildFrictionRollupReport } from './friction-rollup-report.js';
import { assertFrictionSubmittedPacketMatches } from './friction-submitted-packet-guard.js';

const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SANITIZE_RULES_VERSION = 'f245-friction-rollup-v1';
/** Single bundle component id — all rollup metrics hang off it so attribution anchors validate. */
const ROLLUP_COMPONENT_ID = 'friction-rollup';
const ROLLUP_COMPONENT_NAME = 'friction rollup (Top-N + sensorForm)';

export interface GenerateFrictionLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  rollupInput: FrictionRollupInput;
  selector: FrictionRollupSourceSelector;
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export interface FrictionLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  refs: {
    bundleDir: string;
    snapshotRef: string;
    attributionRefs: string[];
  };
  isLive: true;
  sentCrossThreadMessage: false;
}

/**
 * F245 Phase C PR1b — friction live-verdict file-writer.
 *
 * Builds the Top-N rollup report from the resolved live input, writes the
 * task-outcome-shaped bundle (raw report under `bundleDir/raw/`, Decision 2 —
 * no extraStagedPaths / no gitignore force-add), resolves canonical bundle refs,
 * and renders verdict.md from the cat-submitted packet (Decision 3). KD-4: the
 * generator performs NO writeback (no afterPublish side effect); the only writes
 * are verdict.md + bundle inside the publisher's isolated worktree. KD-8: root
 * cause (7-class) is the cat's verdict-layer judgment (carried in the packet's
 * rootCauseHypothesis), NOT rule-classified here.
 */
export function generateFrictionLiveVerdict(input: GenerateFrictionLiveVerdictInput): FrictionLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  assertFrictionSubmittedPacketMatches(input.submittedPacket, input.domain);

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const report = buildFrictionRollupReport(input.rollupInput, generatedAt, {
    ...(input.selector.topN !== undefined ? { topN: input.selector.topN } : {}),
    ...(input.selector.tokenCap !== undefined ? { tokenCap: input.selector.tokenCap } : {}),
  });

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  const rawDir = join(bundleDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const featureId = input.domain.handoffTargetResolver.featureId;
  const evalSnapshotId = `eval-${featureId}-${generatedAt.slice(0, 10)}`;
  const snapshot = buildSnapshot(input.verdictId, featureId, evalSnapshotId, generatedAt, input.selector, report);
  const attribution = buildAttribution(input.verdictId, featureId, evalSnapshotId, generatedAt, report);

  const rawReportPath = join(rawDir, 'rollup-report.json');
  writeJson(rawReportPath, {
    verdictId: input.verdictId,
    selector: input.selector,
    window: input.rollupInput.window,
    signalCount: input.rollupInput.signals.length,
    clusterCount: input.rollupInput.clusters.length,
    degraded: input.rollupInput.degraded,
    droppedChannels: input.rollupInput.droppedChannels,
    report,
  });

  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(join(input.harnessFeedbackRoot, '..', '..'), rawReportPath).replace(/\\/g, '/'),
        sha256: sha256File(rawReportPath),
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-friction-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...input.submittedPacket,
    evidencePacket: {
      ...input.submittedPacket.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });
  const markdown = formatFrictionLiveVerdictMarkdown(input.verdictId, packetWithBundleRefs, resolved.snapshotRef);
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    packet: packetWithBundleRefs,
    markdown,
    refs: {
      bundleDir,
      snapshotRef: resolved.snapshotRef,
      attributionRefs: resolved.attributionRefs,
    },
    isLive: true,
    sentCrossThreadMessage: false,
  };
}

/** Per-cluster frictionCount metric key. Stable + collision-free (clusterId is sha1[:12]). */
function clusterMetricKey(cluster: ClassifiedFrictionCluster): string {
  return `cluster_${cluster.clusterId}`;
}

function buildSnapshot(
  verdictId: string,
  featureId: string,
  evalSnapshotId: string,
  generatedAt: string,
  selector: FrictionRollupSourceSelector,
  report: FrictionRollupReport,
) {
  // One component carries every Top-N cluster as a frictionCount + aggregate
  // counters. Attribution evidence anchors reference these keys (resolver gate).
  const frictionCounts: Record<string, number> = {
    cluster_count: report.topClusters.length + report.tailSummary.clusterCount,
    top_cluster_count: report.topClusters.length,
    tail_cluster_count: report.tailSummary.clusterCount,
    tail_signal_count: report.tailSummary.signalCount,
  };
  for (const cluster of report.topClusters) {
    frictionCounts[clusterMetricKey(cluster)] = cluster.count;
  }

  return {
    verdictId,
    evalSnapshotId,
    featureId,
    generatedAt,
    window: {
      startMs: selector.windowStartMs,
      endMs: selector.windowEndMs,
      durationHours: Math.max(
        0,
        Math.round(((selector.windowEndMs - selector.windowStartMs) / 3_600_000) * 1000) / 1000,
      ),
    },
    components: [
      {
        id: ROLLUP_COMPONENT_ID,
        name: ROLLUP_COMPONENT_NAME,
        confidence: report.degraded ? 'low' : report.topClusters.length > 0 ? 'medium' : 'low',
        activationCounts: {},
        frictionCounts,
      },
    ],
  };
}

function buildAttribution(
  verdictId: string,
  featureId: string,
  evalSnapshotId: string,
  generatedAt: string,
  report: FrictionRollupReport,
) {
  const top = report.topClusters[0];
  if (!top) {
    // cloud-R3 P2: an empty topClusters is NOT no-finding when the tail still holds
    // clusters. A low tokenCap or a dominant top can demote every ranked cluster into
    // tailSummary while cluster_count > 0; returning noFinding there mislabels a
    // keep_observe verdict as no-action-needed despite real friction. Surface an
    // aggregate tail finding; only a truly empty rollup (tail also empty) is no-finding.
    if (report.tailSummary.clusterCount > 0) {
      return {
        verdictId,
        featureId,
        evalSnapshotId,
        generatedAt,
        findings: [
          {
            id: `FR-${generatedAt.slice(0, 10)}-tail-aggregate`,
            relatedFeature: featureId,
            frictionSignal: {
              type: 'friction.tail_aggregate',
              severity: 'low',
              confidence: 0.5,
              detectedAt: generatedAt,
            },
            attribution: {
              primaryLayer: 'needs_investigation',
              evidence: [
                {
                  type: 'counter',
                  anchor: `${ROLLUP_COMPONENT_ID}/tail_cluster_count`,
                  excerpt: `${report.tailSummary.clusterCount} friction cluster(s) folded into the long tail (${report.tailSummary.signalCount} signal(s)); none ranked into Top-N but friction is present`,
                },
              ],
            },
            proposedAction: [
              {
                action: 'triage-tail-friction',
                target: `${featureId}/${ROLLUP_COMPONENT_ID}`,
                rationale:
                  'All friction clusters folded into the long tail (low tokenCap or a dominant top cluster). Eval cat assigns the 7-class root cause; tail volume still warrants attention, not no-action.',
              },
            ],
            status: 'open',
          },
        ],
      };
    }
    return {
      verdictId,
      featureId,
      evalSnapshotId,
      generatedAt,
      findings: [],
      noFindingRecord: {
        reason: 'no friction cluster surfaced in the selected window',
        evidence: `${ROLLUP_COMPONENT_ID}/cluster_count`,
      },
    };
  }

  // One finding for the highest-ranked cluster. severity comes from the cluster
  // (producer joins max member severity). primaryLayer stays 'needs_investigation'
  // — KD-8: the 7-class root cause is the cat's verdict-layer judgment (packet
  // rootCauseHypothesis), NOT rule-assigned here. Evidence anchor references the
  // per-cluster frictionCount key so the bundle resolver validates it.
  const metricKey = clusterMetricKey(top);
  const finding = {
    id: `FR-${generatedAt.slice(0, 10)}-${top.clusterId}`,
    relatedFeature: featureId,
    frictionSignal: {
      type: `friction.${metricKey}`,
      severity: top.severity,
      confidence: 0.7,
      detectedAt: generatedAt,
    },
    attribution: {
      primaryLayer: 'needs_investigation',
      evidence: [
        {
          type: 'counter',
          anchor: `${ROLLUP_COMPONENT_ID}/${metricKey}`,
          excerpt: `cluster '${truncate(top.representative)}' count=${top.count} severity=${top.severity} sensorForms=[${top.sensorForms.join(',')}]`,
        },
      ],
    },
    proposedAction: [
      {
        action: 'triage-top-friction-cluster',
        target: `${featureId}/${ROLLUP_COMPONENT_ID}`,
        rationale:
          'Highest-ranked friction cluster in the window — eval cat assigns the 7-class root cause in the verdict before handoff.',
      },
    ],
    status: 'open',
  };

  return { verdictId, featureId, evalSnapshotId, generatedAt, findings: [finding] };
}

/** Excerpt safety: keep the representative short + single-line for the bundle excerpt. */
function truncate(text: string): string {
  const oneLine = text.replace(/[\r\n]+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function assertSafeVerdictId(verdictId: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(verdictId)) {
    throw new Error('verdictId must be a safe slug');
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
