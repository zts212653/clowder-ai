import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';

export type PersonalActionSource = 'mentions' | 'all';
export type PersonalActionRefusal = 'refreshing' | 'saving' | 'identity' | 'preferences' | 'changed' | 'source';

function complete(source: UnifiedAttentionSourceRead | undefined): boolean {
  return source?.status === 'available' && source.exhaustiveness === 'complete';
}

/** Global counts need every source. A mention's personal presentation only needs its own proven source. */
export function personalSourceRefusal(
  read: UnifiedAttentionReadV1,
  source: PersonalActionSource,
): PersonalActionRefusal | null {
  if (
    read.status === 'available' &&
    read.consistency.state === 'verified' &&
    read.consistency.reasons.length === 0 &&
    Object.values(read.sources).every(complete)
  )
    return null;

  // This is the known, source-attributed failure. Unknown reasons and identity conflicts remain unverified.
  if (
    source === 'mentions' &&
    complete(read.sources.userMentions) &&
    complete(read.sources.personalPreferences) &&
    read.status === 'partial' &&
    read.sources.collectiveAccountabilityRequests?.status === 'unavailable' &&
    read.consistency.reasons.length > 0 &&
    read.consistency.reasons.every((reason) => reason === 'collective_accountability_connection_read_failed') &&
    Object.entries(read.sources).every(
      ([name, value]) => name === 'collectiveAccountabilityRequests' || complete(value),
    )
  )
    return null;
  return 'source';
}
