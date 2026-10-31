import type { VerdictHandoffPacket } from '../verdict-handoff.js';
import type { CapabilityName } from './eval-capability-wakeup-adapter.js';

/**
 * F192 Phase H 收尾 PR-2 R9 P1 (cloud): markdown renderer + metric ref helper
 * extracted from eval-capability-wakeup-live-verdict.ts to keep both files under
 * AGENTS.md's 350-line hard limit (parent hit 356 after R3 rawInputDir addition).
 *
 * No behavior change — pure code organization.
 */

export function formatLiveVerdictMarkdown(
  verdictId: string,
  capability: CapabilityName,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
): string {
  return [
    '---',
    `feature_ids: [F192, ${packet.harnessUnderEval.featureId}]`,
    'topics: [harness-eval, capability-wakeup, live-verdict]',
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    'domain_id: eval:capability-wakeup',
    `packet_id: ${packet.id}`,
    `source_snapshot: "${sourceSnapshotRef}"`,
    '---',
    '',
    `# Live Verdict — ${verdictId}`,
    '',
    `- Verdict: \`${packet.verdict}\``,
    `- Phenomenon: ${packet.phenomenon}`,
    `- Harness: ${packet.harnessUnderEval.featureId}/${packet.harnessUnderEval.componentId} (${capability})`,
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

/** 砚砚 R1 P2 (a2a R14 mirror): idempotent metric: prefix; cat-submitted packets may already
 * carry `metric:foo` — strip-then-add ensures single prefix, never `metric:metric:foo`. */
export function formatMetricRefBullet(ref: string): string {
  const bare = ref.startsWith('metric:') ? ref.slice(7) : ref;
  return `- metric:${bare}`;
}
