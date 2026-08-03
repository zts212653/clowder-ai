import type { StoredEpisode } from './task-outcome-store.js';

/** Public/publishable Task Outcome episode shape. Managed identity stays server-private. */
export type PublicStoredEpisode = Omit<StoredEpisode, 'workId' | 'attemptId'>;

/** Single egress projection shared by HTTP responses and evidence bundles. */
export function projectPublicStoredEpisode(episode: StoredEpisode): PublicStoredEpisode {
  return {
    episodeId: episode.episodeId,
    trigger: episode.trigger,
    threadId: episode.threadId,
    participants: episode.participants,
    artifacts: episode.artifacts,
    attribution: episode.attribution,
    terminalState: episode.terminalState,
    verdict: episode.verdict,
    createdAt: episode.createdAt,
  };
}
