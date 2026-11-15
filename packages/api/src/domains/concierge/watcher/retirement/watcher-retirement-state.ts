import { createHash } from 'node:crypto';
import { parseWatcherSessionState, type SessionRecord, type WatcherSurfaceRetirement } from '@cat-cafe/shared';
import type { WatcherCheckpointOwners } from '../watcher-checkpoint.js';

export const SURFACE_CHANGED = 'watcher_native_tool_surface_changed';

export function watcherRetirementPending(session: SessionRecord): boolean {
  return (
    !!(session.watcherRetirement && session.watcherRetirement.phase !== 'retired') ||
    session.watcherState?.attempt?.failure === SURFACE_CHANGED
  );
}

export async function saveWatcherRetirement(
  owners: Pick<WatcherCheckpointOwners, 'sessions'>,
  current: SessionRecord,
  operation: WatcherSurfaceRetirement,
): Promise<SessionRecord> {
  const state = parseWatcherSessionState(current.watcherState);
  const saved = await owners.sessions.compareAndSetWatcherState(
    current.id,
    state.revision,
    { ...state, revision: state.revision + 1 },
    operation,
  );
  if (!saved) throw new Error('watcher_session_changed');
  return { ...current, watcherState: saved, watcherRetirement: operation };
}

/** Created before the pin rejection can clear any old owner pointers. Legacy exact rejections use the same identity. */
export async function ensureWatcherRetirement(
  owners: Pick<WatcherCheckpointOwners, 'sessions'>,
  session: SessionRecord,
): Promise<SessionRecord> {
  if (session.watcherRetirement) return session;
  const state = parseWatcherSessionState(session.watcherState);
  const attempt = state.attempt;
  if (!attempt || !state.toolSchemaHash || state.wakeInvocationId !== attempt.invocationId)
    throw new Error('watcher_retirement_original_owner_missing');
  return saveWatcherRetirement(owners, session, {
    id: createHash('sha256').update(`${session.id}:${attempt.invocationId}`).digest('hex'),
    wakeInvocationId: attempt.invocationId,
    sourceInvocationId: attempt.sourceInvocationId,
    sourceSequence: attempt.sourceSequence,
    oldSchemaHash: state.toolSchemaHash,
    ...(session.cliSessionId ? { nativeCliSessionId: session.cliSessionId } : {}),
    ...(attempt.nativeTurnId ? { nativeTurnId: attempt.nativeTurnId } : {}),
    phase: 'pending',
    probes: 0,
  });
}

/** Separate finite control budget. It does not change old recoveryAttempts/recoveryControlKey or MCP tickets. */
export async function reserveWatcherRetirement(
  owners: Pick<WatcherCheckpointOwners, 'sessions'>,
  session: SessionRecord,
  now: number,
): Promise<SessionRecord | null> {
  const current = await ensureWatcherRetirement(owners, session);
  const operation = current.watcherRetirement;
  if (!operation) throw new Error('watcher_retirement_missing');
  if (operation.phase === 'retired' || operation.probes >= 3 || (operation.retryAt ?? 0) > now) return null;
  return saveWatcherRetirement(owners, current, {
    ...operation,
    probes: operation.probes + 1,
    retryAt: now + (operation.probes === 0 ? 5000 : 20000),
  });
}
