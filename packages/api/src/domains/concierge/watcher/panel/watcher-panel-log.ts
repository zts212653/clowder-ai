import type { TurnExecutionRecord, WatcherPanelMemberEntry, WatcherPanelRound } from '@cat-cafe/shared';
import type { Logger } from 'pino';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { watcherPanelRoundId } from './watcher-panel-ledger.js';

export type WatcherPanelLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

function roundRef(round: WatcherPanelRound) {
  return { roundId: round.roundId, threadId: round.threadId, sourceInvocationId: round.sourceInvocationId };
}

/** Operator diagnostics project lifecycle facts, never the sentences, source text or account choices. */
export function createWatcherPanelLog(sink: WatcherPanelLogger = createModuleLogger('watcher-panel')) {
  return {
    started(round: WatcherPanelRound) {
      sink.info(
        { ...roundRef(round), memberCatIds: round.members.map((member) => member.catId), quiet: round.quiet },
        'Watcher panel round started',
      );
    },
    memberFailed(round: WatcherPanelRound, entry: WatcherPanelMemberEntry) {
      if (!entry.failure && entry.status !== 'failed' && entry.status !== 'interrupted') return;
      sink.warn(
        {
          ...roundRef(round),
          catId: entry.catId,
          invocationId: entry.invocationId,
          status: entry.status,
          executionStatus: entry.executionStatus,
          failure: entry.failure,
        },
        'Watcher panel member failed',
      );
    },
    finished(round: WatcherPanelRound, now: number) {
      sink.info(
        {
          ...roundRef(round),
          status: round.status,
          durationMs: now - round.createdAt,
          members: round.members.map(({ catId, status, executionStatus, failure }) => ({
            catId,
            status,
            executionStatus,
            failed: Boolean(failure),
          })),
          delivery: round.delivery,
        },
        'Watcher panel round finished',
      );
    },
    failed(source: TurnExecutionRecord, err: unknown) {
      sink.error(
        {
          roundId: watcherPanelRoundId(source.invocationId),
          threadId: source.threadId,
          sourceInvocationId: source.invocationId,
          err,
        },
        'Watcher panel round failed',
      );
    },
  };
}
