import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { SqliteLimbPersistence } = await import('../dist/domains/limb/SqliteLimbPersistence.js');

describe('SqliteLimbPersistence', () => {
  let tempDir;
  let dbPath;
  let persistence;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'limb-persist-'));
    dbPath = join(tempDir, 'limb.sqlite');
    persistence = new SqliteLimbPersistence(dbPath);
    persistence.initialize();
  });

  afterEach(() => {
    persistence.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('pairing CRUD', () => {
    const samplePairing = {
      requestId: 'req-1',
      nodeId: 'node-1',
      displayName: 'Test Node',
      platform: 'linux',
      endpointUrl: 'http://localhost:9090',
      capabilities: [{ cap: 'shell', commands: ['exec'], authLevel: 'free' }],
      status: 'pending',
      createdAt: Date.now(),
      apiKey: 'key-abc-123',
    };

    it('upsert + load round-trips a pairing', () => {
      persistence.upsertPairing(samplePairing);
      const loaded = persistence.loadPairings();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].requestId, 'req-1');
      assert.equal(loaded[0].nodeId, 'node-1');
      assert.equal(loaded[0].apiKey, 'key-abc-123');
      assert.deepStrictEqual(loaded[0].capabilities, samplePairing.capabilities);
    });

    it('upsert updates existing pairing on conflict', () => {
      persistence.upsertPairing(samplePairing);
      persistence.upsertPairing({ ...samplePairing, status: 'approved', decidedAt: Date.now() });
      const loaded = persistence.loadPairings();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].status, 'approved');
      assert.ok(loaded[0].decidedAt);
    });

    it('delete removes a pairing', () => {
      persistence.upsertPairing(samplePairing);
      persistence.deletePairing('req-1');
      assert.equal(persistence.loadPairings().length, 0);
    });

    it('survives close + reopen', () => {
      persistence.upsertPairing(samplePairing);
      persistence.close();

      const p2 = new SqliteLimbPersistence(dbPath);
      p2.initialize();
      const loaded = p2.loadPairings();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].requestId, 'req-1');
      p2.close();
    });
  });

  describe('access policy CRUD', () => {
    const samplePolicy = { catId: 'cat-1', nodeId: 'node-1', capability: 'shell', authLevel: 'leased' };

    it('upsert + load round-trips an access policy', () => {
      persistence.upsertAccessPolicy(samplePolicy);
      const loaded = persistence.loadAccessPolicies();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].catId, 'cat-1');
      assert.equal(loaded[0].authLevel, 'leased');
    });

    it('upsert updates on composite key conflict', () => {
      persistence.upsertAccessPolicy(samplePolicy);
      persistence.upsertAccessPolicy({ ...samplePolicy, authLevel: 'gated' });
      const loaded = persistence.loadAccessPolicies();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].authLevel, 'gated');
    });
  });
});
