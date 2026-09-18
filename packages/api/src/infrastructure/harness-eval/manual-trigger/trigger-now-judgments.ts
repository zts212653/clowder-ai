/**
 * F257 Judgment integration helper for trigger-now + eval-domain-daily.
 *
 * Bridges ProduceSnapshotResult → produceSegmentJudgments → formatted evidence string.
 * Extracted to avoid pushing trigger-now/eval-domain-daily over 350 lines.
 */

import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { ProduceSnapshotResult } from '../harness-ledger-snapshot-provider.js';
import { produceSegmentJudgments, type SegmentJudgment } from '../segment-judgment-engine.js';

/**
 * Produce segment judgments from a snapshot result.
 *
 * Extracts threadIds from raw events, passes rawGuardEvents for per-event
 * ±120s window correlation (not limited to 5-event sampleAnchors).
 */
export async function produceJudgmentsFromSnapshot(
  traceStore: InjectionTraceStore,
  snapshotResult: ProduceSnapshotResult,
  evalCat: string,
): Promise<SegmentJudgment[]> {
  // Extract unique threadIds from raw events
  const threadIdSet = new Set<string>();
  for (const e of snapshotResult.rawEvents) {
    if (e.threadId) threadIdSet.add(e.threadId);
  }
  const threadIds = [...threadIdSet];

  if (threadIds.length === 0) return [];

  return produceSegmentJudgments(
    { traceStore },
    {
      snapshot: snapshotResult.snapshot,
      evalCat,
      threadIds,
      rawGuardEvents: snapshotResult.rawEvents,
    },
  );
}

/**
 * Format judgments as human-readable evidence for eval cat injection.
 *
 * Eval cat receives this as part of precomputedEvidence (after snapshot summary).
 * Format: markdown table for quick scanning + JSON detail for machine consumption.
 */
export function formatJudgmentsForEvidence(judgments: SegmentJudgment[]): string {
  const alive = judgments.filter((j) => j.verdict === 'alive');
  const unmeasurable = judgments.filter((j) => j.verdict === 'unmeasurable');

  const lines = [
    '### Per-Segment Judgments (deterministic, judgment-schema-v1)',
    '',
    `- **Total segments**: ${judgments.length}`,
    `- **Alive** (denominator > 0): ${alive.length}`,
    `- **Unmeasurable** (no denominator): ${unmeasurable.length}`,
    '',
  ];

  if (alive.length > 0) {
    lines.push('**Alive segments** (injectionCount / violationCount):');
    for (const j of alive) {
      const ic = j.evidence.injectionCount.value;
      const vc = j.evidence.violationCount.value;
      const rate = ic > 0 ? `${((vc / ic) * 100).toFixed(1)}%` : 'n/a';
      lines.push(`  - \`${j.segmentId}\`: ${ic} injections, ${vc} violations (rate: ${rate})`);
    }
    lines.push('');
  }

  if (unmeasurable.length > 0) {
    lines.push('**Unmeasurable segments** (no fired injections in window):');
    for (const j of unmeasurable) {
      lines.push(`  - \`${j.segmentId}\``);
    }
    lines.push('');
  }

  // Machine-readable detail for generator adapter consumption
  lines.push('```json');
  lines.push(JSON.stringify(judgments, null, 2));
  lines.push('```');

  return lines.join('\n');
}
