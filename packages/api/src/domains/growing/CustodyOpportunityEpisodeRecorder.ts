import { createHash } from 'node:crypto';
import {
  type CustodyOpportunityCohortSnapshotV1,
  type CustodyOpportunityContractViolationV1,
  type CustodyOpportunityEpisodeInputV1,
  type CustodyOpportunityEpisodeV1,
  type CustodyOpportunityVectorV1,
  custodyOpportunityEpisodeInputV1Schema,
  custodyOpportunityEpisodeV1Schema,
} from '@cat-cafe/shared';

export class CustodyOpportunityCohortInvalidError extends Error {
  constructor(readonly violations: readonly CustodyOpportunityContractViolationV1[]) {
    super('Custody opportunity cohort is invalid because a deterministic custody contract was violated');
    this.name = 'CustodyOpportunityCohortInvalidError';
  }
}

/**
 * Refs-only measurement projector for one frozen dogfood cohort.
 *
 * It intentionally has no lifecycle/store dependencies and therefore cannot
 * admit, block, close, or resurrect Task truth. Persisting a real evidence
 * artifact is an explicit caller concern after the cohort is frozen.
 */
export class CustodyOpportunityEpisodeRecorder {
  private readonly episodes = new Map<string, CustodyOpportunityEpisodeV1>();
  private readonly invalidity = new Map<string, CustodyOpportunityContractViolationV1>();

  record(rawInput: CustodyOpportunityEpisodeInputV1): CustodyOpportunityEpisodeV1 {
    this.assertValidCohort();
    const parsed = custodyOpportunityEpisodeInputV1Schema.parse(rawInput);
    const { contractViolations = [], ...episodeInput } = parsed;
    const violations = [...contractViolations, ...detectDeterministicViolations(episodeInput)];
    if (violations.length > 0) {
      this.invalidate(violations);
      throw new CustodyOpportunityCohortInvalidError(this.listViolations());
    }

    const episode = custodyOpportunityEpisodeV1Schema.parse({
      episodeRef: deriveEpisodeRef(episodeInput),
      ...episodeInput,
    });
    const existing = this.episodes.get(episode.episodeRef);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(episode)) return existing;
      this.invalidate([{ code: 'conflicting_episode_replay', evidenceRef: episode.episodeRef }]);
      throw new CustodyOpportunityCohortInvalidError(this.listViolations());
    }
    this.episodes.set(episode.episodeRef, episode);
    return episode;
  }

  list(): readonly CustodyOpportunityEpisodeV1[] {
    return [...this.episodes.values()].sort((left, right) => left.episodeRef.localeCompare(right.episodeRef));
  }

  snapshot(): CustodyOpportunityCohortSnapshotV1 {
    const episodes = this.list();
    if (this.invalidity.size > 0) {
      return { state: 'invalid', episodes, contractViolations: this.listViolations() };
    }
    return { state: 'valid', episodes, vector: buildVector(episodes) };
  }

  private assertValidCohort(): void {
    if (this.invalidity.size > 0) throw new CustodyOpportunityCohortInvalidError(this.listViolations());
  }

  private invalidate(violations: readonly CustodyOpportunityContractViolationV1[]): void {
    for (const violation of violations) {
      this.invalidity.set(`${violation.code}\u0000${violation.evidenceRef}`, violation);
    }
  }

  private listViolations(): readonly CustodyOpportunityContractViolationV1[] {
    return [...this.invalidity.values()].sort((left, right) => {
      const byCode = left.code.localeCompare(right.code);
      return byCode === 0 ? left.evidenceRef.localeCompare(right.evidenceRef) : byCode;
    });
  }
}

function deriveEpisodeRef(input: Omit<CustodyOpportunityEpisodeInputV1, 'contractViolations'>): string {
  const identity = [input.source.subjectRef, input.source.sourceRevision, input.policyVersion].join('\u0000');
  return `f310_opp_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function detectDeterministicViolations(
  input: Omit<CustodyOpportunityEpisodeInputV1, 'contractViolations'>,
): CustodyOpportunityContractViolationV1[] {
  if (input.custody.state === 'no_task') return [];
  if (input.policyDisposition === 'abstain' || input.policyDisposition === 'uninformed_silence') {
    return [{ code: 'unauthorized_auto_admit', evidenceRef: input.custody.receiptRef }];
  }
  if (
    input.policyDisposition === 'offer' &&
    (input.userDisposition.state !== 'observed' || input.userDisposition.result !== 'accept')
  ) {
    return [{ code: 'unaccepted_projection', evidenceRef: input.custody.receiptRef }];
  }
  return [];
}

function buildVector(episodes: readonly CustodyOpportunityEpisodeV1[]): CustodyOpportunityVectorV1 {
  const sampledSilentWindows = episodes.filter((episode) => episode.window.kind === 'sampled_silent').length;
  return {
    denominator: {
      totalEpisodes: episodes.length,
      actionWindows: episodes.length - sampledSilentWindows,
      sampledSilentWindows,
      randomSilentWindows: episodes.filter(
        (episode) => episode.window.kind === 'sampled_silent' && episode.window.sampling.bucket === 'random',
      ).length,
      riskTargetedSilentWindows: episodes.filter(
        (episode) => episode.window.kind === 'sampled_silent' && episode.window.sampling.bucket === 'risk_targeted',
      ).length,
    },
    opportunity: {
      assessedPresent: episodes.filter((episode) => episode.opportunityAssessment.state === 'present').length,
      assessedAbsent: episodes.filter((episode) => episode.opportunityAssessment.state === 'absent').length,
      unknown: episodes.filter((episode) => episode.opportunityAssessment.state === 'unknown').length,
      sampledMissed: episodes.filter(
        (episode) =>
          episode.window.kind === 'sampled_silent' &&
          episode.opportunityAssessment.state === 'present' &&
          episode.custody.state === 'no_task',
      ).length,
      nuisanceAction: episodes.filter(
        (episode) =>
          (episode.policyDisposition === 'auto_admit' || episode.policyDisposition === 'offer') &&
          episode.opportunityAssessment.state === 'absent',
      ).length,
    },
    silence: {
      deliberateAbstentions: episodes.filter((episode) => episode.policyDisposition === 'abstain').length,
      trueNegativeEligible: episodes.filter(
        (episode) =>
          episode.candidate.state === 'exposed' &&
          episode.policyDisposition === 'abstain' &&
          episode.opportunityAssessment.state === 'absent',
      ).length,
      uninformed: episodes.filter((episode) => episode.policyDisposition === 'uninformed_silence').length,
      unknownEarnedCredit: 0,
    },
    interruption: {
      evidencedEpisodes: episodes.filter((episode) => episode.interruption.state === 'evidenced').length,
      duplicatePromptEpisodes: episodes.filter((episode) => episode.duplicatePromptRefs.length > 0).length,
    },
  };
}
