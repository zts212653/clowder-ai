/**
 * F253 Phase C — QC generator adapter (publish_verdict eval:qc).
 *
 * Follows friction-generator-adapter.ts shape:
 *   1. Discriminator: sourceRefs.kind === 'qc-metrics-rollup'
 *   2. Validate window (start < end)
 *   3. Resolve metrics via provider
 *   4. Generate verdict markdown + bundle artifacts (snapshot + attribution + provenance)
 *
 * Phase C bootstrap: metrics are zero-baseline (no live data source
 * wired yet). The adapter is structurally complete so eval:qc can
 * fire weekly and produce keep_observe verdicts with zero-data notes.
 *
 * Cloud P1 fix: verdict markdown must include YAML frontmatter with
 * `feedback_type: live-verdict` (line 140 of eval-hub-read-model.ts
 * filters on this field), structured bullets for buildEvalHubItem(),
 * and bundle must include attribution.json + provenance.json for
 * resolveA2aEvidenceBundle() validation.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type QcMetricsSelector, resolveQcMetrics } from '../qc-metrics-provider.js';
import type { VerdictGenerator } from './types.js';

export function createQcGeneratorAdapter(): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'qc-metrics-rollup') {
      throw new Error(
        `qc_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'qc-metrics-rollup'`,
      );
    }

    const selector = sourceRefs as unknown as QcMetricsSelector;
    if (selector.windowEndMs <= selector.windowStartMs) {
      throw new Error('invalid_window: windowEndMs must be greater than windowStartMs');
    }

    const qcMetrics = resolveQcMetrics(selector);
    const generatedAt = new Date().toISOString();
    const evalSnapshotId = `qc-snapshot-${packet.id}`;
    const windowMs = selector.windowEndMs - selector.windowStartMs;

    // Write verdict + bundle following existing convention:
    //   verdicts/<id>.md  (flat file, not nested dir)
    //   bundles/<id>/     (top-level dir, not under verdicts/)
    const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
    const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', packet.id);
    mkdirSync(join(deps.harnessFeedbackRoot, 'verdicts'), { recursive: true });
    mkdirSync(bundleDir, { recursive: true });

    // --- Bundle: snapshot.json (bundleSnapshotSchema-compliant) ---
    // Maps QC domain metrics into the standard component/counter model
    // that resolveA2aEvidenceBundle() validates via Zod.
    const bundleSnapshot = {
      verdictId: packet.id,
      evalSnapshotId,
      featureId: 'F253',
      generatedAt,
      window: {
        startMs: selector.windowStartMs,
        endMs: selector.windowEndMs,
        durationHours: Math.round(windowMs / (3600 * 1000)),
      },
      components: [
        {
          componentId: 'qc-pipeline',
          componentName: 'QC Pipeline',
          activationCounts: {
            finding_yield: qcMetrics.findingYield,
            reviewer_delta: qcMetrics.reviewerDelta,
            pr_count: qcMetrics.prCount,
          },
          frictionCounts: {
            false_positive_rate: qcMetrics.falsePositiveRate,
            post_merge_bug_rate: qcMetrics.postMergeBugRate,
          },
          confidence: qcMetrics.prCount === 0 ? 'no-data' : 'medium',
        },
      ],
    };
    const snapshotJson = JSON.stringify(bundleSnapshot, null, 2);
    writeFileSync(join(bundleDir, 'snapshot.json'), snapshotJson);

    // --- Bundle: attribution.json (zero-baseline = noFindingRecord) ---
    const attribution = {
      verdictId: packet.id,
      featureId: 'F253',
      evalSnapshotId,
      generatedAt,
      findings: [],
      noFindingRecord: {
        reason: 'Zero-baseline bootstrap (Phase C) — no live QC data sources wired',
        evidence: `All QC metrics are zero (prCount=${qcMetrics.prCount}). Eval:qc data pipeline not yet active.`,
      },
    };
    writeFileSync(join(bundleDir, 'attribution.json'), JSON.stringify(attribution, null, 2));

    // --- Bundle: provenance.json ---
    const snapshotSha = createHash('sha256').update(snapshotJson).digest('hex');
    const provenance = {
      verdictId: packet.id,
      rawInputs: [
        {
          path: `bundles/${packet.id}/snapshot.json`,
          sha256: snapshotSha,
        },
      ],
      generatedAt,
      generator: {
        name: 'qc-generator-adapter',
        version: '1.0.0',
      },
      sanitizeRulesVersion: '1.0.0',
    };
    writeFileSync(join(bundleDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

    // --- Evidence refs ---
    const snapshotRef = `snapshot:bundle/${packet.id}/snapshot`;
    const attributionRef = `attribution:bundle/${packet.id}/${evalSnapshotId}:no-finding`;

    // --- Verdict markdown (Eval Hub compatible) ---
    // Cloud P2 fix: use eval cat's packet fields when present (production path),
    // fall back to defaults for Phase C bootstrap / direct-call tests where
    // the packet may be a minimal { id, domainId } stub.
    const typedPacket = packet as Record<string, unknown>;

    const verdictValue = (typedPacket.verdict as string) ?? 'keep_observe';
    const phenomenonDefault =
      qcMetrics.prCount === 0
        ? 'Zero-baseline QC snapshot — no live data sources wired yet (Phase C bootstrap)'
        : `Analyzed ${qcMetrics.prCount} PRs over ${qcMetrics.windowDays} days`;
    const phenomenon = (typedPacket.phenomenon as string) ?? phenomenonDefault;

    const hue = typedPacket.harnessUnderEval as { featureId?: string; componentId?: string; name?: string } | undefined;
    const harnessLine = hue ? `${hue.featureId}/${hue.componentId} (${hue.name})` : 'F253/qc-pipeline (QC Loop)';

    const ownerAskObj = typedPacket.ownerAsk as { requestedAction?: string } | undefined;
    const ownerAskLine =
      ownerAskObj?.requestedAction ?? 'No action required; keep observing until live data sources are wired.';

    const reevalPlan = typedPacket.acceptanceReevalPlan as { nextEvalAt?: string } | undefined;
    const reevalLine = reevalPlan?.nextEvalAt
      ? `next eval at ${reevalPlan.nextEvalAt}`
      : 'next eval scheduled per eval:qc domain frequency';

    const verdictMd = [
      '---',
      'feature_ids: [F253]',
      'topics: [harness-eval, eval-qc, live-verdict]',
      'doc_kind: harness-feedback',
      'feedback_type: live-verdict',
      'domain_id: eval:qc',
      `packet_id: ${packet.id}`,
      `source_snapshot: "${snapshotRef}"`,
      '---',
      '',
      `# eval:qc Verdict — ${packet.id}`,
      '',
      `- Verdict: \`${verdictValue}\``,
      `- Phenomenon: ${phenomenon}`,
      `- Harness: ${harnessLine}`,
      `- Owner ask: ${ownerAskLine}`,
      `- Re-eval: ${reevalLine}`,
      '',
      'Evidence:',
      `- ${snapshotRef}`,
      `- ${attributionRef}`,
      '',
      `**Window**: ${qcMetrics.windowDays} days | **PRs analyzed**: ${qcMetrics.prCount}`,
      '',
      '## Metrics',
      '',
      '| Metric | Value |',
      '|--------|-------|',
      `| Finding Yield (avg/review) | ${qcMetrics.findingYield} |`,
      `| False Positive Rate | ${qcMetrics.falsePositiveRate} |`,
      `| Reviewer Delta | ${qcMetrics.reviewerDelta} |`,
      `| Post-Merge Bug Rate | ${qcMetrics.postMergeBugRate} |`,
      '',
      '## Notes',
      '',
      qcMetrics.prCount === 0
        ? 'No PR data available in this window. Zero-baseline snapshot (Phase C bootstrap — live data sources not yet wired).'
        : `Analyzed ${qcMetrics.prCount} PRs over ${qcMetrics.windowDays} days.`,
      '',
    ].join('\n');
    writeFileSync(verdictPath, verdictMd);

    return {
      verdictPath,
      bundleDir,
    };
  };
}
