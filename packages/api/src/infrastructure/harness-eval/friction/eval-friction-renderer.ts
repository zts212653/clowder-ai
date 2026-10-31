import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F245 Phase C PR1b — friction live-verdict markdown renderer.
 *
 * Mirrors `eval-task-outcome-renderer.ts`. Emits verdict.md with YAML frontmatter
 * (feedback_type: live-verdict / domain_id: eval:friction / packet_id) so the Eval
 * Hub read-model can parse it. Cat-controlled bullet fields (phenomenon / owner ask /
 * metricRefs) are newline-guarded upstream by the publish-verdict handler.
 */
export function formatFrictionLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
): string {
  return [
    '---',
    'feature_ids: [F245]',
    'topics: [harness-eval, eval-friction, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:friction',
    `packet_id: ${packet.id}`,
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${verdictId}`,
    '',
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (${packet.harnessUnderEval.name})`,
    `- Root cause: ${packet.rootCauseHypothesis.summary} (confidence ${packet.rootCauseHypothesis.confidence})`,
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
