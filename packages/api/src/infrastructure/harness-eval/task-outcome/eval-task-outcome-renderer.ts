import type { VerdictHandoffPacket } from '../verdict-handoff.js';

export function formatTaskOutcomeLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
): string {
  return [
    '---',
    'feature_ids: [F192, F227]',
    'topics: [harness-eval, eval-task-outcome, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:task-outcome',
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
    `- Re-eval: next eval at ${packet.acceptanceReevalPlan.nextEvalAt}`,
    '',
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.metricRefs.map(formatMetricRefBullet),
    '',
    'Counterarguments:',
    ...packet.counterarguments.map((item) => `- ${item}`),
  ].join('\n');
}

function formatMetricRefBullet(ref: string): string {
  const bare = ref.startsWith('metric:') ? ref.slice(7) : ref;
  return `- metric:${bare}`;
}
