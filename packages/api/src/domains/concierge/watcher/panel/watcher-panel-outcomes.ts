import type { TurnExecutionRecord, WatcherPanelMemberEntry, WatcherPanelRound } from '@cat-cafe/shared';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';

/** A provider's drained stream does not overrule a user's durable cancellation. */
export function watcherPanelTerminalOutcome(record: TurnExecutionRecord) {
  if (record.status === 'running') return undefined;
  return {
    executionStatus: record.status,
    status: record.status === 'succeeded' ? 'quiet' : record.status === 'failed' ? 'failed' : 'interrupted',
    ...(record.status !== 'succeeded' ? { failure: record.terminalReason ?? `watcher_panel_${record.status}` } : {}),
  } satisfies Pick<WatcherPanelMemberEntry, 'status' | 'executionStatus' | 'failure'>;
}

/** Read repair only: keep the original ledger and every member's submitted sentence/delivery. */
export async function reconcileWatcherPanelRound(
  executions: Pick<ITurnExecutionStore, 'get'>,
  round: WatcherPanelRound,
): Promise<WatcherPanelRound> {
  const members = await Promise.all(
    round.members.map(async (entry) => {
      if (!entry.invocationId) return entry;
      const record = await executions.get(entry.invocationId);
      if (
        !record ||
        record.invocationId !== entry.invocationId ||
        record.userId !== round.userId ||
        record.threadId !== round.threadId ||
        record.catId !== entry.catId ||
        record.executionKind !== 'watcher' ||
        record.causal?.watcherPanelRoundId !== round.roundId
      )
        return entry;
      const terminal = watcherPanelTerminalOutcome(record);
      if (!terminal) return entry;
      return {
        ...entry,
        ...terminal,
        ...(record.status === 'failed' && entry.failure ? { failure: entry.failure } : {}),
        status: entry.sentence ? ('spoke' as const) : terminal.status,
      };
    }),
  );
  return { ...round, members };
}
