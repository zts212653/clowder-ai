import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DotLegacyMigrationAudit } from '../src/domains/plugin/migration/dot-legacy-migration-coordinator.js';
import { DotLegacyMigrationJourney } from '../src/domains/plugin/migration/dot-legacy-migration-journey.js';

const pluginId = 'official.chatgpt-dot';
const ownerUserId = 'owner-1';
const sourceInstanceId = 'legacy-instance';
const packageDigest = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;

function completed(pluginInstanceId: string): DotLegacyMigrationAudit {
  return {
    version: 1,
    ownerUserId,
    sourceInstanceId,
    pluginInstanceId,
    packageDigest,
    authority: {
      agentKeyId: 'ak_legacy',
      observedAt: 1,
      active: true,
      reason: 'active',
      recordPresent: true,
      secretMatched: true,
      identityMatched: true,
      authorityEndedAt: null,
    },
    receipts: [],
    media: [],
    sourceDeleted: false,
    completedAt: 2,
  };
}

function input(pluginInstanceId: string) {
  return {
    pluginId,
    pluginInstanceId,
    packageDigest,
    ownerUserId,
    requestId: 'request-1',
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
}

function fixture({
  existing = [] as DotLegacyMigrationAudit[],
  migrate,
  reconcileShared,
}: {
  existing?: DotLegacyMigrationAudit[];
  migrate?: () => Promise<DotLegacyMigrationAudit>;
  reconcileShared?: (audit: DotLegacyMigrationAudit) => Promise<void>;
} = {}) {
  const supersessions: Array<{ ownerUserId: string; sourceInstanceId: string; reason: string }> = [];
  const audit = {
    findCompleted: async (query: {
      ownerUserId: string;
      sourceInstanceId: string;
      pluginInstanceId: string;
      packageDigest?: string;
    }) =>
      existing.find(
        (record) =>
          record.ownerUserId === query.ownerUserId &&
          record.sourceInstanceId === query.sourceInstanceId &&
          record.pluginInstanceId === query.pluginInstanceId &&
          (query.packageDigest === undefined || record.packageDigest === query.packageDigest),
      ),
    hasCompletedSource: async (query: { ownerUserId: string; sourceInstanceId: string }) =>
      existing.some(
        (record) => record.ownerUserId === query.ownerUserId && record.sourceInstanceId === query.sourceInstanceId,
      ),
    isSuperseded: async (query: { ownerUserId: string; sourceInstanceId: string }) =>
      supersessions.some(
        (record) => record.ownerUserId === query.ownerUserId && record.sourceInstanceId === query.sourceInstanceId,
      ),
    supersede: async (record: { ownerUserId: string; sourceInstanceId: string; reason: string }) => {
      supersessions.push(record);
    },
  };
  let migrateCalls = 0;
  const journey = new DotLegacyMigrationJourney({
    source: {
      connection: async () => ({ ownerUserId, pluginInstanceId: sourceInstanceId }) as never,
    },
    coordinator: {
      migrate: async () => {
        migrateCalls += 1;
        return migrate ? migrate() : completed('target-instance');
      },
      ...(reconcileShared ? { reconcileShared } : {}),
    },
    audit,
    now: () => 10,
  });
  return { journey, supersessions, migrateCalls: () => migrateCalls };
}

test('an exact completed target is a terminal migration fact, not a reason to re-read legacy files', async () => {
  const prior = completed('target-instance');
  const reconciled: DotLegacyMigrationAudit[] = [];
  const f = fixture({
    existing: [prior],
    reconcileShared: async (audit) => {
      reconciled.push(audit);
    },
  });

  assert.equal(await f.journey.ensure(input('target-instance')), null);
  assert.equal(f.migrateCalls(), 0);
  assert.deepEqual(reconciled, []);
  await f.journey.afterEnable(input('target-instance'));
  assert.deepEqual(reconciled, [prior]);
});

test('a completed legacy source is never imported into a replacement installation', async () => {
  const f = fixture({
    existing: [completed('old-instance')],
    migrate: async () => {
      throw new Error('dot_migration_conflict');
    },
  });

  assert.equal(await f.journey.ensure(input('new-instance')), null);
  assert.equal(f.migrateCalls(), 0);
  assert.deepEqual(f.supersessions, []);
});

test('a first-import conflict stays inside the isolated lifecycle migration instead of coupling to package action names', async () => {
  const f = fixture({
    migrate: async () => {
      throw new Error('dot_migration_conflict');
    },
  });

  await assert.rejects(f.journey.ensure(input('target-instance')), /dot_migration_conflict/);
  assert.equal(await f.journey.needsMigration(pluginId, ownerUserId), true);
});

test('owner enable after same-instance update reuses the original completed audit without importing keys', async () => {
  const prior = completed('target-instance');
  const reconciled: unknown[] = [];
  const f = fixture({
    existing: [prior],
    reconcileShared: async (...args) => {
      reconciled.push(args);
    },
  });
  const updated = { ...input('target-instance'), packageDigest: 'updated-digest' };
  assert.equal(await f.journey.ensure(updated), null);
  await f.journey.afterEnable(updated);
  assert.equal(f.migrateCalls(), 0);
  assert.equal(reconciled.length, 1);
  assert.deepEqual(reconciled, [
    [prior, { packageDigest: updated.packageDigest, assertCurrent: updated.assertCurrent }],
  ]);
  await f.journey.afterEnable({ ...updated, pluginInstanceId: 'replacement' });
  await f.journey.afterEnable({ ...updated, ownerUserId: 'other' });
  await f.journey.supersede(updated, 'owner_reconnect');
  await f.journey.afterEnable(updated);
  assert.equal(reconciled.length, 1);
});
