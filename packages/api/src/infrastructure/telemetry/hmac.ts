/**
 * F152: HMAC-based ID pseudonymization for external telemetry.
 *
 * System identifiers (threadId, invocationId, etc.) are HMAC'd
 * before leaving the machine. Same input → same hash within an
 * instance, enabling cross-signal correlation in external tools
 * (e.g. Sentry) without exposing raw IDs.
 *
 * Salt MUST be injected via TELEMETRY_HMAC_SALT env var.
 * Missing salt in non-dev environments disables OTel (server continues
 * without telemetry). Dev/test environments use a fallback salt.
 */

import { createHmac } from 'node:crypto';

const TENANT_SALT = process.env.TELEMETRY_HMAC_SALT;

function getSalt(): string {
  if (TENANT_SALT) return TENANT_SALT;
  const env = process.env.NODE_ENV;
  if (env === 'development' || env === 'test') {
    return 'dev-only-insecure-salt';
  }
  throw new Error(
    'TELEMETRY_HMAC_SALT is required in non-dev environments. ' + 'Set it in .env or your secret manager.',
  );
}

/**
 * Validate salt is available. Called at startup by initTelemetry().
 * Throws if salt is missing in non-dev environments — caller catches
 * and disables OTel gracefully (server continues without telemetry).
 */
export function validateSalt(): void {
  getSalt();
}

/**
 * HMAC-SHA256 pseudonymize an identifier.
 * Returns first 32 hex chars (128-bit, collision-safe for correlation).
 */
export function hmacId(id: string): string {
  return createHmac('sha256', getSalt()).update(id).digest('hex').slice(0, 32);
}

/** Env-gated escape hatch: export raw IDs (for self-hosted controlled envs). */
export function shouldExportRawIds(): boolean {
  return process.env.TELEMETRY_EXPORT_RAW_SYSTEM_IDS === '1';
}

/**
 * Pseudonymize a system identifier for external telemetry.
 * Returns raw ID if escape hatch is enabled, HMAC otherwise.
 */
export function pseudonymizeId(id: string): string {
  return shouldExportRawIds() ? id : hmacId(id);
}
