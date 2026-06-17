import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * Render a VerdictHandoffPacket as a frontmatter-prefixed markdown document.
 * Used by `generateA2aLiveVerdict` for both operator-regen and Phase H cat-mediated
 * publish paths. Extracted from `eval-a2a-live-verdict.ts` to honor 350-line limit.
 */
export function formatLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
): string {
  return [
    '---',
    'feature_ids: [F192, F167]',
    'topics: [harness-eval, eval-a2a, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:a2a',
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
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    // 砚砚 R14 P2 + cloud R14 P2: operator regen path passes raw `c2.foo`; Phase H
    // cat-mediated path passes pre-prefixed `metric:c2.foo`. Read-model classifies
    // by `metric:` prefix (eval-hub-read-model.ts), so output MUST be exactly one
    // `metric:` prefix. Normalize to handle both shapes — strip then add.
    ...packet.evidencePacket.metricRefs.map((ref) => `- metric:${ref.startsWith('metric:') ? ref.slice(7) : ref}`),
    ...packet.evidencePacket.sampleTraceRefs.map((ref) => `- ${ref}`),
    '',
    'Counterarguments:',
    ...packet.counterarguments.map((counterargument) => `- ${counterargument}`),
    '',
  ].join('\n');
}
