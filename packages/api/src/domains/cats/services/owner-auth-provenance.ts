/**
 * Authentication-grade provenance for the user who owns an invocation.
 *
 * `userId` remains the tenant partition key. This field answers the separate
 * question of whether that owner was proven by strict request authentication.
 * Legacy records and non-user producers fail closed as `unknown`.
 */
export type OwnerAuthProvenance = 'strict' | 'compatibility_fallback' | 'unknown';

export function normalizeOwnerAuthProvenance(value: unknown): OwnerAuthProvenance {
  return value === 'strict' || value === 'compatibility_fallback' ? value : 'unknown';
}

/**
 * Producer-side guard for internal carriers.
 *
 * Normalization is reserved for hydrating legacy durable records. New carrier
 * producers must choose an explicit grade so an omitted proof cannot silently
 * become a different authorization claim while crossing an async boundary.
 */
export function requireOwnerAuthProvenance(value: unknown): OwnerAuthProvenance {
  if (value === 'strict' || value === 'compatibility_fallback' || value === 'unknown') return value;
  throw new Error('ownerAuthProvenance must be explicit on every carrier producer');
}
