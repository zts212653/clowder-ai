import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { SqliteLimbPersistence } = await import('../dist/domains/limb/SqliteLimbPersistence.js');
const { LimbPairingStore } = await import('../dist/domains/limb/LimbPairingStore.js');

describe('LimbPairingStore with persistence', () => {
  let tempDir;
  let dbPath;
  let persistence;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'limb-pairing-'));
    dbPath = join(tempDir, 'limb.sqlite');
    persistence = new SqliteLimbPersistence(dbPath);
    persistence.initialize();
  });

  afterEach(() => {
    persistence.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips approved pairing across store instances', () => {
    const store1 = new LimbPairingStore(persistence);
    const req = store1.createRequest({
      nodeId: 'n1',
      displayName: 'Node 1',
      platform: 'linux',
      endpointUrl: 'http://localhost:8080',
      capabilities: [{ cap: 'shell', commands: ['exec'], authLevel: 'free' }],
    });
    store1.approve(req.requestId);

    // New store from same DB
    const store2 = new LimbPairingStore(persistence);
    store2.initialize();
    const approved = store2.getApproved();
    assert.equal(approved.length, 1);
    assert.equal(approved[0].nodeId, 'n1');
    assert.equal(approved[0].status, 'approved');
  });

  it('works without persistence (backward compat)', () => {
    const store = new LimbPairingStore();
    const req = store.createRequest({
      nodeId: 'n2',
      displayName: 'Node 2',
      platform: 'darwin',
      endpointUrl: 'http://localhost:9090',
      capabilities: [],
    });
    assert.equal(store.getPending().length, 1);
    store.approve(req.requestId);
    assert.equal(store.getApproved().length, 1);
  });

  it('rejected pairings also persist', () => {
    const store1 = new LimbPairingStore(persistence);
    const req = store1.createRequest({
      nodeId: 'n3',
      displayName: 'Node 3',
      platform: 'linux',
      endpointUrl: 'http://localhost:7070',
      capabilities: [],
    });
    store1.reject(req.requestId);

    const store2 = new LimbPairingStore(persistence);
    store2.initialize();
    assert.equal(store2.getPending().length, 0);
    assert.equal(store2.getApproved().length, 0);
    assert.equal(store2.get(req.requestId)?.status, 'rejected');
  });
});
