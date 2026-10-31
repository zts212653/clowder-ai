import type { TaskOutcomeAttribution } from './task-outcome-episode.js';

export type CreateEpisodeAttributionInput =
  | {
      attribution: 'managed_attributed';
      workId: string;
      attemptId: string;
    }
  | {
      attribution: 'managed_unattributed';
      workId?: never;
      attemptId?: never;
    }
  | {
      attribution?: 'unmanaged_not_applicable';
      workId?: never;
      attemptId?: never;
    };

export type EpisodeAttributionLookup =
  | {
      attribution: 'managed_attributed';
      workId: string;
      attemptId: string;
    }
  | {
      attribution: 'managed_unattributed';
      artifactRef: string;
    }
  | {
      attribution: 'unmanaged_not_applicable';
      threadId: string;
    };

export interface StoredEpisodeAttribution {
  attribution: TaskOutcomeAttribution;
  workId: string | null;
  attemptId: string | null;
}

export function normalizeEpisodeAttribution(input: CreateEpisodeAttributionInput): StoredEpisodeAttribution {
  const attribution = input.attribution ?? 'unmanaged_not_applicable';
  const workId = input.attribution === 'managed_attributed' ? input.workId : null;
  const attemptId = input.attribution === 'managed_attributed' ? input.attemptId : null;

  if (attribution === 'managed_attributed' && (!workId || !attemptId)) {
    throw new Error('managed_attributed episodes require workId and attemptId');
  }

  return { attribution, workId, attemptId };
}

export function readStoredEpisodeAttribution(row: Record<string, unknown>): StoredEpisodeAttribution {
  return {
    attribution: (row.attribution as TaskOutcomeAttribution | undefined) ?? 'unmanaged_not_applicable',
    workId: (row.workId as string | null | undefined) ?? null,
    attemptId: (row.attemptId as string | null | undefined) ?? null,
  };
}
