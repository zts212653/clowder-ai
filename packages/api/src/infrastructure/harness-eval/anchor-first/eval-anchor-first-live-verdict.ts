import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AnchorTelemetryRollup, AnchorToolRollup } from '../../../routes/anchor-event-log.js';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { AnchorTelemetrySourceSelector } from '../publish-verdict/types.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { assertAnchorSubmittedPacketMatches } from './anchor-submitted-packet-guard.js';

const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SANITIZE_RULES_VERSION = 'f236-anchor-telemetry-v1';
const ROLLUP_COMPONENT_ID = 'anchor-telemetry-rollup';
const ROLLUP_COMPONENT_NAME = 'anchor-first preview/drill open-rate rollup';

/**
 * F236 AC-E3 — sunset signal thresholds.
 *
 * Sunset Signal ① (anchor tax): openRateByItem > this AND netBenefit < 0.
 * These are presentation thresholds for flagging in the attribution bundle —
 * the eval cat (gpt52) owns the actual verdict, not a deterministic function.
 */
const SUNSET_OPEN_RATE_THRESHOLD = 0.8;

export interface GenerateAnchorFirstLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  rollup: AnchorTelemetryRollup;
  selector: AnchorTelemetrySourceSelector;
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export interface AnchorFirstLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  isLive: true;
}

/**
 * F236 Track-2 AC-E4 — anchor-first live-verdict file-writer.
 *
 * Simplified version of eval-friction-live-verdict: writes the anchor telemetry
 * rollup as bundle artifacts (snapshot.json, attribution.json, provenance.json,
 * raw/rollup.json) and renders verdict.md from the cat-submitted packet.
 *
 * No writeback (no afterPublish). No extraStagedPaths (raw lives under bundleDir).
 */
export function generateAnchorFirstLiveVerdict(
  input: GenerateAnchorFirstLiveVerdictInput,
): AnchorFirstLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  assertAnchorSubmittedPacketMatches(input.submittedPacket, input.domain);

  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  const rawDir = join(bundleDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const featureId = input.domain.handoffTargetResolver.featureId;
  const evalSnapshotId = `eval-${featureId}-${generatedAt.slice(0, 10)}`;

  const snapshot = buildSnapshot(input.verdictId, featureId, evalSnapshotId, generatedAt, input.selector, input.rollup);
  const attribution = buildAttribution(input.verdictId, featureId, evalSnapshotId, generatedAt, input.rollup);

  // Write raw rollup data for provenance/replay
  const rawRollupPath = join(rawDir, 'rollup.json');
  writeJson(rawRollupPath, {
    verdictId: input.verdictId,
    selector: input.selector,
    rollup: input.rollup,
  });

  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(join(input.harnessFeedbackRoot, '..', '..'), rawRollupPath).replace(/\\/g, '/'),
        sha256: sha256File(rawRollupPath),
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-anchor-first-live-verdict',
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
  const markdown = renderVerdictMarkdown(input.verdictId, packetWithBundleRefs, input.rollup, resolved.snapshotRef);
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    packet: packetWithBundleRefs,
    markdown,
    isLive: true,
  };
}

// --- Internal helpers ---

function assertSafeVerdictId(id: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(id)) {
    throw new Error(`unsafe_verdict_id: '${id}' must match ${SAFE_VERDICT_ID_PATTERN}`);
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function buildSnapshot(
  verdictId: string,
  featureId: string,
  evalSnapshotId: string,
  generatedAt: string,
  selector: AnchorTelemetrySourceSelector,
  rollup: AnchorTelemetryRollup,
) {
  const activationCounts: Record<string, number> = {
    orphan_drills: rollup.orphanDrills,
  };
  for (const [tool, stats] of Object.entries(rollup.perTool)) {
    activationCounts[`${tool}_preview_responses`] = stats.previewResponses;
    activationCounts[`${tool}_previewed_items`] = stats.previewedItems;
    activationCounts[`${tool}_drills`] = stats.drills;
    activationCounts[`${tool}_drilled_unique_items`] = stats.drilledUniqueItems;
    activationCounts[`${tool}_returned_chars`] = stats.returnedChars;
    activationCounts[`${tool}_original_chars`] = stats.originalChars;
    activationCounts[`${tool}_chars_saved`] = stats.charsSaved;
    activationCounts[`${tool}_drill_chars`] = stats.drillChars;
    activationCounts[`${tool}_net_benefit`] = stats.netBenefit;
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
        confidence: Object.keys(rollup.perTool).length > 0 ? 'medium' : 'low',
        activationCounts,
        frictionCounts: {},
      },
    ],
  };
}

function buildAttribution(
  verdictId: string,
  featureId: string,
  evalSnapshotId: string,
  generatedAt: string,
  rollup: AnchorTelemetryRollup,
) {
  const findings: Array<Record<string, unknown>> = [];
  let toolsWithAnchorTax = 0;
  let toolsNetNegative = 0;
  let toolsHighOpenRate = 0;

  let lowSampleToolCount = 0;

  for (const [tool, stats] of Object.entries(rollup.perTool)) {
    if (stats.previewResponses === 0) continue;

    // AC-E3: low sample gate — few preview events → skip findings entirely.
    // Why skip (not just suppress flags): publish-policy treats findings[] as
    // actionable signal (regular_pr), so low-sample tools in findings[] would
    // incorrectly trigger owner-action PRs. Data visibility is preserved via
    // verdict markdown's LOW_SAMPLE label + Open-Rate Detail section.
    if (stats.previewedItems < 10) {
      lowSampleToolCount++;
      continue;
    }

    // AC-E3: sunset signal flags (data presentation, not verdict automation)
    const highOpenRate = stats.openRateByItem > SUNSET_OPEN_RATE_THRESHOLD;
    const netNegative = stats.netBenefit < 0;
    const anchorTax = highOpenRate && netNegative;

    if (anchorTax) toolsWithAnchorTax++;
    if (netNegative) toolsNetNegative++;
    if (highOpenRate) toolsHighOpenRate++;

    // AC-E3: severity/action mapping per spec (VG fix — opus-48 latent issue)
    //   anchorTax (Signal ① cost: highOpenRate AND netNegative) → high / fix
    //     Why not 'sunset': generator can't confirm Signal ② (blindness from
    //     task-outcome). Only eval cat can escalate to delete_sunset after
    //     cross-referencing task-outcome. Proposing 'sunset' here would
    //     contradict the verdict mapping in eval-cat-invocation.ts.
    //   single sub-signal (highOpenRate-only OR netNegative-only) → medium / fix
    //   neither signal → low-medium based on openRate / keep-observe or investigate
    const hasSingleSignal = !anchorTax && (highOpenRate || netNegative);
    const severity = anchorTax ? 'high' : hasSingleSignal ? 'medium' : stats.openRateByItem > 0.5 ? 'medium' : 'low';
    const action = anchorTax
      ? 'fix'
      : hasSingleSignal
        ? 'fix'
        : stats.openRateByItem > 0.5
          ? 'investigate'
          : 'keep-observe';

    findings.push({
      id: `AF-${generatedAt.slice(0, 10)}-${tool}`,
      relatedFeature: featureId,
      sunsetSignals: { anchorTax, highOpenRate, netNegative },
      frictionSignal: {
        type: `anchor.open_rate.${tool}`,
        severity,
        confidence: 0.8, // only tools with previewedItems >= 10 reach here
        detectedAt: generatedAt,
      },
      attribution: {
        primaryLayer: anchorTax ? 'anchor_tax' : 'needs_investigation',
        evidence: [
          {
            type: 'counter',
            anchor: `${ROLLUP_COMPONENT_ID}/${tool}_drilled_unique_items`,
            excerpt: `${tool}: ${stats.drilledUniqueItems}/${stats.previewedItems} items drilled (${(stats.openRateByItem * 100).toFixed(1)}% open rate), charsSaved=${stats.charsSaved}, drillChars=${stats.drillChars}, netBenefit=${stats.netBenefit}`,
          },
        ],
      },
      proposedAction: [
        {
          action,
          target: `${ROLLUP_COMPONENT_ID}/${tool}`,
          rationale: `Open rate ${(stats.openRateByItem * 100).toFixed(1)}%: ${stats.drilledUniqueItems}/${stats.previewedItems} items drilled, net benefit ${stats.netBenefit} chars`,
        },
      ],
    });
  }

  // AC-E3: sunset assessment summary — quick scan for eval cat
  const sunsetAssessment = {
    toolCount: findings.length,
    toolsWithAnchorTax,
    toolsNetNegative,
    toolsHighOpenRate,
    lowSampleToolCount,
  };

  if (findings.length === 0 && lowSampleToolCount > 0) {
    return {
      verdictId,
      featureId,
      evalSnapshotId,
      generatedAt,
      findings: [],
      sunsetAssessment,
      noFindingRecord: {
        reason: 'low_sample',
        evidence: `${lowSampleToolCount} tool(s) had fewer than 10 previewed items — insufficient data for sunset signal assessment. Raw stats are in verdict markdown Open-Rate Detail.`,
      },
    };
  }

  if (findings.length === 0) {
    return {
      verdictId,
      featureId,
      evalSnapshotId,
      generatedAt,
      findings: [],
      sunsetAssessment,
      noFindingRecord: {
        reason: 'no_preview_events',
        evidence: 'No anchor-first preview events in the rollup window.',
      },
    };
  }

  return {
    verdictId,
    featureId,
    evalSnapshotId,
    generatedAt,
    findings,
    sunsetAssessment,
  };
}

function renderVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  rollup: AnchorTelemetryRollup,
  sourceSnapshotRef: string,
): string {
  const lines: string[] = [
    '---',
    'feature_ids: [F192, F236]',
    'topics: [harness-eval, eval-anchor-first, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    `domain_id: ${packet.domainId}`,
    `packet_id: ${packet.id}`,
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${verdictId}`,
    '',
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (${packet.harnessUnderEval.name})`,
    `- Owner ask: ${packet.ownerAsk.requestedAction}`,
    `- Re-eval: ${packet.acceptanceReevalPlan.closureCondition} at ${packet.acceptanceReevalPlan.nextEvalAt}`,
    '',
  ];

  // AC-E3: Sunset Signal Assessment (eval cat quick-scan section)
  lines.push('Sunset Signal Assessment:');
  for (const [tool, stats] of Object.entries(rollup.perTool) as Array<[string, AnchorToolRollup]>) {
    const lowSample = stats.previewedItems < 10;
    const highOpenRate = !lowSample && stats.openRateByItem > SUNSET_OPEN_RATE_THRESHOLD;
    const netNegative = !lowSample && stats.netBenefit < 0;
    const anchorTax = highOpenRate && netNegative;
    const signals: string[] = [];
    if (lowSample) signals.push('LOW_SAMPLE');
    if (anchorTax) signals.push('ANCHOR_TAX');
    if (highOpenRate && !anchorTax) signals.push('HIGH_OPEN_RATE');
    if (netNegative && !anchorTax) signals.push('NET_NEGATIVE');
    const label = signals.length > 0 ? signals.join('+') : 'HEALTHY';
    lines.push(
      `- ${tool}: ${label} (openRate=${(stats.openRateByItem * 100).toFixed(1)}%, netBenefit=${stats.netBenefit})`,
    );
  }
  lines.push('');

  // Open-rate detail (domain-specific, not parsed by extractBullet)
  lines.push('Open-Rate Detail:');
  for (const [tool, stats] of Object.entries(rollup.perTool) as Array<[string, AnchorToolRollup]>) {
    lines.push(
      `- ${tool}: ${(stats.openRateByItem * 100).toFixed(1)}% open rate (${stats.drilledUniqueItems}/${stats.previewedItems} items), charsSaved=${stats.charsSaved}, drillChars=${stats.drillChars}, netBenefit=${stats.netBenefit}`,
    );
  }
  lines.push(`- Orphan drills: ${rollup.orphanDrills}`);
  lines.push('');

  // Evidence section (canonical format for eval-hub-read-model extractEvidenceRefs)
  lines.push('Evidence:');
  for (const ref of packet.evidencePacket.snapshotRefs) lines.push(`- ${ref}`);
  for (const ref of packet.evidencePacket.attributionRefs) lines.push(`- ${ref}`);
  for (const ref of packet.evidencePacket.metricRefs) {
    lines.push(`- metric:${ref.startsWith('metric:') ? ref.slice(7) : ref}`);
  }
  for (const ref of packet.evidencePacket.sampleTraceRefs) lines.push(`- ${ref}`);
  lines.push('');

  // Counterarguments section (canonical format)
  lines.push('Counterarguments:');
  for (const ca of packet.counterarguments) lines.push(`- ${ca}`);
  lines.push('');

  return lines.join('\n');
}
