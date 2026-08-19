import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryApprovedLimbPairingPersistence } from '../dist/domains/limb/ApprovedLimbPairingPersistence.js';
import { LimbPairingStore } from '../dist/domains/limb/LimbPairingStore.js';

const PARAMS = {
  nodeId: 'iphone-1',
  displayName: 'iPhone 15 Pro',
  platform: 'ios',
  endpointUrl: 'http://192.168.1.50:9090',
  capabilities: [{ cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' }],
};

describe('LimbPairingStore', () => {
  let store;

  beforeEach(() => {
    store = new LimbPairingStore();
  });

  it('createRequest creates pending request with generated apiKey', () => {
    const req = store.createRequest(PARAMS);
    assert.equal(req.status, 'pending');
    assert.equal(req.nodeId, 'iphone-1');
    assert.ok(req.requestId);
    assert.ok(req.apiKey);
    assert.ok(req.createdAt > 0);
  });

  it('createRequest is idempotent for same nodeId', () => {
    const first = store.createRequest(PARAMS);
    const second = store.createRequest(PARAMS);
    assert.equal(first.requestId, second.requestId);
  });

  it('approve changes status and returns request', async () => {
    const req = store.createRequest(PARAMS);
    const approved = await store.approve(req.requestId, 'user-1');
    assert.ok(approved);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedByUserId, 'user-1');
    assert.ok(approved.decidedAt > 0);
  });

  it('approve on already-approved is idempotent', async () => {
    const req = store.createRequest(PARAMS);
    await store.approve(req.requestId, 'user-1');
    const again = await store.approve(req.requestId, 'user-1');
    assert.equal(again.status, 'approved');
  });

  it('approve refuses to transfer an approved device to another user', async () => {
    const req = store.createRequest(PARAMS);
    await store.approve(req.requestId, 'user-1');
    await assert.rejects(() => store.approve(req.requestId, 'user-2'), /different user/i);
  });

  it('approve returns null for unknown requestId', async () => {
    assert.equal(await store.approve('nonexistent', 'user-1'), null);
  });

  it('reject changes status', () => {
    const req = store.createRequest(PARAMS);
    assert.equal(store.reject(req.requestId), true);
    assert.equal(store.get(req.requestId).status, 'rejected');
  });

  it('reject returns false for unknown', () => {
    assert.equal(store.reject('nonexistent'), false);
  });

  it('getPending returns only pending requests', async () => {
    store.createRequest(PARAMS);
    store.createRequest({ ...PARAMS, nodeId: 'watch-1' });
    const req3 = store.createRequest({ ...PARAMS, nodeId: 'server-1' });
    await store.approve(req3.requestId, 'user-1');

    const pending = store.getPending();
    assert.equal(pending.length, 2);
  });

  it('getApproved returns only approved requests', async () => {
    const req = store.createRequest(PARAMS);
    assert.equal(store.getApproved().length, 0);
    await store.approve(req.requestId, 'user-1');
    assert.equal(store.getApproved().length, 1);
  });

  it('findByApiKey returns approved request', async () => {
    const req = store.createRequest(PARAMS);
    await store.approve(req.requestId, 'user-1');
    const found = store.findByApiKey(req.apiKey);
    assert.ok(found);
    assert.equal(found.nodeId, 'iphone-1');
  });

  it('findByApiKey returns undefined for pending request', () => {
    const req = store.createRequest(PARAMS);
    // Not approved yet
    assert.equal(store.findByApiKey(req.apiKey), undefined);
  });

  it('rejected nodeId can be re-registered', () => {
    const req = store.createRequest(PARAMS);
    store.reject(req.requestId);
    const req2 = store.createRequest(PARAMS);
    assert.notEqual(req.requestId, req2.requestId); // New request
    assert.equal(req2.status, 'pending');
  });

  it('reject cannot invalidate an approved pairing', async () => {
    const req = store.createRequest(PARAMS);
    await store.approve(req.requestId, 'user-1');

    assert.equal(store.reject(req.requestId), false);
    assert.equal(store.get(req.requestId).status, 'approved');
  });

  it('restores an approved pairing and its owner in a fresh service instance', async () => {
    const persistence = new MemoryApprovedLimbPairingPersistence();
    const first = await LimbPairingStore.restore(persistence);
    const pending = first.createRequest(PARAMS);
    await first.approve(pending.requestId, 'user-1');

    const restarted = await LimbPairingStore.restore(persistence);
    const approved = restarted.findApprovedByNodeId(PARAMS.nodeId);

    assert.ok(approved);
    assert.equal(approved.requestId, pending.requestId);
    assert.equal(approved.apiKey, pending.apiKey);
    assert.equal(approved.approvedByUserId, 'user-1');
    assert.equal(restarted.getPending().length, 0);
  });

  it('does not publish approval in memory when durable commit fails', async () => {
    const persistence = {
      list: async () => [],
      put: async () => {
        throw new Error('redis unavailable');
      },
      remove: async () => {},
    };
    const persistentStore = await LimbPairingStore.restore(persistence);
    const pending = persistentStore.createRequest(PARAMS);

    await assert.rejects(() => persistentStore.approve(pending.requestId, 'user-1'), /redis unavailable/);
    assert.equal(persistentStore.get(pending.requestId).status, 'pending');
    assert.equal(persistentStore.findApprovedByNodeId(PARAMS.nodeId), undefined);
  });

  it('serializes competing approvals so ownership cannot race-transfer', async () => {
    const persistence = new MemoryApprovedLimbPairingPersistence();
    const persistentStore = await LimbPairingStore.restore(persistence);
    const pending = persistentStore.createRequest(PARAMS);

    const [first, second] = await Promise.allSettled([
      persistentStore.approve(pending.requestId, 'user-1'),
      persistentStore.approve(pending.requestId, 'user-2'),
    ]);

    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.equal(persistentStore.findApprovedByNodeId(PARAMS.nodeId).approvedByUserId, 'user-1');
  });

  it('fails startup closed for malformed durable approval state', async () => {
    const persistence = {
      list: async () => [{ ...PARAMS, requestId: 'req-1', apiKey: 'secret', status: 'approved' }],
      put: async () => {},
      remove: async () => {},
    };

    await assert.rejects(() => LimbPairingStore.restore(persistence), /invalid approved limb pairing/i);
  });
});
