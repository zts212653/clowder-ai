import type { TurnExecutionRecord, WatcherPanelRound } from '@cat-cafe/shared';
import { effectiveWatcherState, readWatcherPreferences } from '../watcher-controls.js';
import { deliverWatcherPanelRound } from './watcher-panel-delivery.js';
import { settleWatcherPanelExecution } from './watcher-panel-member.js';
import type { WatcherPanelRunnerDeps } from './watcher-panel-runner.js';

const RECONCILE_WINDOW_MS = 7 * 86_400_000;

/** After every member finished: deliver the held sentences once, unless the round or the controls say not to. */
export async function settleWatcherPanelDelivery(
  deps: WatcherPanelRunnerDeps,
  round: WatcherPanelRound,
  source: TurnExecutionRecord,
  aborted: boolean,
  now: number,
): Promise<NonNullable<WatcherPanelRound['delivery']>> {
  if (aborted) return { skipped: 'control_changed' };
  if (!round.members.some((member) => member.status === 'spoke')) return { skipped: 'nobody_spoke' };
  if (round.quiet) return { skipped: 'quiet' };
  const [preferences, thread] = await Promise.all([
    readWatcherPreferences(deps.configs, deps.labels, deps.userId),
    deps.threads.get(round.threadId),
  ]);
  if (
    !preferences.config.panel?.enabled ||
    !thread ||
    thread.deletedAt ||
    !effectiveWatcherState(preferences.config, thread, preferences.quietLabels, now).maySpeak
  )
    return { skipped: 'control_changed' };
  try {
    const sourceAuth = await deps.registry.peekRecord(source.invocationId);
    return await deliverWatcherPanelRound(deps, round, sourceAuth?.ownerAuthProvenance ?? 'unknown');
  } catch (error) {
    deps.report(error, round.threadId);
    return { skipped: 'delivery_failed' };
  }
}

/** A restart ends every in-flight round honestly; nothing is replayed or delivered late. */
export async function reconcileWatcherPanel(
  deps: WatcherPanelRunnerDeps,
  now: number,
  activeThreads: ReadonlySet<string>,
): Promise<void> {
  for (const round of await deps.ledger.list({ userId: deps.userId, since: now - RECONCILE_WINDOW_MS, limit: 500 })) {
    if (round.status !== 'running' || activeThreads.has(round.threadId)) continue;
    for (const member of round.members)
      if (member.status === 'pending' || member.status === 'running') member.status = 'interrupted';
    await deps.ledger.save({ ...round, status: 'interrupted', updatedAt: now });
  }
  for (const execution of await deps.executions.listRunningByUser(deps.userId))
    if (execution.executionKind === 'watcher' && execution.causal?.watcherPanelRoundId)
      await settleWatcherPanelExecution(deps.executions, execution.invocationId, 'interrupted');
}
