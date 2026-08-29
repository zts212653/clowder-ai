import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { formatLiveVerdictMarkdown } from '../live-verdict-markdown.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import type { TrajectoryInspectorEpisodeBundle } from './trajectory-inspector-types.js';

const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;
const COMPONENT_ID = 'trajectory-inspector-utility';
const SANITIZE_RULES_VERSION = 'f299-trajectory-inspector-v1';

export interface GenerateTrajectoryInspectorLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  episodeBundle: TrajectoryInspectorEpisodeBundle;
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export function generateTrajectoryInspectorLiveVerdict(input: GenerateTrajectoryInspectorLiveVerdictInput) {
  assertInput(input);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const rawDir = join(bundleDir, 'raw');
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const rawPath = join(rawDir, 'episodes.json');
  writeJson(rawPath, input.episodeBundle);
  const rawSha256 = sha256File(rawPath);
  const evalSnapshotId = `eval-F299-${generatedAt.slice(0, 10)}`;
  writeJson(join(bundleDir, 'snapshot.json'), buildSnapshot(input, generatedAt, evalSnapshotId));
  writeJson(join(bundleDir, 'attribution.json'), buildAttribution(input, generatedAt, evalSnapshotId));
  writeJson(join(bundleDir, 'provenance.json'), {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(join(input.harnessFeedbackRoot, '..', '..'), rawPath).replace(/\\/g, '/'),
        sha256: rawSha256,
      },
    ],
    generatedAt,
    generator: {
      name: 'eval-trajectory-inspector-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  });

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const vector = input.episodeBundle.vector;
  const sampleTraceRefs = [...new Set(input.episodeBundle.episodes.flatMap((episode) => episode.sourceRefs))];
  const packet = parseVerdictHandoffPacket({
    ...input.submittedPacket,
    evidencePacket: {
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
      metricRefs: input.submittedPacket.evidencePacket.metricRefs,
      sampleTraceRefs: sampleTraceRefs.length > 0 ? sampleTraceRefs : [`snapshot:${evalSnapshotId}`],
    },
    dailyTrend: {
      window: `${input.episodeBundle.selector.windowStartMs}-${input.episodeBundle.selector.windowEndMs}`,
      current: {
        eligible_episodes: vector.eligibleEpisodes,
        accepted_evidence_episodes: vector.accepted,
        unresolved_evidence_episodes: vector.unresolved,
        not_taken_episodes: vector.notTaken,
        wrong_ref_episodes: vector.wrongRef,
        raw_or_jsonl_fallback_episodes: vector.rawOrJsonlFallbackCount,
        canonical_coverage: input.episodeBundle.validity.canonicalCoverage,
        reviewer_disagreement_rate: input.episodeBundle.validity.reviewerDisagreementRate ?? 0,
      },
      baseline: { comparable_baseline: input.episodeBundle.sourceHealth.comparableBaseline ? 1 : 0 },
      threshold: {
        minimum_eligible_episodes: 10,
        maximum_wrong_ref_episodes: 0,
        minimum_canonical_coverage: 1,
        maximum_reviewer_disagreement_rate: 0.2,
      },
      direction: 'unknown',
    },
  });
  const markdown = formatLiveVerdictMarkdown(
    input.verdictId,
    packet,
    resolved.snapshotRef,
    { domainId: 'eval:trajectory-inspector', featureId: 'F299', topic: 'trajectory-inspector' },
    [
      `- Validity: \`${input.episodeBundle.validity.status}\``,
      `- Eligible episodes: ${vector.eligibleEpisodes}`,
      `- Outcome distribution: accepted=${vector.accepted}, unresolved=${vector.unresolved}, not_taken=${vector.notTaken}, wrong_ref=${vector.wrongRef}`,
      `- Raw/JSONL fallback episodes: ${vector.rawOrJsonlFallbackCount}`,
      '- Estimator: three-dimensional vector only; no composite score.',
    ],
    {
      description: 'Live verdict for F299 Invocation Trajectory Inspector utility.',
      descriptionAuthor: 'codex-sol',
      descriptionUpdatedAt: generatedAt,
    },
  );
  writeFileSync(verdictPath, markdown, 'utf8');
  return { path: verdictPath, bundleDir, packet, markdown, isLive: true as const };
}

function assertInput(input: GenerateTrajectoryInspectorLiveVerdictInput): void {
  if (!SAFE_VERDICT_ID.test(input.verdictId)) throw new Error(`unsafe_verdict_id: ${input.verdictId}`);
  if (
    input.domain.domainId !== 'eval:trajectory-inspector' ||
    input.submittedPacket.domainId !== input.domain.domainId
  ) {
    throw new Error('trajectory_inspector_generator_wrong_domain');
  }
  if (
    input.domain.handoffTargetResolver.featureId !== 'F299' ||
    input.domain.handoffTargetResolver.ownerCatId !== 'fable5' ||
    input.submittedPacket.harnessUnderEval.featureId !== 'F299' ||
    input.submittedPacket.harnessUnderEval.componentId !== COMPONENT_ID ||
    input.submittedPacket.ownerAsk.targetFeatureId !== 'F299' ||
    input.submittedPacket.ownerAsk.targetOwnerCatId !== 'fable5'
  ) {
    throw new Error('submitted_packet_evidence_mismatch: trajectory-inspector F299 owner binding');
  }
  if (input.submittedPacket.verdict === 'keep_observe') return;
  const accepted = input.episodeBundle.episodes.filter((episode) => episode.evidenceOutcome === 'accepted');
  if (
    input.episodeBundle.validity.status !== 'usable' ||
    !input.episodeBundle.sourceHealth.comparableBaseline ||
    input.episodeBundle.stopUtilityConclusion ||
    input.episodeBundle.vector.wrongRef !== 0 ||
    accepted.length === 0 ||
    accepted.some((episode) => episode.reviewerAgreement === 'unreviewed')
  ) {
    throw new Error(
      'trajectory_inspector_action_not_allowed: usable validity, comparable baseline, accepted external review, and zero wrong refs are required',
    );
  }
}

function buildSnapshot(
  input: GenerateTrajectoryInspectorLiveVerdictInput,
  generatedAt: string,
  evalSnapshotId: string,
) {
  const vector = input.episodeBundle.vector;
  return {
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId: 'F299',
    generatedAt,
    window: {
      startMs: input.episodeBundle.selector.windowStartMs,
      endMs: input.episodeBundle.selector.windowEndMs,
      durationHours:
        (input.episodeBundle.selector.windowEndMs - input.episodeBundle.selector.windowStartMs) / 3_600_000,
    },
    validity: input.episodeBundle.validity,
    sourceHealth: input.episodeBundle.sourceHealth,
    trajectoryInspectorCohort: {
      anomalyKinds: [...new Set(input.episodeBundle.episodes.map((episode) => episode.anomalyKind))].sort(),
    },
    trajectoryInspectorVector: vector,
    components: [
      {
        id: COMPONENT_ID,
        name: 'F299 anomaly opportunity × accepted evidence × fallback vector',
        confidence: input.episodeBundle.validity.status === 'usable' ? 'high' : 'low',
        activationCounts: {
          eligible_episodes: vector.eligibleEpisodes,
          accepted_evidence_episodes: vector.accepted,
        },
        frictionCounts: {
          unresolved_evidence_episodes: vector.unresolved,
          not_taken_episodes: vector.notTaken,
          wrong_ref_episodes: vector.wrongRef,
          raw_or_jsonl_fallback_episodes: vector.rawOrJsonlFallbackCount,
        },
      },
    ],
  };
}

function buildAttribution(
  input: GenerateTrajectoryInspectorLiveVerdictInput,
  generatedAt: string,
  evalSnapshotId: string,
) {
  const acceptedEvidence = input.episodeBundle.episodes
    .filter((episode) => episode.evidenceOutcome === 'accepted' && episode.firstAcceptedEvidenceAtMs !== null)
    .map((episode) => ({
      kind: 'f299-accepted-evidence',
      invocationId: episode.invocationId,
      acceptedAtMs: episode.firstAcceptedEvidenceAtMs,
      reviewerAgreement: episode.reviewerAgreement,
      sourceRefs: episode.sourceRefs,
    }));
  const observationRepair = input.episodeBundle.stopUtilityConclusion
    ? [
        {
          id: `F299-${generatedAt.slice(0, 10)}-wrong-ref`,
          relatedFeature: 'F299',
          frictionSignal: {
            type: 'trajectory_inspector.wrong_ref',
            severity: 'high' as const,
            confidence: 1,
            detectedAt: generatedAt,
          },
          attribution: {
            primaryLayer: 'canonical_observation_surface',
            evidence: [
              {
                type: 'telemetry-gap',
                anchor: `${COMPONENT_ID}/wrong_ref_episodes`,
                excerpt: `${input.episodeBundle.vector.wrongRef} wrong invocation/thread episode(s).`,
              },
            ],
          },
          proposedAction: [
            {
              action: 'observe',
              target: 'f299-invocation-trajectory-resolver',
              rationale: 'Repair the observation surface before drawing a utility conclusion.',
            },
          ],
        },
      ]
    : [];
  return {
    verdictId: input.verdictId,
    featureId: 'F299',
    evalSnapshotId,
    generatedAt,
    findings: observationRepair,
    trajectoryInspectorEvidence: acceptedEvidence,
    ...(observationRepair.length === 0
      ? {
          noFindingRecord: {
            reason: input.episodeBundle.validity.status === 'usable' ? 'no_actionable_signal' : 'calibration_only',
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
