import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileDotLegacyMigrationAuditStore } from '../src/domains/plugin/migration/dot-legacy-migration-audit-store.js';
import type { DotLegacyMigrationAudit } from '../src/domains/plugin/migration/dot-legacy-migration-coordinator.js';

function audit(instance: string): DotLegacyMigrationAudit {
  return {
    version: 1,
    ownerUserId: 'owner-1',
    sourceInstanceId: 'legacy-instance',
    pluginInstanceId: instance,
    packageDigest: `sha512-${instance}`,
    authority: {
      agentKeyId: 'ak_legacy',
      observedAt: 1,
      active: false,
      reason: 'key_missing',
      recordPresent: false,
      secretMatched: false,
      identityMatched: false,
      authorityEndedAt: 1,
    },
    receipts: [],
    media: [],
    sourceDeleted: false,
    completedAt: 2,
  };
}

test('persists one sanitized audit per exact source and target binding', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-migration-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileDotLegacyMigrationAuditStore(join(directory, 'audit.json'));

  await store.save(audit('instance-a'));
  await store.save(audit('instance-b'));

  const records = Object.values((await store.read()).records);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.pluginInstanceId).sort(), ['instance-a', 'instance-b']);
  assert.equal(JSON.stringify(records).includes('credentialSecret'), false);
});

test('answers exact completion and durable owner supersession independently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-migration-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileDotLegacyMigrationAuditStore(join(directory, 'audit.json'));
  const completed = audit('instance-a');

  await store.save(completed);
  assert.deepEqual(
    await store.findCompleted({
      ownerUserId: completed.ownerUserId,
      sourceInstanceId: completed.sourceInstanceId,
      pluginInstanceId: completed.pluginInstanceId,
      packageDigest: completed.packageDigest,
    }),
    completed,
  );
  assert.equal(
    await store.hasCompletedSource({
      ownerUserId: completed.ownerUserId,
      sourceInstanceId: completed.sourceInstanceId,
    }),
    true,
  );
  assert.equal(
    await store.isSuperseded({ ownerUserId: completed.ownerUserId, sourceInstanceId: completed.sourceInstanceId }),
    false,
  );

  await store.supersede({
    version: 1,
    ownerUserId: completed.ownerUserId,
    sourceInstanceId: completed.sourceInstanceId,
    reason: 'owner_reconnect',
    supersededAt: 3,
  });
  await store.supersede({
    version: 1,
    ownerUserId: completed.ownerUserId,
    sourceInstanceId: completed.sourceInstanceId,
    reason: 'package_state_diverged',
    supersededAt: 4,
  });
  assert.equal(
    await store.isSuperseded({ ownerUserId: completed.ownerUserId, sourceInstanceId: completed.sourceInstanceId }),
    true,
  );
  assert.equal(
    await store.isSuperseded({ ownerUserId: 'other-owner', sourceInstanceId: completed.sourceInstanceId }),
    false,
  );
  const persisted = await store.read();
  assert.deepEqual(Object.values(persisted.supersessions), [
    {
      version: 1,
      ownerUserId: completed.ownerUserId,
      sourceInstanceId: completed.sourceInstanceId,
      reason: 'owner_reconnect',
      supersededAt: 3,
    },
  ]);
});

test('same-installation audit recovery keeps owner, source and instance isolation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-migration-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'audit.json');
  await new FileDotLegacyMigrationAuditStore(path).save(audit('instance-a'));
  const store = new FileDotLegacyMigrationAuditStore(path);
  const query = { ownerUserId: 'owner-1', sourceInstanceId: 'legacy-instance', pluginInstanceId: 'instance-a' };
  assert.deepEqual(await store.findCompleted(query), audit('instance-a'));
  for (const changed of [
    { ownerUserId: 'other' },
    { sourceInstanceId: 'other' },
    { pluginInstanceId: 'other' },
    { packageDigest: 'other' },
  ])
    assert.equal(await store.findCompleted({ ...query, ...changed }), undefined);
});
