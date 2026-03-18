import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';

describe('LimbLeaseManager', () => {
  let manager;

  beforeEach(() => {
    manager = new LimbLeaseManager({ defaultTtlMs: 100 }); // 100ms for fast tests
  });

  it('acquire returns lease for unleased capability', () => {
    const lease = manager.acquire('opus', 'iphone-1', 'camera');
    assert.ok(lease);
    assert.equal(lease.catId, 'opus');
    assert.equal(lease.nodeId, 'iphone-1');
    assert.equal(lease.capability, 'camera');
    assert.equal(lease.renewCount, 0);
    assert.ok(lease.leaseId);
  });

  it('acquire returns null when already leased by another cat', () => {
    manager.acquire('opus', 'iphone-1', 'camera');
    const lease = manager.acquire('codex', 'iphone-1', 'camera');
    assert.equal(lease, null);
  });

  it('acquire succeeds when leased by same cat (idempotent)', () => {
    const first = manager.acquire('opus', 'iphone-1', 'camera');
    const second = manager.acquire('opus', 'iphone-1', 'camera');
    assert.equal(first.leaseId, second.leaseId);
  });

  it('acquire succeeds after lease expires', async () => {
    manager.acquire('opus', 'iphone-1', 'camera');
    await new Promise((r) => setTimeout(r, 120)); // wait for expiry
    const lease = manager.acquire('codex', 'iphone-1', 'camera');
    assert.ok(lease);
    assert.equal(lease.catId, 'codex');
  });

  it('release frees the lease', () => {
    const lease = manager.acquire('opus', 'iphone-1', 'camera');
    manager.release(lease.leaseId);
    assert.equal(manager.size, 0);

    const newLease = manager.acquire('codex', 'iphone-1', 'camera');
    assert.ok(newLease);
    assert.equal(newLease.catId, 'codex');
  });

  it('renew extends expiry', () => {
    const lease = manager.acquire('opus', 'iphone-1', 'camera');
    const originalExpiry = lease.expiresAt;

    const renewed = manager.renew(lease.leaseId);
    assert.equal(renewed, true);
    assert.ok(lease.expiresAt >= originalExpiry);
    assert.equal(lease.renewCount, 1);
  });

  it('renew returns false for unknown lease', () => {
    assert.equal(manager.renew('nonexistent'), false);
  });

  it('expireAll removes stale leases', async () => {
    manager.acquire('opus', 'iphone-1', 'camera');
    manager.acquire('codex', 'iphone-1', 'location');
    assert.equal(manager.size, 2);

    await new Promise((r) => setTimeout(r, 120));
    const expired = manager.expireAll();
    assert.equal(expired.length, 2);
    assert.equal(manager.size, 0);
  });

  it('releaseAllByCat clears all leases for a cat', () => {
    manager.acquire('opus', 'iphone-1', 'camera');
    manager.acquire('opus', 'server-1', 'gpu_render');
    manager.acquire('codex', 'iphone-1', 'location');
    assert.equal(manager.size, 3);

    const released = manager.releaseAllByCat('opus');
    assert.equal(released.length, 2);
    assert.equal(manager.size, 1); // codex's lease remains
  });

  it('isLeased returns active lease', () => {
    const lease = manager.acquire('opus', 'iphone-1', 'camera');
    const found = manager.isLeased('iphone-1', 'camera');
    assert.ok(found);
    assert.equal(found.leaseId, lease.leaseId);
  });

  it('isLeased returns null for unleased', () => {
    assert.equal(manager.isLeased('iphone-1', 'camera'), null);
  });

  it('isLeased returns null for expired lease', async () => {
    manager.acquire('opus', 'iphone-1', 'camera');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(manager.isLeased('iphone-1', 'camera'), null);
  });

  it('different capabilities on same node have independent leases', () => {
    const cam = manager.acquire('opus', 'iphone-1', 'camera');
    const loc = manager.acquire('codex', 'iphone-1', 'location');
    assert.ok(cam);
    assert.ok(loc);
    assert.notEqual(cam.leaseId, loc.leaseId);
  });
});
