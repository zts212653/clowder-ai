import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { AgentKeyRecord } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { auditLegacyDotCredential } from '../src/domains/plugin/migration/dot-legacy-authority.js';
import type { LegacyDotConnectionState } from '../src/domains/plugin/migration/dot-legacy-schemas.js';

const now = 20_000;
const secret = 'a'.repeat(64);
const salt = 'salt';

function connection(overrides: Partial<LegacyDotConnectionState> = {}): LegacyDotConnectionState {
  return {
    v: 1,
    revision: 1,
    ownerUserId: 'owner-1',
    pluginInstanceId: 'legacy-instance',
    agentKeyId: 'ak_legacy',
    credentialSecret: secret,
    attemptId: 'attempt-1',
    pairingCode: 'b'.repeat(32),
    pairingExpiresAt: now + 1000,
    pairedAt: now - 1000,
    pairedCallbackUrl: 'https://example.com/dot',
    subscription: null,
    lastSourceReadAt: null,
    lastReplyAt: null,
    lastImageAt: null,
    revokedAt: null,
    testEventIds: [],
    ...overrides,
  };
}

function key(overrides: Partial<AgentKeyRecord> = {}): AgentKeyRecord {
  return {
    agentKeyId: 'ak_legacy',
    catId: createCatId('gpt-dot'),
    userId: 'owner-1',
    secretHash: createHash('sha256')
      .update(secret + salt)
      .digest('hex'),
    salt,
    scope: 'user-bound',
    issuedAt: 1,
    expiresAt: null,
    ...overrides,
  };
}

test('authority expiry uses the time after the registry lookup completes', async () => {
  let clock = now;
  const checked = await auditLegacyDotCredential(connection(), {
    now: () => clock,
    keys: {
      get: async () => {
        clock += 1000;
        return key({ expiresAt: now + 100 });
      },
    },
  });
  assert.equal(checked.authority.active, false);
  assert.equal(checked.authority.reason, 'key_expired');
});

test('read-only authority audit preserves an exact active legacy credential', async () => {
  let reads = 0;
  const result = await auditLegacyDotCredential(connection(), {
    keys: {
      async get(id) {
        reads += 1;
        assert.equal(id, 'ak_legacy');
        return key();
      },
    },
    now: () => now,
  });

  assert.equal(reads, 1);
  assert.equal(result.connection.revokedAt, null);
  assert.deepEqual(result.authority, {
    agentKeyId: 'ak_legacy',
    observedAt: now,
    active: true,
    reason: 'active',
    recordPresent: true,
    secretMatched: true,
    identityMatched: true,
    authorityEndedAt: null,
  });
});

for (const scenario of [
  { name: 'missing', record: null, reason: 'key_missing', endedAt: now },
  { name: 'revoked', record: key({ revokedAt: 1234 }), reason: 'key_revoked', endedAt: 1234 },
  { name: 'expired', record: key({ expiresAt: 9000 }), reason: 'key_expired', endedAt: 9000 },
  {
    name: 'wrong identity',
    record: key({ userId: 'another-owner' }),
    reason: 'identity_mismatch',
    endedAt: now,
  },
  {
    name: 'wrong secret',
    record: key({ secretHash: createHash('sha256').update('different').digest('hex') }),
    reason: 'secret_mismatch',
    endedAt: now,
  },
] as const) {
  test(`authority audit monotonically revokes an inactive ${scenario.name} credential`, async () => {
    const result = await auditLegacyDotCredential(connection(), {
      keys: { get: async () => scenario.record },
      now: () => now,
    });
    assert.equal(result.connection.revokedAt, scenario.endedAt);
    assert.equal(result.authority.active, false);
    assert.equal(result.authority.reason, scenario.reason);
    assert.equal(result.authority.authorityEndedAt, scenario.endedAt);
  });
}

test('authority audit never replaces an earlier source revocation timestamp', async () => {
  const result = await auditLegacyDotCredential(connection({ revokedAt: 777 }), {
    keys: { get: async () => null },
    now: () => now,
  });
  assert.equal(result.connection.revokedAt, 777);
  assert.equal(result.authority.active, false);
  assert.equal(result.authority.reason, 'source_revoked');
  assert.equal(result.authority.authorityEndedAt, 777);
});
