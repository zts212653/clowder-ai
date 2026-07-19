/**
 * F257 Eval Engine Wiring — harness-ledger generator adapter.
 *
 * KD-17 snapshot-first pattern: reads a pre-produced run snapshot
 * (written by trigger via harness-ledger-snapshot-provider) instead
 * of querying GuardRejectionEventLog directly. Single-read by
 * evalRunId — decision and artifact share one data source.
 *
 * Flow:
 *   1. Discriminator: sourceRefs.kind === 'prompt-segments'
 *   2. Validate window (start < end, both finite)
 *   3. Read stored run snapshot by evalRunId (fail-closed on missing)
 *   4. Write verdict markdown + bundle artifacts from snapshot data
 *   5. Return paths
 *
 * Fail-closed: missing snapshot file → 500 (not false verdict).
 * The snapshot was produced by queryWindowStrict in the provider —
 * Redis errors already surfaced at trigger time.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessLedgerRunSnapshot } from '../harness-ledger-snapshot-provider.js';
import type { PromptSegmentsSourceSelector, VerdictGenerator } from './types.js';

/**
 * Creates the eval:harness-ledger verdict generator.
 *
 * No longer takes GuardRejectionEventLog — data access moved to the
 * snapshot provider (trigger-time, not publish-time). Generator reads
 * the stored snapshot from liveHarnessFeedbackRoot/run-snapshots/.
 */
export function createHarnessLedgerGeneratorAdapter(): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    // Step 1: discriminator check
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'prompt-segments') {
      throw new Error(
        `harness_ledger_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'prompt-segments'`,
      );
    }

    const selector = sourceRefs as unknown as PromptSegmentsSourceSelector;

    // Step 2: validate window
    if (!Number.isFinite(selector.windowStartMs) || !Number.isFinite(selector.windowEndMs)) {
      throw new Error('invalid_window: windowStartMs and windowEndMs must be finite numbers');
    }
    if (selector.windowEndMs <= selector.windowStartMs) {
      throw new Error('invalid_window: windowEndMs must be greater than windowStartMs');
    }

    // Step 3: read stored run snapshot (KD-17 single-read).
    // evalRunId is REQUIRED — trigger must produce snapshot before eval cat publishes.
    const evalRunId = selector.evalRunId;
    if (!evalRunId) {
      throw new Error(
        'harness_ledger_adapter_missing_run_id: sourceRefs.evalRunId is required. ' +
          'Trigger must call produceHarnessLedgerRunSnapshot before eval cat invocation (KD-17).',
      );
    }
    // Path-safety: evalRunId format is validated at MCP + validation layers,
    // but defense-in-depth here prevents path traversal even if upstream skips.
    if (!/^hlr-\d+-[a-f0-9]{8}$/.test(evalRunId)) {
      throw new Error(
        `harness_ledger_adapter_invalid_run_id: evalRunId '${evalRunId}' does not match safe format hlr-<ts>-<hex8>.`,
      );
    }
    const snapshotFilePath = join(deps.liveHarnessFeedbackRoot, 'run-snapshots', `${evalRunId}.json`);
    if (!existsSync(snapshotFilePath)) {
      throw new Error(
        `harness_ledger_adapter_snapshot_missing: ${snapshotFilePath} not found. ` +
          'Run snapshot may have been cleaned up or trigger failed to produce it (fail-closed KD-17).',
      );
    }
    const storedSnapshot = JSON.parse(readFileSync(snapshotFilePath, 'utf8')) as HarnessLedgerRunSnapshot;

    // KD-17 single-source: verify selector window matches stored snapshot window.
    // Prevents drift where cat claims different window than what snapshot actually covers.
    if (
      selector.windowStartMs !== storedSnapshot.window.startMs ||
      selector.windowEndMs !== storedSnapshot.window.endMs
    ) {
      throw new Error(
        `harness_ledger_adapter_window_mismatch: selector window [${selector.windowStartMs}, ${selector.windowEndMs}) ` +
          `does not match stored snapshot window [${storedSnapshot.window.startMs}, ${storedSnapshot.window.endMs}). ` +
          'KD-17 invariant: decision and artifact must share the same data source.',
      );
    }

    // Extract aggregates from stored snapshot (no re-query).
    const { totalEvents, byKind, byGuard } = storedSnapshot;
    const hasEvents = totalEvents > 0;

    const generatedAt = new Date().toISOString();
    const evalSnapshotId = `harness-ledger-snapshot-${packet.id}`;
    const windowMs = selector.windowEndMs - selector.windowStartMs;
    const windowHours = Math.round(windowMs / (3600 * 1000));
    const windowDays = Math.round(windowMs / (24 * 3600 * 1000));

    // Step 4: write bundle artifacts
    const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
    const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', packet.id);
    mkdirSync(join(deps.harnessFeedbackRoot, 'verdicts'), { recursive: true });
    mkdirSync(bundleDir, { recursive: true });

    // Flatten byGuard for snapshot.json frictionCounts (count-only map).
    const guardCountMap: Record<string, number> = {};
    for (const [gid, agg] of Object.entries(byGuard)) {
      guardCountMap[gid] = agg.count;
    }

    const byGuardEpisodes = buildByGuardEpisodes(byGuard);

    // --- Bundle: snapshot.json ---
    const bundleSnapshot = {
      verdictId: packet.id,
      evalSnapshotId,
      featureId: 'F257',
      generatedAt,
      window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs, durationHours: windowHours },
      totalEvents,
      byKind,
      byGuard: guardCountMap,
      byGuardEpisodes,
      sampleAnchors: storedSnapshot.sampleAnchors ?? [],
      // sol R2 P2: truncation must survive into the COMMITTED bundle — a
      // capped window means every count is a lower bound, and the verdict's
      // evidence chain has to say so. Confidence degrades accordingly.
      truncated: storedSnapshot.truncated ?? false,
      components: [
        {
          componentId: 'guard-rejection-log',
          componentName: 'Guard Rejection Event Log',
          activationCounts: { total_events: totalEvents, ...byKind },
          frictionCounts: guardCountMap,
          confidence: (storedSnapshot.truncated ?? false) ? 'low' : hasEvents ? 'medium' : 'no-data',
        },
      ],
    };
    const snapshotJson = JSON.stringify(bundleSnapshot, null, 2);
    writeFileSync(join(bundleDir, 'snapshot.json'), snapshotJson);

    // --- Bundle: attribution.json ---
    const attribution = buildAttribution({
      verdictId: packet.id,
      featureId: 'F257',
      evalSnapshotId,
      generatedAt,
      hasEvents,
      byGuard,
      windowDays,
      windowStartMs: selector.windowStartMs,
      windowEndMs: selector.windowEndMs,
    });
    writeFileSync(join(bundleDir, 'attribution.json'), JSON.stringify(attribution, null, 2));

    // --- Bundle: provenance.json ---
    const snapshotSha = createHash('sha256').update(snapshotJson).digest('hex');
    const provenance = {
      verdictId: packet.id,
      rawInputs: [{ path: `bundles/${packet.id}/snapshot.json`, sha256: snapshotSha }],
      generatedAt,
      generator: { name: 'harness-ledger-generator-adapter', version: '2.0.0' },
      sanitizeRulesVersion: '1.0.0',
      // KD-17 provenance: link back to the run snapshot that fed this bundle.
      producedBy: { runId: evalRunId },
    };
    writeFileSync(join(bundleDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

    // --- Verdict markdown ---
    const verdictMd = buildVerdictMarkdown({
      packet,
      bundleSnapshot,
      evalSnapshotId,
      hasEvents,
      byKind,
      guardCountMap,
      windowDays,
      totalEvents,
    });
    writeFileSync(verdictPath, verdictMd);

    return { verdictPath, bundleDir };
  };
}

// ── Episode accounting for the committed bundle (PR #41 provenance fix) ──

/**
 * The committed bundle must carry rawEventCount / episodeCount / episode
 * metadata so burst claims (e.g. "4 events in 7.044s") are independently
 * recheckable from the bundle alone. episodeCount falls back to raw count
 * only for legacy snapshots produced before episode coalescing
 * (conservative upper bound).
 */
function buildByGuardEpisodes(
  byGuard: HarnessLedgerRunSnapshot['byGuard'],
): Record<string, { rawEventCount: number; episodeCount: number; episodes: unknown[] }> {
  const out: Record<string, { rawEventCount: number; episodeCount: number; episodes: unknown[] }> = {};
  for (const [gid, agg] of Object.entries(byGuard)) {
    out[gid] = {
      rawEventCount: agg.count,
      episodeCount: agg.episodeCount ?? agg.count,
      episodes: agg.episodes ?? [],
    };
  }
  return out;
}

// ── Attribution builder (extracted for readability) ──

interface BuildAttributionInput {
  verdictId: string;
  featureId: string;
  evalSnapshotId: string;
  generatedAt: string;
  hasEvents: boolean;
  byGuard: Record<string, { count: number; kinds: string[]; episodeCount?: number }>;
  windowDays: number;
  windowStartMs: number;
  windowEndMs: number;
}

function buildAttribution(input: BuildAttributionInput) {
  return {
    verdictId: input.verdictId,
    featureId: input.featureId,
    evalSnapshotId: input.evalSnapshotId,
    generatedAt: input.generatedAt,
    findings: input.hasEvents
      ? Object.entries(input.byGuard).map(([guardId, agg]) => {
          const severity: 'low' | 'medium' | 'high' = agg.count >= 20 ? 'high' : agg.count >= 5 ? 'medium' : 'low';
          return {
            id: `f257-guard-${guardId}`,
            rawEventCount: agg.count,
            episodeCount: agg.episodeCount ?? agg.count,
            frictionSignal: { type: agg.kinds.join('+'), severity, confidence: 0.7 },
            attribution: {
              primaryLayer: 'guard-rejection-log',
              evidence: agg.kinds.map((kind) => ({
                type: 'activation-count',
                anchor: `guard-rejection-log/${kind}`,
                excerpt: `${kind} rejection(s) by guard ${guardId}`,
              })),
            },
            proposedAction: [
              { action: 'review', target: guardId, rationale: `${agg.count} guard rejection(s) — review pattern` },
            ],
          };
        })
      : [],
    ...(input.hasEvents
      ? {}
      : {
          noFindingRecord: {
            reason: 'No guard rejection events recorded in this window',
            evidence: `Zero events in ${input.windowDays}-day window [${input.windowStartMs}, ${input.windowEndMs}).`,
          },
        }),
  };
}

// ── Verdict markdown builder (extracted for readability) ──

interface BuildVerdictMdInput {
  packet: { id: string } & Record<string, unknown>;
  bundleSnapshot: Record<string, unknown>;
  evalSnapshotId: string;
  hasEvents: boolean;
  byKind: Record<string, number>;
  guardCountMap: Record<string, number>;
  windowDays: number;
  totalEvents: number;
}

function buildVerdictMarkdown(input: BuildVerdictMdInput): string {
  const { packet, evalSnapshotId, hasEvents, byKind, guardCountMap, windowDays, totalEvents } = input;
  const typedPacket = packet as Record<string, unknown>;

  const verdictValue = (typedPacket.verdict as string) ?? 'keep_observe';
  const phenomenonDefault = !hasEvents
    ? 'Zero guard rejection events in window — baseline accumulation phase'
    : `${totalEvents} guard rejection events across ${Object.keys(guardCountMap).length} guard(s)`;
  const phenomenon = (typedPacket.phenomenon as string) ?? phenomenonDefault;

  const hue = typedPacket.harnessUnderEval as { featureId?: string; componentId?: string; name?: string } | undefined;
  const harnessLine = hue
    ? `${hue.featureId}/${hue.componentId} (${hue.name})`
    : 'F257/guard-rejection-log (Harness Ledger)';

  const ownerAskObj = typedPacket.ownerAsk as { requestedAction?: string } | undefined;
  const ownerAskLine =
    ownerAskObj?.requestedAction ??
    (!hasEvents
      ? 'No action required; keep observing until guard rejection events accumulate.'
      : `Review ${totalEvents} rejection events for attribution patterns.`);

  const reevalPlan = typedPacket.acceptanceReevalPlan as { nextEvalAt?: string } | undefined;
  const reevalLine = reevalPlan?.nextEvalAt
    ? `next eval at ${reevalPlan.nextEvalAt}`
    : 'next eval scheduled per eval:harness-ledger weekly cadence';

  const snapshotRef = `snapshot:bundle/${packet.id}/snapshot`;
  // Per-finding attribution refs (V2 producer fix; PR #43 fixed historical
  // assets). The resolver's allowed-ref set is exactly one ref per
  // findings[].id, or `<evalSnapshotId>:no-finding` when findings=[] with a
  // noFindingRecord — a bare evalSnapshotId ref resolves to nothing.
  // finding ids are `f257-guard-<guardId>` (see buildAttribution).
  const attributionRefs = hasEvents
    ? Object.keys(guardCountMap).map((guardId) => `attribution:bundle/${packet.id}/f257-guard-${guardId}`)
    : [`attribution:bundle/${packet.id}/${evalSnapshotId}:no-finding`];

  const kindRows = Object.entries(byKind)
    .map(([k, c]) => `| ${k} | ${c} |`)
    .join('\n');
  const guardRows = Object.entries(guardCountMap)
    .map(([g, c]) => `| ${g} | ${c} |`)
    .join('\n');

  return [
    '---',
    'feature_ids: [F257]',
    'topics: [harness-eval, eval-harness-ledger, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:harness-ledger',
    `packet_id: ${packet.id}`,
    `source_snapshot: "${snapshotRef}"`,
    '---',
    '',
    `# eval:harness-ledger Verdict — ${packet.id}`,
    '',
    `- Verdict: \`${verdictValue}\``,
    `- Phenomenon: ${phenomenon}`,
    `- Harness: ${harnessLine}`,
    `- Owner ask: ${ownerAskLine}`,
    `- Re-eval: ${reevalLine}`,
    '',
    'Evidence:',
    `- ${snapshotRef}`,
    ...attributionRefs.map((ref) => `- ${ref}`),
    '',
    `**Window**: ${windowDays} days | **Events**: ${totalEvents}`,
    '',
    '## Event Breakdown by Kind',
    '',
    hasEvents ? `| Kind | Count |\n|------|-------|\n${kindRows}` : '_No events recorded in this window._',
    '',
    '## Event Breakdown by Guard',
    '',
    hasEvents ? `| Guard | Count |\n|-------|-------|\n${guardRows}` : '_No events recorded in this window._',
    '',
    '## Notes',
    '',
    !hasEvents
      ? 'No guard rejection events in this window. The observation layer is active but no guards have triggered rejections yet. This is expected during initial accumulation.'
      : `Observed ${totalEvents} guard rejection events over ${windowDays} days across ${Object.keys(byKind).length} event kind(s) and ${Object.keys(guardCountMap).length} guard(s).`,
    '',
  ].join('\n');
}
