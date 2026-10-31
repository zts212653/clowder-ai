import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { formatLiveVerdictMarkdown } from '../live-verdict-markdown.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import type { DesignGateEpisodeBundle } from './design-gate-types.js';

const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;
const COMPONENT_ID = 'design-gate-utility';
const SANITIZE_RULES_VERSION = 'f303-design-gate-source-refs-v1';

export interface GenerateDesignGateLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  episodeBundle: DesignGateEpisodeBundle;
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export function generateDesignGateLiveVerdict(input: GenerateDesignGateLiveVerdictInput) {
  assertInput(input);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const rawDir = join(bundleDir, 'raw');
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const rawPath = join(rawDir, 'episode-source-refs.json');
  writeJson(rawPath, input.episodeBundle);
  const rawSha256 = sha256File(rawPath);
  const evalSnapshotId = `eval-F303-${generatedAt.slice(0, 10)}`;
  const validEpisodeCount = input.episodeBundle.episodes.filter(
    (episode) => episode.validation.status === 'valid',
  ).length;
  const invalidEpisodeCount = input.episodeBundle.episodes.length - validEpisodeCount;
  const snapshot = buildSnapshot(input, generatedAt, evalSnapshotId, validEpisodeCount, invalidEpisodeCount);
  const attribution = buildAttribution(input, generatedAt, evalSnapshotId, invalidEpisodeCount);
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(join(input.harnessFeedbackRoot, '..', '..'), rawPath).replace(/\\/g, '/'),
        sha256: rawSha256,
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-design-gate-live-verdict',
      version: '2',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };
  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const vector = input.episodeBundle.vector;
  const packet = parseVerdictHandoffPacket({
    ...input.submittedPacket,
    evidencePacket: {
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
      metricRefs: input.submittedPacket.evidencePacket.metricRefs,
      sampleTraceRefs: [
        `source-map:${input.episodeBundle.sourceMapRef}`,
        ...input.episodeBundle.episodes.map((episode) => `episode:${episode.episodeId}`),
      ],
    },
    dailyTrend: {
      window: `${input.episodeBundle.window.startMs}-${input.episodeBundle.window.endMs}`,
      current: {
        eligible_episodes: vector.eligibleEpisodes,
        complete_episodes: validEpisodeCount,
        invalid_episodes: invalidEpisodeCount,
        post_merge_divergence_escapes: vector.postMergeDivergenceEscapes,
        observation_elapsed_hours: input.episodeBundle.observation.elapsedMs / 3_600_000,
      },
      baseline: { eligible_episodes: 0, post_merge_divergence_escapes: 0 },
      threshold: { eligible_episodes: 20, observation_elapsed_hours: 28 * 24 },
      direction: 'unknown',
    },
  });
  const markdown = formatLiveVerdictMarkdown(
    input.verdictId,
    packet,
    resolved.snapshotRef,
    { domainId: 'eval:design-gate', featureId: 'F303', topic: 'design-gate' },
    [
      `- Validity: \`${input.episodeBundle.validity.status}\``,
      `- Observation: \`${input.episodeBundle.observation.status}\``,
      `- Complete episodes: ${validEpisodeCount}/${input.episodeBundle.episodes.length}`,
      '- Estimator: vector only; no composite quality score.',
    ],
    {
      description: 'Live verdict for the independent F303 Design Gate utility observation domain.',
      descriptionAuthor: 'codex-sol',
      descriptionUpdatedAt: generatedAt,
    },
  );
  writeFileSync(verdictPath, markdown, 'utf8');
  return { path: verdictPath, bundleDir, packet, markdown, isLive: true as const };
}

function assertInput(input: GenerateDesignGateLiveVerdictInput): void {
  if (!SAFE_VERDICT_ID.test(input.verdictId)) throw new Error(`unsafe_verdict_id: ${input.verdictId}`);
  if (input.domain.domainId !== 'eval:design-gate' || input.submittedPacket.domainId !== input.domain.domainId) {
    throw new Error('design_gate_generator_wrong_domain');
  }
  if (
    input.domain.handoffTargetResolver.featureId !== 'F303' ||
    input.domain.handoffTargetResolver.ownerCatId !== 'codex-sol' ||
    input.submittedPacket.harnessUnderEval.featureId !== 'F303' ||
    input.submittedPacket.ownerAsk.targetFeatureId !== 'F303' ||
    input.submittedPacket.ownerAsk.targetOwnerCatId !== 'codex-sol'
  ) {
    throw new Error('submitted_packet_evidence_mismatch: design-gate F303 owner binding');
  }
  if (input.submittedPacket.verdict === 'keep_observe') return;
  const completeEpisodeCount = input.episodeBundle.episodes.filter(
    (episode) => episode.validation.status === 'valid',
  ).length;
  if (
    completeEpisodeCount === 0 ||
    input.episodeBundle.validity.status !== 'usable' ||
    !input.episodeBundle.observation.mature
  ) {
    throw new Error(
      'design_gate_action_not_allowed: complete episode, usable validity, and a mature four-week-or-twenty-episode window are required',
    );
  }
}

function buildSnapshot(
  input: GenerateDesignGateLiveVerdictInput,
  generatedAt: string,
  evalSnapshotId: string,
  validEpisodeCount: number,
  invalidEpisodeCount: number,
) {
  const vector = input.episodeBundle.vector;
  const frictionCounts: Record<string, number | null> = {
    post_merge_divergence_escapes: vector.postMergeDivergenceEscapes,
    false_positive_blocks: vector.falsePositiveBlocks,
    extra_active_minutes: vector.extraActiveMinutes,
    extra_review_rounds: vector.extraReviewRounds,
  };
  if (invalidEpisodeCount > 0) frictionCounts.invalid_episodes = invalidEpisodeCount;
  return {
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId: 'F303',
    generatedAt,
    window: {
      startMs: input.episodeBundle.window.startMs,
      endMs: input.episodeBundle.window.endMs,
      durationHours: input.episodeBundle.observation.elapsedMs / 3_600_000,
    },
    validity: input.episodeBundle.validity,
    observation: input.episodeBundle.observation,
    components: [
      {
        id: COMPONENT_ID,
        name: 'F303 eligible episode opportunity × behavior × consequence vector',
        confidence:
          validEpisodeCount === 0 ? 'no-data' : input.episodeBundle.validity.status === 'usable' ? 'high' : 'low',
        activationCounts: {
          eligible_episodes: vector.eligibleEpisodes,
          pre_review_unique_catches: vector.preReviewUniqueCatches,
        },
        frictionCounts,
      },
    ],
  };
}

function buildAttribution(
  input: GenerateDesignGateLiveVerdictInput,
  generatedAt: string,
  evalSnapshotId: string,
  invalidEpisodeCount: number,
) {
  const findings =
    invalidEpisodeCount === 0
      ? []
      : [
          {
            id: `F303-${generatedAt.slice(0, 10)}-source-gap`,
            relatedFeature: 'F303',
            frictionSignal: {
              type: 'design_gate.source_gap',
              severity: 'high' as const,
              confidence: 1,
              detectedAt: generatedAt,
            },
            attribution: {
              primaryLayer: 'canonical_source_adapter',
              evidence: [
                {
                  type: 'telemetry-gap',
                  anchor: `${COMPONENT_ID}/invalid_episodes`,
                  excerpt: `${invalidEpisodeCount} episode(s) failed canonical source validation.`,
                },
              ],
            },
            proposedAction: [
              {
                action: 'observe',
                target: 'f303-design-gate-episode-source',
                rationale: 'Keep the verdict non-actionable until every required source can be re-resolved.',
              },
            ],
          },
        ];
  return {
    verdictId: input.verdictId,
    featureId: 'F303',
    evalSnapshotId,
    generatedAt,
    findings,
    ...(findings.length === 0
      ? {
          noFindingRecord: {
            reason: input.episodeBundle.observation.mature ? 'no_actionable_utility_signal' : 'observation_window_open',
            evidence: `${input.episodeBundle.vector.eligibleEpisodes} eligible episode(s); validity=${input.episodeBundle.validity.status}.`,
          },
        }
      : {}),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
