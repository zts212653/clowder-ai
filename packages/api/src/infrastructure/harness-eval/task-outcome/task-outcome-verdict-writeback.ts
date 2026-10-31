import { TERMINAL_DONE_STATES } from './task-outcome-episode.js';
import type {
  PendingEpisodeVerdictUpdate,
  PendingEpisodeVerdictUpdateFailure,
  PendingEpisodeVerdictUpdateResult,
  StoredEpisode,
} from './task-outcome-store.js';

const TERMINAL_DONE_STATE_SET = new Set<string>(TERMINAL_DONE_STATES);

interface VerdictWritebackPort {
  read(episodeId: string): StoredEpisode | null;
  claimPending(update: PendingEpisodeVerdictUpdate): boolean;
  transact(operation: () => void): void;
}

class VerdictWritebackRollback extends Error {
  constructor(readonly failure: PendingEpisodeVerdictUpdateFailure) {
    super('episode_verdict_writeback_failed');
  }
}

function isSameTerminalVerdict(episode: StoredEpisode | null, update: PendingEpisodeVerdictUpdate): boolean {
  return episode !== null && TERMINAL_DONE_STATE_SET.has(episode.terminalState) && episode.verdict === update.verdict;
}

export function updateEpisodeVerdictsIdempotently(
  updates: PendingEpisodeVerdictUpdate[],
  port: VerdictWritebackPort,
): PendingEpisodeVerdictUpdateResult {
  try {
    port.transact(() => {
      for (const update of updates) {
        const current = port.read(update.episodeId);
        if (isSameTerminalVerdict(current, update)) continue;
        const canClaim = current?.verdict === null && TERMINAL_DONE_STATE_SET.has(current.terminalState);
        if (canClaim && port.claimPending(update)) continue;
        const refreshed = port.read(update.episodeId);
        if (isSameTerminalVerdict(refreshed, update)) continue;
        throw new VerdictWritebackRollback({ episodeId: update.episodeId, current: refreshed });
      }
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof VerdictWritebackRollback) return { ok: false, failure: error.failure };
    throw error;
  }
}
