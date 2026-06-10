import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F192 publish_verdict eval:memory wire-up — verdict markdown renderer.
 * Mirrors `eval-capability-wakeup-renderer.ts` shape; extracted to keep generator
 * file under AGENTS.md 350-line hard limit.
 */
export function formatLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
  windowDays: number,
): string {
  return [
    '---',
    `feature_ids: [F192, ${packet.harnessUnderEval.featureId}]`,
    'topics: [harness-eval, memory-recall, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:memory',
    `packet_id: ${packet.id}`,
    `window_days: ${windowDays}`,
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${verdictId}`,
    '',
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (memory-recall)`,
    `- Owner ask: ${packet.ownerAsk.requestedAction}`,
    `- Re-eval: next eval at ${packet.acceptanceReevalPlan.nextEvalAt}`,
    '',
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.metricRefs.map(formatMetricRefBullet),
    '',
  ].join('\n');
}

/** Idempotent metric: prefix; cat-submitted packets may already carry `metric:foo`. */
export function formatMetricRefBullet(ref: string): string {
  const bare = ref.startsWith('metric:') ? ref.slice(7) : ref;
  return `- metric:${bare}`;
}
