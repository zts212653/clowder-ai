export const CONTEXT_SOURCE_OMISSIONS = [
  'scope_unavailable',
  'owner_mismatch',
  'source_unavailable',
  'source_corrected',
  'source_forgotten',
  'scope_revoked',
  'superseded',
  'expired',
  'index_stale',
  'index_revision_unverified',
  'degraded',
  'timeout',
  'invocation_budget_exhausted',
  'duplicate',
] as const;
export type ContextSourceOmission = (typeof CONTEXT_SOURCE_OMISSIONS)[number];
