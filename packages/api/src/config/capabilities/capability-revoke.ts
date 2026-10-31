import type { CapabilityEntry } from '@cat-cafe/shared';

interface RevokeResult {
  entry: CapabilityEntry;
  revokedBy: string;
  revokedAt: string;
  auditAction: 'revoke';
}

export function revokeCapability(entry: CapabilityEntry, revoker: string): RevokeResult {
  if (entry.source === 'cat-cafe') {
    throw new Error(`cannot revoke cat-cafe source capability: ${entry.id}`);
  }

  return {
    entry: { ...entry, enabled: false },
    revokedBy: revoker,
    revokedAt: new Date().toISOString(),
    auditAction: 'revoke',
  };
}
