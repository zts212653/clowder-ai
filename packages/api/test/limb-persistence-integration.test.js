import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { SqliteLimbPersistence } = await import('../dist/domains/limb/SqliteLimbPersistence.js');
const { LimbPairingStore } = await import('../dist/domains/limb/LimbPairingStore.js');
const { LimbAccessPolicy } = await import('../dist/domains/limb/LimbAccessPolicy.js');
const { LimbRegistry } = await import('../dist/domains/limb/LimbRegistry.js');
const { RemoteLimbNode } = await import('../dist/domains/limb/RemoteLimbNode.js');

describe('#331 Integration: limb state survives restart', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'limb-integration-'));
    dbPath = join(tempDir, 'limb.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('approved pairing + access policy survive teardown and reload as offline stub', async () => {
    // ── Session 1: register, approve, set policy ──
    const p1 = new SqliteLimbPersistence(dbPath);
    p1.initialize();
    const store1 = new LimbPairingStore(p1);
    const policy1 = new LimbAccessPolicy(p1);
    const registry1 = new LimbRegistry();
    registry1.setDeps({ accessPolicy: policy1 });

    const req = store1.createRequest({
      nodeId: 'gpu-box-1',
      displayName: 'GPU Box',
      platform: 'linux',
      endpointUrl: 'http://192.168.1.100:8080',
      capabilities: [{ cap: 'gpu', commands: ['render', 'train'], authLevel: 'leased' }],
    });
    store1.approve(req.requestId);

    // Register the node (simulating callback approve flow)
    const node1 = new RemoteLimbNode({
      nodeId: req.nodeId,
      displayName: req.displayName,
      platform: req.platform,
      capabilities: req.capabilities,
      endpointUrl: req.endpointUrl,
      apiKey: req.apiKey,
    });
    await registry1.register(node1);
    assert.equal(registry1.getNode('gpu-box-1')?.status, 'online');

    // Set custom access policy
    policy1.setPolicy({ catId: 'ragdoll', nodeId: 'gpu-box-1', capability: 'gpu', authLevel: 'free' });

    // Teardown session 1
    p1.close();

    // ── Session 2: reload from SQLite ──
    const p2 = new SqliteLimbPersistence(dbPath);
    p2.initialize();
    const store2 = new LimbPairingStore(p2);
    store2.initialize();
    const policy2 = new LimbAccessPolicy(p2);
    policy2.initialize();
    const registry2 = new LimbRegistry();
    registry2.setDeps({ accessPolicy: policy2 });

    // Verify persisted pairing
    const approved = store2.getApproved();
    assert.equal(approved.length, 1);
    assert.equal(approved[0].nodeId, 'gpu-box-1');

    // Recovery: create offline stubs from approved pairings
    for (const pairing of store2.getApproved()) {
      const stub = new RemoteLimbNode({
        nodeId: pairing.nodeId,
        displayName: pairing.displayName,
        platform: pairing.platform,
        capabilities: pairing.capabilities,
        endpointUrl: pairing.endpointUrl,
        apiKey: pairing.apiKey,
      });
      await registry2.register(stub);
      registry2.updateStatus(pairing.nodeId, 'offline');
    }

    // Verify offline stub
    const record = registry2.getNode('gpu-box-1');
    assert.ok(record);
    assert.equal(record.status, 'offline');
    assert.equal(record.capabilities[0].cap, 'gpu');

    // Verify access policy survived
    assert.equal(policy2.check('ragdoll', 'gpu-box-1', 'gpu'), 'free');

    // Simulate heartbeat → goes online
    registry2.recordHeartbeat('gpu-box-1');
    assert.equal(registry2.getNode('gpu-box-1')?.status, 'online');

    p2.close();
  });
});
