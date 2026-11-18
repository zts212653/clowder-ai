import type { SessionRecord } from '@cat-cafe/shared';

/** Shared boundary for home resume, control and derived continuity. Owner trace readers keep the full chain. */
export function isHomeSession(session: SessionRecord | null | undefined): session is SessionRecord {
  return session != null && session.scopedInvocation === undefined && session.sessionPurpose !== 'watcher';
}

export function watcherSessionChainKey(userId: string, catId: string, threadId: string): string {
  return `watcher:${JSON.stringify([userId, catId, threadId])}`;
}

/** F335 panel role: same observer purpose, its own resumable native history per member and thread. */
export function watcherPanelSessionChainKey(userId: string, catId: string, threadId: string): string {
  return `watcher-panel:${JSON.stringify([userId, catId, threadId])}`;
}

export function isWatcherPanelSession(session: Pick<SessionRecord, 'sessionPurpose' | 'chainKey'>): boolean {
  return session.sessionPurpose === 'watcher' && (session.chainKey?.startsWith('watcher-panel:') ?? false);
}

/**
 * A cat reads only its own sessions, and never its F335 panel-watcher sessions: which member said what
 * stays in the owner ledger. Without a caller cat (the person's own view) nothing is filtered here.
 */
export function catMayReadSession(
  callerCatId: string | undefined,
  session: Pick<SessionRecord, 'catId' | 'sessionPurpose' | 'chainKey'>,
): boolean {
  return !callerCatId || (session.catId === callerCatId && !isWatcherPanelSession(session));
}

export interface HomeSessionPosition {
  readonly ordinal: number;
  readonly count: number;
}

/** Home display coordinates never derive from raw trace seq or memory merge counts. Omit id for the next home. */
export function getHomeSessionPosition(records: readonly SessionRecord[], sessionId?: string): HomeSessionPosition {
  const home = records.filter(isHomeSession);
  const index = sessionId === undefined ? home.length : home.findIndex((record) => record.id === sessionId);
  if (index < 0) throw new Error('home_session_position_unavailable');
  return { ordinal: index + 1, count: home.length + (sessionId === undefined ? 1 : 0) };
}
