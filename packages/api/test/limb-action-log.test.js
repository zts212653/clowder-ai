import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';

describe('LimbActionLog', () => {
  let log;

  beforeEach(() => {
    log = new LimbActionLog();
  });

  it('start creates pending entry with all provenance fields', () => {
    const requestId = log.start({
      invocationId: 'inv-1',
      leaseId: 'lease-1',
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
      idempotencyKey: 'key-1',
    });

    const entry = log.get(requestId);
    assert.ok(entry);
    assert.equal(entry.status, 'pending');
    assert.equal(entry.invocationId, 'inv-1');
    assert.equal(entry.leaseId, 'lease-1');
    assert.equal(entry.catId, 'opus');
    assert.equal(entry.nodeId, 'iphone-1');
    assert.equal(entry.capability, 'camera');
    assert.equal(entry.command, 'camera.snap');
    assert.equal(entry.idempotencyKey, 'key-1');
    assert.ok(entry.startedAt > 0);
    assert.equal(entry.endedAt, null);
    assert.equal(entry.artifactUri, null);
  });

  it('start without idempotencyKey sets null', () => {
    const requestId = log.start({
      invocationId: 'inv-1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });
    assert.equal(log.get(requestId).idempotencyKey, null);
  });

  it('complete marks entry as completed with artifactUri', () => {
    const requestId = log.start({
      invocationId: 'inv-1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });

    log.complete(requestId, { artifactUri: 'file:///tmp/photo.jpg' });
    const entry = log.get(requestId);
    assert.equal(entry.status, 'completed');
    assert.equal(entry.artifactUri, 'file:///tmp/photo.jpg');
    assert.ok(entry.endedAt > 0);
  });

  it('fail marks entry as failed', () => {
    const requestId = log.start({
      invocationId: 'inv-1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });

    log.fail(requestId);
    const entry = log.get(requestId);
    assert.equal(entry.status, 'failed');
    assert.ok(entry.endedAt > 0);
  });

  it('markRunning transitions to running', () => {
    const requestId = log.start({
      invocationId: 'inv-1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });

    log.markRunning(requestId);
    assert.equal(log.get(requestId).status, 'running');
  });

  it('getByNode returns entries for node', () => {
    log.start({
      invocationId: 'i1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });
    log.start({
      invocationId: 'i2',
      leaseId: null,
      catId: 'opus',
      nodeId: 'server-1',
      capability: 'gpu',
      command: 'render.run',
    });
    log.start({
      invocationId: 'i3',
      leaseId: null,
      catId: 'codex',
      nodeId: 'iphone-1',
      capability: 'location',
      command: 'location.get',
    });

    const phoneEntries = log.getByNode('iphone-1');
    assert.equal(phoneEntries.length, 2);
  });

  it('getByCat returns entries for cat', () => {
    log.start({
      invocationId: 'i1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });
    log.start({
      invocationId: 'i2',
      leaseId: null,
      catId: 'codex',
      nodeId: 'iphone-1',
      capability: 'camera',
      command: 'camera.snap',
    });

    assert.equal(log.getByCat('opus').length, 1);
    assert.equal(log.getByCat('codex').length, 1);
  });

  it('get returns undefined for unknown requestId', () => {
    assert.equal(log.get('nonexistent'), undefined);
  });

  it('evicts oldest when at capacity', () => {
    const smallLog = new LimbActionLog(2);
    const first = smallLog.start({
      invocationId: 'i1',
      leaseId: null,
      catId: 'opus',
      nodeId: 'n1',
      capability: 'c',
      command: 'cmd',
    });
    smallLog.start({ invocationId: 'i2', leaseId: null, catId: 'opus', nodeId: 'n1', capability: 'c', command: 'cmd' });
    smallLog.start({ invocationId: 'i3', leaseId: null, catId: 'opus', nodeId: 'n1', capability: 'c', command: 'cmd' });

    assert.equal(smallLog.size, 2);
    assert.equal(smallLog.get(first), undefined); // first was evicted
  });
});
