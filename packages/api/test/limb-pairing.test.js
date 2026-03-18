import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
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

  it('approve changes status and returns request', () => {
    const req = store.createRequest(PARAMS);
    const approved = store.approve(req.requestId);
    assert.ok(approved);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.decidedAt > 0);
  });

  it('approve on already-approved is idempotent', () => {
    const req = store.createRequest(PARAMS);
    store.approve(req.requestId);
    const again = store.approve(req.requestId);
    assert.equal(again.status, 'approved');
  });

  it('approve returns null for unknown requestId', () => {
    assert.equal(store.approve('nonexistent'), null);
  });

  it('reject changes status', () => {
    const req = store.createRequest(PARAMS);
    assert.equal(store.reject(req.requestId), true);
    assert.equal(store.get(req.requestId).status, 'rejected');
  });

  it('reject returns false for unknown', () => {
    assert.equal(store.reject('nonexistent'), false);
  });

  it('getPending returns only pending requests', () => {
    store.createRequest(PARAMS);
    store.createRequest({ ...PARAMS, nodeId: 'watch-1' });
    const req3 = store.createRequest({ ...PARAMS, nodeId: 'server-1' });
    store.approve(req3.requestId);

    const pending = store.getPending();
    assert.equal(pending.length, 2);
  });

  it('getApproved returns only approved requests', () => {
    const req = store.createRequest(PARAMS);
    assert.equal(store.getApproved().length, 0);
    store.approve(req.requestId);
    assert.equal(store.getApproved().length, 1);
  });

  it('findByApiKey returns approved request', () => {
    const req = store.createRequest(PARAMS);
    store.approve(req.requestId);
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
});
