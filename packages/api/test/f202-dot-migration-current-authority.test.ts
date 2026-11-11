import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import {
  MemoryPluginExternalAccessStore,
  PluginExternalAccessService,
} from '../src/domains/plugin/external-access/plugin-external-access.js';
import {
  type DotLegacyMigrationAudit,
  DotLegacyMigrationCoordinator,
} from '../src/domains/plugin/migration/dot-legacy-migration-coordinator.js';
import { DotLegacyMigrationJourney } from '../src/domains/plugin/migration/dot-legacy-migration-journey.js';

async function fixture(duringImport: (keys: AgentKeyRegistry, keyId: string) => Promise<void> = async () => {}) {
  const keys = new AgentKeyRegistry();
  const key = await keys.issue(createCatId('gpt-dot'), 'owner-1', { expiresAt: null });
  const connection = {
    v: 1 as const,
    revision: 1,
    ownerUserId: 'owner-1',
    pluginInstanceId: 'legacy-instance',
    agentKeyId: key.agentKeyId,
    credentialSecret: key.secret,
    attemptId: 'attempt-1',
    pairingCode: 'a'.repeat(32),
    pairingExpiresAt: Date.now() + 60_000,
    pairedAt: 1,
    pairedCallbackUrl: 'https://example.com/dot',
    subscription: null,
    lastSourceReadAt: null,
    lastReplyAt: null,
    lastImageAt: null,
    revokedAt: null as number | null,
    testEventIds: [],
  };
  const source = { connection: async () => structuredClone(connection) };
  const input = {
    pluginId: 'official.chatgpt-dot',
    pluginInstanceId: 'target-instance',
    packageDigest: 'package-digest',
    ownerUserId: 'owner-1',
    requestId: 'request-1',
    signal: new AbortController().signal,
    assertCurrent() {},
  };
  const store = new MemoryPluginExternalAccessStore();
  const externalAccess = new PluginExternalAccessService({
    store,
    endpoint: '/api/plugin-runtime/handle',
    inventory: {
      snapshot: async () =>
        ({
          schemaVersion: 1,
          packages: [],
          grants: [],
          instances: [
            {
              pluginInstanceId: input.pluginInstanceId,
              lifecycleState: 'installed',
            },
          ],
        }) as never,
    },
    handler: { handle: async () => ({}) },
  });
  const records: DotLegacyMigrationAudit[] = [];
  const audit = {
    save: async (value: DotLegacyMigrationAudit) => {
      records.push(value);
    },
    findCompleted: async () => records[0],
    hasCompletedSource: async () => records.length > 0,
    isSuperseded: async () => false,
    supersede: async () => {},
  };
  const shared: unknown[] = [];
  let calls = 0;
  const coordinator = new DotLegacyMigrationCoordinator({
    source: {
      ...source,
      dispatches: async () => [],
      imageMetadata: async () => [],
      imageBytes: async () => Buffer.alloc(0),
    },
    keys,
    externalAccess,
    audit,
    media: { register: async () => 'unused' },
    invoker: {
      invoke: async (request) => {
        if (++calls === 1) await duringImport(keys, key.agentKeyId);
        const batch = request.payload as {
          ownerUserId: string;
          sourceInstanceId: string;
          connection?: unknown;
          dispatches: unknown[];
          images: unknown[];
        };
        return {
          version: 1,
          batchDigest: createHash('sha256').update(JSON.stringify(batch)).digest('hex'),
          ownerUserId: batch.ownerUserId,
          sourceInstanceId: batch.sourceInstanceId,
          pluginInstanceId: input.pluginInstanceId,
          connection: batch.connection ? 1 : 0,
          dispatches: batch.dispatches.length,
          images: batch.images.length,
          inserted: 1,
          alreadyPresent: 0,
          sourceDeleted: false,
          importedAt: Date.now(),
        };
      },
    },
    sharedExtension: {
      adoptVerifiedLegacy: async (value) => {
        shared.push(value);
      },
    },
  });
  const journey = new DotLegacyMigrationJourney({ source, coordinator, audit });
  return { journey, input, keys, key, store, externalAccess, records, shared, connection };
}

test('a key revoked while the importer is awaiting cannot become migrated external authority', async () => {
  const f = await fixture(async (keys, id) => {
    await keys.revoke(id, 'revoked-during-import');
  });
  await f.journey.ensure(f.input);
  assert.equal(await f.store.resolve(f.key.secret), undefined);
  assert.equal(f.records[0]?.authority.active, false);
  await f.journey.afterEnable(f.input);
  assert.equal(f.shared.length, 0);
});

test('a dormant import cannot establish shared authority after its original key was revoked', async () => {
  const f = await fixture();
  await f.journey.ensure(f.input);
  assert.equal(await f.store.resolve(f.key.secret), f.input.pluginInstanceId);
  await f.keys.issue(createCatId('gpt-pro'), 'owner-1', { expiresAt: null });
  await f.keys.revoke(f.key.agentKeyId, 'revoked-before-enable');
  assert.equal(await f.journey.ensure(f.input), null);
  await f.journey.afterEnable(f.input);
  assert.equal(f.shared.length, 0);
  assert.equal(await f.store.resolve(f.key.secret), undefined);
});

test('an owner request withdrawn during import cannot adopt its old bearer', async () => {
  let withdrawn = false;
  const f = await fixture(async () => {
    withdrawn = true;
  });
  f.input.assertCurrent = () => {
    if (withdrawn) throw new Error('owner_request_expired');
  };
  await assert.rejects(f.journey.ensure(f.input), /owner_request_expired/);
  assert.equal(await f.store.resolve(f.key.secret), undefined);
});

test('a source revocation before enable also blocks adoption, while valid same-installation updates work', async () => {
  const valid = await fixture();
  await valid.journey.ensure(valid.input);
  await valid.journey.afterEnable({ ...valid.input, packageDigest: 'updated-package' });
  assert.equal(valid.shared.length, 1);
  assert.equal(await valid.store.resolve(valid.key.secret), valid.input.pluginInstanceId);
  const revoked = await fixture();
  await revoked.journey.ensure(revoked.input);
  revoked.connection.revokedAt = Date.now();
  await revoked.journey.afterEnable(revoked.input);
  assert.equal(revoked.shared.length, 0);
  assert.equal(await revoked.store.resolve(revoked.key.secret), undefined);
});
