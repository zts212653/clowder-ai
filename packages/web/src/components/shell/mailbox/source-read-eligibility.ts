import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';

export type MailboxActionSource =
  | 'approvals'
  | 'needsMe'
  | 'structuredChoices'
  | 'userMentions'
  | 'personalPreferences';

export function sourceReadComplete(source: UnifiedAttentionSourceRead | undefined): boolean {
  return source?.status === 'available' && source.exhaustiveness === 'complete';
}

/** Availability is source-local; unverified identity, conflicting joins and unknown diagnostics are not. */
export function mailboxSourcesReadable(read: UnifiedAttentionReadV1, ...required: MailboxActionSource[]): boolean {
  if (
    read.status === 'unavailable' ||
    !Array.isArray(read.consistency.reasons) ||
    required.some((source) => !sourceReadComplete(read.sources[source])) ||
    Object.values(read.sources).some((source) => source?.status !== 'available' && source?.status !== 'unavailable')
  )
    return false;
  if (read.consistency.state === 'verified' && read.consistency.reasons.length === 0) return true;

  // Existing Host availability diagnostics: never treat a substring, identity conflict or unknown reason as an outage.
  return (
    read.status === 'partial' &&
    read.sources.collectiveAccountabilityRequests?.status === 'unavailable' &&
    read.consistency.state === 'uncertain' &&
    read.consistency.reasons.length > 0 &&
    read.consistency.reasons.every(
      (reason) =>
        reason === 'collective_accountability_connection_read_failed' ||
        reason === 'collective_accountability_plugin_unavailable',
    )
  );
}
