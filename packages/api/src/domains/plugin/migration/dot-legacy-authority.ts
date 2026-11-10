import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentKeyRecord } from '@cat-cafe/shared';
import type { AgentKeyRegistry } from '../../cats/services/agents/agent-key/AgentKeyRegistry.js';
import type { LegacyDotConnectionState } from './dot-legacy-schemas.js';

export type LegacyDotCredentialAuthorityReason =
  | 'active'
  | 'source_revoked'
  | 'key_missing'
  | 'secret_mismatch'
  | 'identity_mismatch'
  | 'key_revoked'
  | 'key_expired';

export interface LegacyDotCredentialAuthorityAudit {
  readonly agentKeyId: string;
  readonly observedAt: number;
  readonly active: boolean;
  readonly reason: LegacyDotCredentialAuthorityReason;
  readonly recordPresent: boolean;
  readonly secretMatched: boolean;
  readonly identityMatched: boolean;
  readonly authorityEndedAt: number | null;
}

export async function auditLegacyDotCredential(
  source: LegacyDotConnectionState,
  options: {
    readonly keys: Pick<AgentKeyRegistry, 'get'>;
    readonly now?: () => number;
  },
): Promise<{ connection: LegacyDotConnectionState; authority: LegacyDotCredentialAuthorityAudit }> {
  const record = await options.keys.get(source.agentKeyId);
  const observedAt = (options.now ?? Date.now)();
  const recordPresent = record !== null;
  const secretMatched = record ? secretMatches(source.credentialSecret, record) : false;
  const identityMatched = record
    ? record.agentKeyId === source.agentKeyId &&
      record.catId === 'gpt-dot' &&
      record.userId === source.ownerUserId &&
      record.scope === 'user-bound'
    : false;
  const inactive = inactiveAuthority(source, record, secretMatched, identityMatched, observedAt);
  const revokedAt = source.revokedAt ?? inactive.authorityEndedAt;
  return {
    connection: revokedAt === source.revokedAt ? source : { ...source, revokedAt },
    authority: {
      agentKeyId: source.agentKeyId,
      observedAt,
      active: inactive.reason === 'active',
      reason: inactive.reason,
      recordPresent,
      secretMatched,
      identityMatched,
      authorityEndedAt: inactive.authorityEndedAt,
    },
  };
}

function inactiveAuthority(
  source: LegacyDotConnectionState,
  record: AgentKeyRecord | null,
  secretMatched: boolean,
  identityMatched: boolean,
  observedAt: number,
): { reason: LegacyDotCredentialAuthorityReason; authorityEndedAt: number | null } {
  if (source.revokedAt !== null) return { reason: 'source_revoked', authorityEndedAt: source.revokedAt };
  if (!record) return { reason: 'key_missing', authorityEndedAt: observedAt };
  if (!secretMatched) return { reason: 'secret_mismatch', authorityEndedAt: observedAt };
  if (!identityMatched) return { reason: 'identity_mismatch', authorityEndedAt: observedAt };
  if (record.revokedAt !== undefined) return { reason: 'key_revoked', authorityEndedAt: record.revokedAt };
  if (record.graceUntil !== undefined && observedAt > record.graceUntil) {
    return { reason: 'key_expired', authorityEndedAt: record.graceUntil };
  }
  if (record.graceUntil === undefined && record.expiresAt !== null && observedAt > record.expiresAt) {
    return { reason: 'key_expired', authorityEndedAt: record.expiresAt };
  }
  return { reason: 'active', authorityEndedAt: null };
}

function secretMatches(secret: string, record: AgentKeyRecord): boolean {
  const actual = Buffer.from(
    createHash('sha256')
      .update(secret + record.salt)
      .digest('hex'),
  );
  const expected = Buffer.from(record.secretHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
