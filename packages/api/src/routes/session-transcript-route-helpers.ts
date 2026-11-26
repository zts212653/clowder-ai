import type { SessionRecord } from '@cat-cafe/shared';
import { z } from 'zod';
import { catMayReadSession } from '../domains/cats/services/session/session-scope.js';

export const VALID_TRANSCRIPT_VIEWS = new Set(['raw', 'chat', 'handoff']);

/** Strict integer parse: only pure decimal digit strings (no whitespace, no partial). */
export function strictParseTranscriptInteger(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

export const transcriptSearchSchema = z.object({
  q: z.string().min(1).max(500),
  cats: z.string().optional(),
  sessionIds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  scope: z.enum(['digests', 'transcripts', 'both']).optional(),
});

export function checkTranscriptCatAccess(
  request: { headers: Record<string, unknown> },
  session: Pick<SessionRecord, 'catId' | 'sessionPurpose' | 'chainKey'>,
): string | null {
  const callerCatId = request.headers['x-cat-id'] as string | undefined;
  if (catMayReadSession(callerCatId, session)) return null;
  return session.catId === callerCatId
    ? 'Access denied: watcher panel sessions are not readable by cats'
    : 'Access denied: session belongs to a different cat';
}
