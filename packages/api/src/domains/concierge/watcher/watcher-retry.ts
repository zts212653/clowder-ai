import type { SessionRecord, WatcherSessionState } from '@cat-cafe/shared';
import { saveWatcherState, type WatcherCheckpointOwners } from './watcher-checkpoint.js';

const MAX_RECOVERY_ATTEMPTS = 3;

/** Exhausting model recovery still owes one bounded native-only settlement probe after backoff. */
export function watcherRecoveryFinalizationDue(state: WatcherSessionState, now: number): boolean {
  return (
    (state.attempt?.recoveryAttempts ?? 0) >= MAX_RECOVERY_ATTEMPTS && (state.attempt?.recoveryRetryAt ?? 0) <= now
  );
}

/** Reserve on the original Session before launch, so a crash cannot reset this wake's recovery budget. */
export async function reserveWatcherRecovery(
  owners: Pick<WatcherCheckpointOwners, 'sessions'>,
  session: SessionRecord,
  state: WatcherSessionState,
  now: number,
  controlKey?: string,
): Promise<boolean> {
  const attempt = state.attempt;
  if (!attempt || attempt.phase === 'finalize_pending') return true;
  if (controlKey !== undefined) {
    if (attempt.recoveryControlKey === controlKey) return false;
    await saveWatcherState(owners.sessions, session.id, state, {
      attempt: { ...attempt, recoveryControlKey: controlKey },
    });
    return true;
  }
  const count = attempt.recoveryAttempts ?? 0;
  if (count >= MAX_RECOVERY_ATTEMPTS || (attempt.recoveryRetryAt ?? 0) > now) return false;
  await saveWatcherState(owners.sessions, session.id, state, {
    attempt: {
      ...attempt,
      recoveryAttempts: count + 1,
      recoveryRetryAt: now + (count === 0 ? 5000 : 20000),
    },
  });
  return true;
}
