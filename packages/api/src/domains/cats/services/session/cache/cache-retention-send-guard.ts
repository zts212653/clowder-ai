import { isDeepStrictEqual } from 'node:util';
import type { SessionRecord } from '@cat-cafe/shared';
import type { CacheRetentionWarmProof } from './cache-retention-proof.js';
import { projectSessionCacheWarmth } from './session-cache-warmth.js';

/** Manual canary margin; a missed hot window is discarded, never caught up. */
export const CACHE_RETENTION_SEND_MARGIN_MS = 120_000;

export function cacheRetentionSendRefusal(input: {
  readonly before: SessionRecord;
  readonly current: SessionRecord;
  readonly sourceInvocationId: string;
  readonly runtime: string;
  readonly model: string;
  readonly now: number;
  readonly warmProof?: CacheRetentionWarmProof;
}): string | undefined {
  const { before, current, now } = input;
  if (
    current.id !== before.id ||
    current.cliSessionId !== before.cliSessionId ||
    current.lastUsage?.cacheObservation?.invocationId !== input.sourceInvocationId ||
    !isDeepStrictEqual(current.lastUsage?.cacheObservation, before.lastUsage?.cacheObservation)
  )
    return 'cache_retention_parent_changed';
  const warmth = projectSessionCacheWarmth(
    current,
    now,
    { model: input.model, runtime: input.runtime },
    input.warmProof,
  );
  if (
    warmth.status === 'expired' ||
    (warmth.expiresAt !== undefined && now >= warmth.expiresAt - CACHE_RETENTION_SEND_MARGIN_MS)
  )
    return 'cache_retention_expired_at_send';
  if (warmth.status !== 'warm') return 'cache_retention_window_unknown';
  return undefined;
}
