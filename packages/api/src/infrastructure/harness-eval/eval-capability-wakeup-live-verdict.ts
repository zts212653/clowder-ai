import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from './eval-a2a-artifact-resolver.js';
import {
  buildCapabilityWakeupVerdictHandoff,
  type CapabilityName,
  type ClassifiedCapabilityWakeupTrial,
} from './eval-capability-wakeup-adapter.js';
import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from './verdict-handoff.js';

const SANITIZE_RULES_VERSION = 'f192-capability-wakeup-v1';
const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface GenerateCapabilityWakeupLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  capability: CapabilityName;
  trials: ClassifiedCapabilityWakeupTrial[];
  generatedAt?: string;
  generatorCommit?: string;
}

export interface CapabilityWakeupLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  refs: {
    bundleDir: string;
    snapshotRef: string;
    attributionRefs: string[];
  };
  isLive: true;
  sentCrossThreadMessage: false;
}

export function generateCapabilityWakeupLiveVerdict(
  input: GenerateCapabilityWakeupLiveVerdictInput,
): CapabilityWakeupLiveVerdictArtifact {
  assertSafeVerdictId(input.verdictId);
  const relevantTrials = input.trials.filter((trial) => trial.capability === input.capability);
  if (relevantTrials.length === 0) {
    throw new Error(`no trials recorded for capability ${input.capability}`);
  }

  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const snapshot = buildSnapshot(input, relevantTrials, generatedAt);
  const attribution = buildAttribution(input, relevantTrials, generatedAt);
  const rawTrials = { verdictId: input.verdictId, capability: input.capability, trials: relevantTrials };
  const summary = {
    verdictId: input.verdictId,
    featureId: input.domain.handoffTargetResolver.featureId,
    capability: input.capability,
    generatedAt,
  };
  const repoRoot = dirname(dirname(input.harnessFeedbackRoot));
  const rawInputDir = join(repoRoot, 'generated', 'capability-wakeup', input.verdictId);
  const rawTrialsPath = join(rawInputDir, 'trials.json');
  const rawSummaryPath = join(rawInputDir, 'summary.json');
  mkdirSync(rawInputDir, { recursive: true });
  writeJson(rawTrialsPath, rawTrials);
  writeJson(rawSummaryPath, summary);
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: repoRelativeRawInputPath(rawTrialsPath, repoRoot),
        sha256: sha256File(rawTrialsPath),
      },
      {
        path: repoRelativeRawInputPath(rawSummaryPath, repoRoot),
        sha256: sha256File(rawSummaryPath),
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-capability-wakeup-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const packet = buildCapabilityWakeupVerdictHandoff({
    domain: input.domain,
    capability: input.capability,
    trials: relevantTrials,
    createdAt: generatedAt,
  });
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...packet,
    evidencePacket: {
      ...packet.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });
  const markdown = formatLiveVerdictMarkdown(
    input.verdictId,
    input.capability,
    packetWithBundleRefs,
    resolved.snapshotRef,
  );
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    packet: packetWithBundleRefs,
    markdown,
    refs: {
      bundleDir,
      snapshotRef: resolved.snapshotRef,
      attributionRefs: resolved.attributionRefs,
    },
    isLive: true,
    sentCrossThreadMessage: false,
  };
}

function buildSnapshot(
  input: GenerateCapabilityWakeupLiveVerdictInput,
  trials: ClassifiedCapabilityWakeupTrial[],
  generatedAt: string,
) {
  const negatives = trials.filter((trial) => trial.outcome === 'negative');
  const misses = trials.filter((trial) => trial.outcome === 'miss');
  const falsePositives = trials.filter((trial) => trial.outcome === 'false_positive');
  const byLabel = countByLabel(misses);
  const start = Math.min(...trials.map((trial) => trial.timeSpan.startMs));
  const end = Math.max(...trials.map((trial) => trial.timeSpan.endMs));
  return {
    verdictId: input.verdictId,
    evalSnapshotId: `eval-${input.domain.handoffTargetResolver.featureId}-${slug(input.capability)}-${generatedAt.slice(0, 10)}`,
    featureId: input.domain.handoffTargetResolver.featureId,
    generatedAt,
    window: {
      startMs: start,
      endMs: end,
      durationHours: Math.max(0, Math.round(((end - start) / 3600000) * 1000) / 1000),
    },
    components: [
      {
        id: input.capability,
        name: input.capability,
        activationCounts: {
          opportunity_count: misses.length + negatives.length,
          used_count: negatives.length,
          false_positive_count: falsePositives.length,
        },
        frictionCounts: {
          miss_count: misses.length,
          cognitive_count: byLabel.cognitive ?? 0,
          behavioral_count: byLabel.behavioral ?? 0,
          attention_dilution_count: byLabel.attention_dilution ?? 0,
          reachability_doubt_count: byLabel.reachability_doubt ?? 0,
          unclassified_count: byLabel.unclassified ?? 0,
        },
        confidence: trials.length >= 3 ? 'medium' : 'low',
      },
    ],
  };
}

function buildAttribution(
  input: GenerateCapabilityWakeupLiveVerdictInput,
  trials: ClassifiedCapabilityWakeupTrial[],
  generatedAt: string,
) {
  const misses = trials.filter((trial) => trial.outcome === 'miss');
  const dominant = dominantTrialLabel(misses);
  const evalSnapshotId = `eval-${input.domain.handoffTargetResolver.featureId}-${slug(input.capability)}-${generatedAt.slice(0, 10)}`;
  const selected = misses.filter((trial) => trial.label === dominant);
  if (selected.length === 0) {
    return {
      verdictId: input.verdictId,
      featureId: input.domain.handoffTargetResolver.featureId,
      evalSnapshotId,
      generatedAt,
      findings: [],
      noFindingRecord: {
        reason: 'no actionable miss findings exceeded threshold',
        evidence: `${input.capability}/miss_count`,
      },
    };
  }

  const severity = selected.length >= 3 ? 'high' : 'medium';
  const confidence = Math.min(0.95, 0.5 + selected.length * 0.1);
  return {
    verdictId: input.verdictId,
    featureId: input.domain.handoffTargetResolver.featureId,
    evalSnapshotId,
    generatedAt,
    findings: [
      {
        id: `CW-${slug(input.capability)}-${generatedAt.slice(0, 10)}`,
        relatedFeature: input.domain.handoffTargetResolver.featureId,
        frictionSignal: {
          type: `${slug(input.capability)}.miss_rate`,
          severity,
          confidence,
          detectedAt: generatedAt,
        },
        attribution: {
          primaryLayer: dominant,
          evidence: selected.slice(0, 3).map((trial) => ({
            type: 'counter',
            anchor: `${input.capability}/${labelMetricKey(dominant)}`,
            excerpt: trial.opportunityEvidence[0] ?? `rule:${trial.ruleId}`,
          })),
        },
        proposedAction: [
          {
            action:
              dominant === 'behavioral'
                ? 'design-hook'
                : dominant === 'attention_dilution'
                  ? 'jit-reminder'
                  : 'doc-fix',
            target: `${input.domain.handoffTargetResolver.featureId}/${input.capability}`,
            rationale: ownerAskFor(dominant, input.capability),
          },
        ],
        status: 'open',
      },
    ],
  };
}

function formatLiveVerdictMarkdown(
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
    ...packet.evidencePacket.metricRefs.map((ref) => `- metric:${ref}`),
    '',
  ].join('\n');
}

function countByLabel(trials: ClassifiedCapabilityWakeupTrial[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trial of trials) {
    counts[trial.label] = (counts[trial.label] ?? 0) + 1;
  }
  return counts;
}

function dominantTrialLabel(trials: ClassifiedCapabilityWakeupTrial[]): ClassifiedCapabilityWakeupTrial['label'] {
  const counts = countByLabel(trials);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (sorted[0]?.[0] as ClassifiedCapabilityWakeupTrial['label']) ?? 'unclassified';
}

function labelMetricKey(label: ClassifiedCapabilityWakeupTrial['label']): string {
  switch (label) {
    case 'cognitive':
      return 'cognitive_count';
    case 'behavioral':
      return 'behavioral_count';
    case 'attention_dilution':
      return 'attention_dilution_count';
    case 'reachability_doubt':
      return 'reachability_doubt_count';
    default:
      return 'unclassified_count';
  }
}

function ownerAskFor(label: ClassifiedCapabilityWakeupTrial['label'], capability: CapabilityName): string {
  if (label === 'behavioral') return `hook candidate for ${capability} after demonstrated use`;
  if (label === 'attention_dilution') return `just-in-time reminder candidate for ${capability}`;
  if (label === 'reachability_doubt') return `reachability/how-to doc fix for ${capability}`;
  return `how-to guidance update for ${capability}`;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function repoRelativeRawInputPath(path: string, repoRoot: string): string {
  return relative(repoRoot, path).replace(/\\/g, '/');
}

function assertSafeVerdictId(verdictId: string): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(verdictId)) {
    throw new Error('verdictId must be a safe slug');
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
