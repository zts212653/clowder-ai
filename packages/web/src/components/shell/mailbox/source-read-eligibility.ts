import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';

export type MailboxActionSource =
  | 'approvals'
  | 'needsMe'
  | 'structuredChoices'
  | 'userMentions'
  | 'personalPreferences';

const COLLECTIVE_AVAILABILITY_REASONS = new Set([
  'collective_accountability_plugin_unavailable',
  'collective_accountability_connector_unavailable',
  'collective_accountability_connection_index_unavailable',
  'collective_accountability_route_read_failed',
  'collective_accountability_connection_read_failed',
  'collective_accountability_connection_authority_unavailable',
  'collective_accountability_authority_changed',
  'collective_project_attention_source_unavailable',
]);

export function sourceReadComplete(source: UnifiedAttentionSourceRead | undefined): boolean {
  return source?.status === 'available' && source.exhaustiveness === 'complete';
}

function hasCollectiveSourceOutage(read: UnifiedAttentionReadV1): boolean {
  const accountability = read.sources.collectiveAccountabilityRequests;
  const project = read.sources.collectiveProjectAttention;
  return (
    (accountability !== undefined && !sourceReadComplete(accountability)) ||
    (project !== undefined && !sourceReadComplete(project))
  );
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
    hasCollectiveSourceOutage(read) &&
    read.consistency.state === 'uncertain' &&
    read.consistency.reasons.length > 0 &&
    read.consistency.reasons.every((reason) => COLLECTIVE_AVAILABILITY_REASONS.has(reason))
  );
}
