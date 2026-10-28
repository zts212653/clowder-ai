import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';

export type PersonalActionSource = 'mentions' | 'structuredChoices' | 'approvals' | 'needsMe' | 'all';
export type PersonalActionRefusal = 'refreshing' | 'saving' | 'identity' | 'preferences' | 'changed' | 'source';

function complete(source: UnifiedAttentionSourceRead | undefined): boolean {
  return source?.status === 'available' && source.exhaustiveness === 'complete';
}

/** Global counts need every source. A personal presentation action needs its own proven producer. */
export function personalSourceRefusal(
  read: UnifiedAttentionReadV1,
  source: PersonalActionSource,
): PersonalActionRefusal | null {
  const consistent = read.consistency.state === 'verified' && read.consistency.reasons.length === 0;
  if (source === 'all')
    return read.status === 'available' && consistent && Object.values(read.sources).every(complete) ? null : 'source';

  if (
    read.status === 'unavailable' ||
    !complete(read.sources[source === 'mentions' ? 'userMentions' : source]) ||
    !complete(read.sources.personalPreferences) ||
    Object.values(read.sources).some((value) => value?.status !== 'available' && value?.status !== 'unavailable')
  )
    return 'source';
  if (consistent) return null;

  // Availability diagnostics do not revoke another producer's proof. Identity, conflicts and unknown reasons do.
  if (
    read.status === 'partial' &&
    read.sources.collectiveAccountabilityRequests?.status === 'unavailable' &&
    read.consistency.reasons.length > 0 &&
    read.consistency.reasons.every(
      (reason) =>
        reason === 'collective_accountability_connection_read_failed' ||
        reason === 'collective_accountability_plugin_unavailable',
    )
  )
    return null;
  return 'source';
}
