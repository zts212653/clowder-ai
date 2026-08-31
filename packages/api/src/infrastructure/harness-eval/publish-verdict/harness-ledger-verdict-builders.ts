/**
 * F257 Eval Engine — harness-ledger verdict + attribution builders.
 *
 * Extracted from harness-ledger-generator-adapter.ts (350-line hard limit).
 * Pure presentation builders — no I/O, no side effects.
 */

import type { HarnessLedgerRunSnapshot } from '../harness-ledger-snapshot-provider.js';

// ── Episode accounting for the committed bundle (PR #41 provenance fix) ──

/**
 * The committed bundle must carry rawEventCount / episodeCount / episode
 * metadata so burst claims (e.g. "4 events in 7.044s") are independently
 * recheckable from the bundle alone. episodeCount falls back to raw count
 * only for legacy snapshots produced before episode coalescing
 * (conservative upper bound).
 */
export function buildByGuardEpisodes(
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

// ── Attribution builder ──

export interface BuildAttributionInput {
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

export function buildAttribution(input: BuildAttributionInput) {
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

// ── Verdict markdown builder ──

export interface BuildVerdictMdInput {
  packet: { id: string } & Record<string, unknown>;
  bundleSnapshot: Record<string, unknown>;
  evalSnapshotId: string;
  hasEvents: boolean;
  byKind: Record<string, number>;
  guardCountMap: Record<string, number>;
  windowDays: number;
  totalEvents: number;
}

export function buildVerdictMarkdown(input: BuildVerdictMdInput): string {
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
