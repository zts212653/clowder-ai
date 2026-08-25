import type { VerdictHandoffPacket } from './verdict-handoff.js';

export interface LiveVerdictMarkdownDomain {
  domainId: string;
  featureId: string;
  topic?: string;
}

export interface LiveVerdictDiscoveryProfile {
  description: string;
  descriptionAuthor: string;
  descriptionUpdatedAt: string;
}

/**
 * Canonical markdown contract consumed by the Eval Hub read model.
 * Domain generators may add detail bullets, but must not replace these fields.
 */
export function formatLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
  domain: LiveVerdictMarkdownDomain,
  detailBullets: readonly string[] = [],
  discoveryProfile?: LiveVerdictDiscoveryProfile,
): string {
  const topic = domain.topic ?? domain.domainId.replace(':', '-');
  return [
    '---',
    `feature_ids: [F192, ${domain.featureId}]`,
    `topics: [harness-eval, ${topic}, live-verdict]`,
    'doc_kind: harness-feedback',
    'feedback_type: live-verdict',
    ...(discoveryProfile
      ? [
          `description: ${JSON.stringify(discoveryProfile.description)}`,
          'description_source: human',
          `description_author: ${discoveryProfile.descriptionAuthor}`,
          `description_updated_at: ${discoveryProfile.descriptionUpdatedAt}`,
        ]
      : []),
    `domain_id: ${domain.domainId}`,
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
    ...detailBullets,
    '',
    'Evidence:',
    ...packet.evidencePacket.snapshotRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.attributionRefs.map((ref) => `- ${ref}`),
    ...packet.evidencePacket.metricRefs.map(formatMetricRefBullet),
    ...packet.evidencePacket.sampleTraceRefs.map((ref) => `- ${ref}`),
    '',
    'Counterarguments:',
    ...packet.counterarguments.map((counterargument) => `- ${counterargument}`),
    '',
  ].join('\n');
}

function formatMetricRefBullet(ref: string): string {
  const bare = ref.startsWith('metric:') ? ref.slice(7) : ref;
  return `- metric:${bare}`;
}
