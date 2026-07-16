import type { VerdictHandoffPacket } from '../verdict-handoff.js';

export function formatSessionRecoveryLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  snapshotRef: string,
): string {
  return [
    '---',
    'feature_ids: [F192]',
    'topics: [harness-eval, session-recovery, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:session-recovery',
    `packet_id: ${packet.id}`,
    `source_snapshot: "${snapshotRef}"`,
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
    ...packet.evidencePacket.metricRefs.map((ref) => `- metric:${ref.replace(/^metric:/, '')}`),
    '',
  ].join('\n');
}
