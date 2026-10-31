import type { SessionRecord } from '@cat-cafe/shared';

/** Shared boundary for home resume, control and derived continuity. Owner trace readers keep the full chain. */
export function isHomeSession(session: SessionRecord | null | undefined): session is SessionRecord {
  return session != null && session.scopedInvocation === undefined;
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
