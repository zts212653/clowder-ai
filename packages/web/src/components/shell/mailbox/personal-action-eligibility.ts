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
  if (
    read.status === 'available' &&
    read.consistency.state === 'verified' &&
    read.consistency.reasons.length === 0 &&
    Object.values(read.sources).every(complete)
  )
    return null;

  // Both Host generations attribute this outage to Collective. Identity/invalid states and unknown reasons stay blocked.
  if (
    source !== 'all' &&
    complete(read.sources[source === 'mentions' ? 'userMentions' : source]) &&
    complete(read.sources.personalPreferences) &&
    read.status === 'partial' &&
    read.sources.collectiveAccountabilityRequests?.status === 'unavailable' &&
    read.consistency.reasons.length > 0 &&
    read.consistency.reasons.every(
      (reason) =>
        reason === 'collective_accountability_connection_read_failed' ||
        reason === 'collective_accountability_plugin_unavailable',
    ) &&
    Object.entries(read.sources).every(
      ([name, value]) => name === 'collectiveAccountabilityRequests' || complete(value),
    )
  )
    return null;
  return 'source';
}
