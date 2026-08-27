import {
  type TrajectoryInspectorEpisode,
  type TrajectoryInspectorReduction,
  type TrajectoryInspectorSourceHealth,
  trajectoryInspectorEpisodeSchema,
  trajectoryInspectorSourceHealthSchema,
} from './trajectory-inspector-types.js';

export function reduceTrajectoryInspectorEpisodes(input: {
  episodes: TrajectoryInspectorEpisode[];
  sourceHealth: TrajectoryInspectorSourceHealth;
}): TrajectoryInspectorReduction {
  const sourceHealth = trajectoryInspectorSourceHealthSchema.parse(input.sourceHealth);
  const episodes = input.episodes.map((episode) => trajectoryInspectorEpisodeSchema.parse(episode));
  episodes.sort((left, right) => left.episodeId.localeCompare(right.episodeId));
  assertUniqueEpisodes(episodes);

  const accepted = episodes.filter((episode) => episode.evidenceOutcome === 'accepted');
  const unresolved = episodes.filter((episode) => episode.evidenceOutcome === 'unresolved').length;
  const notTaken = episodes.filter((episode) => episode.evidenceOutcome === 'not_taken').length;
  const wrongRef = episodes.filter((episode) => episode.evidenceOutcome === 'wrong_ref').length;
  const reviewed = episodes.filter((episode) => episode.reviewerAgreement !== 'unreviewed');
  const disagreed = reviewed.filter((episode) => episode.reviewerAgreement === 'disagreed').length;
  const reviewerDisagreementRate = reviewed.length === 0 ? null : disagreed / reviewed.length;
  const canonicalCoverage =
    sourceHealth.canonicalCandidateEpisodes === 0
      ? 0
      : sourceHealth.canonicalResolvedEpisodes / sourceHealth.canonicalCandidateEpisodes;
  const reasons = validityReasons({
    eligibleEpisodes: episodes.length,
    wrongRef,
    canonicalCoverage,
    reviewerDisagreementRate,
    reviewedEpisodes: reviewed.length,
    sourceHealth,
  });

  return {
    episodes,
    vector: {
      eligibleEpisodes: episodes.length,
      accepted: accepted.length,
      unresolved,
      notTaken,
      wrongRef,
      timeToFirstAcceptedEvidenceMs: accepted
        .map((episode) => (episode.firstAcceptedEvidenceAtMs as number) - episode.eligibleAtMs)
        .sort((left, right) => left - right),
      rawOrJsonlFallbackCount: episodes.filter((episode) => episode.rawOrJsonlFallback).length,
    },
    validity: {
      status: wrongRef > 0 ? 'invalid' : reasons.length > 0 ? 'calibration_only' : 'usable',
      reasons,
      canonicalCoverage,
      reviewerDisagreementRate,
    },
    stopUtilityConclusion: wrongRef > 0,
  };
}

function assertUniqueEpisodes(episodes: TrajectoryInspectorEpisode[]): void {
  for (let index = 1; index < episodes.length; index += 1) {
    if (episodes[index]?.episodeId === episodes[index - 1]?.episodeId) {
      throw new Error(`duplicate episodeId: ${episodes[index]?.episodeId}`);
    }
  }
}

function validityReasons(input: {
  eligibleEpisodes: number;
  wrongRef: number;
  canonicalCoverage: number;
  reviewerDisagreementRate: number | null;
  reviewedEpisodes: number;
  sourceHealth: TrajectoryInspectorSourceHealth;
}): string[] {
  const reasons: string[] = [];
  if (input.wrongRef > 0) reasons.push('wrong_invocation_or_thread_ref');
  if (input.eligibleEpisodes < 10) reasons.push('fewer_than_10_eligible_episodes');
  if (input.canonicalCoverage < 1) reasons.push('canonical_coverage_degraded');
  if (input.sourceHealth.significantModelRuntimeDrift) reasons.push('significant_model_runtime_drift');
  if (input.reviewerDisagreementRate !== null && input.reviewerDisagreementRate > 0.2) {
    reasons.push('reviewer_disagreement_above_20_percent');
  }
  if (!input.sourceHealth.comparableBaseline) reasons.push('comparable_baseline_unavailable');
  if (input.reviewedEpisodes === 0) reasons.push('external_review_unavailable');
  return reasons;
}
