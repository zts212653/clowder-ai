import { DEFAULT_THREAD_ID, type GuideStateV1 } from '../cats/services/stores/ports/ThreadStore.js';

interface GuideThreadAccess {
  id: string;
  createdBy: string;
}

export function isSharedDefaultThread(thread: GuideThreadAccess | null | undefined): boolean {
  return Boolean(thread && thread.id === DEFAULT_THREAD_ID && thread.createdBy === 'system');
}

/** @deprecated Use isSharedDefaultThread — kept as alias during migration */
export const isSharedDefaultGuideThread = isSharedDefaultThread;

/**
 * General-purpose thread access check.
 * Owner always has access; the shared default thread is globally accessible.
 */
export function canAccessThread(thread: GuideThreadAccess | null, userId: string): boolean {
  if (!thread) return false;
  if (thread.createdBy === userId) return true;
  return thread.id === DEFAULT_THREAD_ID && thread.createdBy === 'system';
}

export function canAccessGuideState(
  thread: GuideThreadAccess | null | undefined,
  guideState: Pick<GuideStateV1, 'userId'> | null | undefined,
  userId: string,
): boolean {
  if (!thread || !guideState) return false;
  if (thread.createdBy === userId) return true;
  return isSharedDefaultThread(thread) && guideState.userId === userId;
}

export function hasHiddenForeignNonTerminalGuideState(
  thread: GuideThreadAccess | null | undefined,
  guideState: Pick<GuideStateV1, 'status' | 'userId'> | null | undefined,
  userId: string,
): boolean {
  if (!thread || !guideState) return false;
  if (canAccessGuideState(thread, guideState, userId)) return false;
  return guideState.status !== 'completed' && guideState.status !== 'cancelled';
}
