export interface ProactiveMemoryCandidateCoordinate {
  readonly threadId: string;
  readonly messageIds: readonly string[];
}

export interface ProactiveMemoryFrequencySlice {
  readonly eligibleMessageCount: number;
  readonly distinctMessageCount: number;
  readonly messageShare: number;
}

/**
 * Lane-neutral statistical fact surfaced to the in-context cat.
 * Deliberately contains no lane, importance, recommendation, or tool payload.
 */
export interface ProactiveMemoryCandidate {
  readonly phrase: string;
  readonly normalizedPhrase: string;
  readonly window: {
    readonly sinceInclusive: number;
    readonly untilInclusive: number;
  };
  readonly distinctThreadCount: number;
  readonly distinctMessageCount: number;
  readonly messageShare: number;
  readonly frequency: {
    readonly background: ProactiveMemoryFrequencySlice & {
      readonly untilExclusive: number;
    };
    readonly recentBurst: ProactiveMemoryFrequencySlice & {
      readonly sinceInclusive: number;
    };
  };
  readonly sourceCoordinates: readonly ProactiveMemoryCandidateCoordinate[];
}

export interface ProactiveMemoryCandidateConfig {
  readonly windowMs: number;
  readonly recentWindowMs: number;
  readonly minDistinctThreads: number;
  readonly minDistinctMessages: number;
  readonly minBackgroundMessages: number;
  readonly minRecentBurstLift: number;
  readonly maxNudgesPerTurn: number;
}

export const DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG: ProactiveMemoryCandidateConfig = Object.freeze({
  windowMs: 7 * 24 * 60 * 60 * 1000,
  recentWindowMs: 24 * 60 * 60 * 1000,
  minDistinctThreads: 2,
  minDistinctMessages: 3,
  minBackgroundMessages: 4,
  minRecentBurstLift: 2,
  maxNudgesPerTurn: 3,
});
