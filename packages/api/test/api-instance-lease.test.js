import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class FakeRedis {
  constructor() {
    this.store = new Map();
    this.expiries = new Map();
    this.failRenewalsRemaining = 0;
    this.failSetNxRemaining = 0;
  }

  _cleanup(key) {
    const expiresAt = this.expiries.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.store.delete(key);
      this.expiries.delete(key);
    }
  }

  async set(key, value, ...args) {
    this._cleanup(key);

    let nx = false;
    let ttlMs = null;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === 'NX') nx = true;
      if (arg === 'PX') ttlMs = Number(args[i + 1]);
    }

    if (nx && this.failSetNxRemaining > 0) {
      this.failSetNxRemaining -= 1;
      return null;
    }

    if (nx && this.store.has(key)) return null;

    this.store.set(key, value);
    if (ttlMs !== null) {
      this.expiries.set(key, Date.now() + ttlMs);
    } else {
      this.expiries.delete(key);
    }
    return 'OK';
  }

  async get(key) {
    this._cleanup(key);
    return this.store.get(key) ?? null;
  }

  async del(key) {
    this._cleanup(key);
    const existed = this.store.delete(key);
    this.expiries.delete(key);
    return existed ? 1 : 0;
  }

  async pttl(key) {
    this._cleanup(key);
    if (!this.store.has(key)) return -2;
    const expiresAt = this.expiries.get(key);
    if (expiresAt === undefined) return -1;
    return Math.max(0, expiresAt - Date.now());
  }

  async eval(script, _numKeys, key, ...args) {
    this._cleanup(key);

    if (script.includes('PEXPIRE')) {
      if (this.failRenewalsRemaining > 0) {
        this.failRenewalsRemaining -= 1;
        throw new Error('simulated renew failure');
      }
      const [expectedValue, ttlMs] = args;
      if (this.store.get(key) !== expectedValue) return 0;
      this.expiries.set(key, Date.now() + Number(ttlMs));
      return 1;
    }

    if (script.includes("redis.call('DEL'")) {
      const [expectedValue] = args;
      if (this.store.get(key) !== expectedValue) return 0;
      this.store.delete(key);
      this.expiries.delete(key);
      return 1;
    }

    if (script.includes("redis.call('SET'")) {
      const [expectedValue, nextValue, ttlMs] = args;
      if (this.store.get(key) !== expectedValue) return 0;
      this.store.set(key, nextValue);
      this.expiries.set(key, Date.now() + Number(ttlMs));
      return 1;
    }

    throw new Error(`Unsupported eval script: ${script}`);
  }

  failNextRenewals(count) {
    this.failRenewalsRemaining = count;
  }

  failNextSetNx(count) {
    this.failSetNxRemaining = count;
  }
}

let ApiInstanceLease;
let API_INSTANCE_LEASE_KEY;
try {
  const mod = await import('../dist/services/ApiInstanceLease.js');
  ApiInstanceLease = mod.ApiInstanceLease;
  API_INSTANCE_LEASE_KEY = mod.API_INSTANCE_LEASE_KEY;
} catch {
  // RED phase: module does not exist yet.
}

describe('ApiInstanceLease', () => {
  test('module can be imported', () => {
    assert.ok(ApiInstanceLease, 'ApiInstanceLease should be importable');
    assert.ok(API_INSTANCE_LEASE_KEY, 'API_INSTANCE_LEASE_KEY should be exported');
  });

  test('rejects a second live API instance on the same Redis namespace', async () => {
    const redis = new FakeRedis();
    const livePids = new Set([1111, 2222]);

    const lease1 = new ApiInstanceLease(redis, {
      instanceId: 'runtime-a',
      pid: 1111,
      hostname: 'same-host',
      apiPort: 3002,
      cwd: '/runtime-a',
      ttlMs: 100,
      heartbeatMs: 20,
      isPidAlive: (pid) => livePids.has(pid),
    });
    const first = await lease1.acquire();
    assert.equal(first.acquired, true);

    const lease2 = new ApiInstanceLease(redis, {
      instanceId: 'runtime-b',
      pid: 2222,
      hostname: 'same-host',
      apiPort: 3012,
      cwd: '/runtime-b',
      ttlMs: 100,
      heartbeatMs: 20,
      isPidAlive: (pid) => livePids.has(pid),
    });
    const second = await lease2.acquire();

    assert.equal(second.acquired, false);
    assert.equal(second.holder?.instanceId, 'runtime-a');
    assert.equal(second.holder?.apiPort, 3002);

    await lease1.release();
    await lease2.release();
  });

  test('steals a stale same-host lease when the recorded pid is dead', async () => {
    const redis = new FakeRedis();
    const staleHolder = {
      version: 1,
      token: 'stale-token',
      instanceId: 'dead-runtime',
      pid: 9999,
      hostname: 'same-host',
      apiPort: 3002,
      cwd: '/dead-runtime',
      startedAt: Date.now() - 60_000,
      acquiredAt: Date.now() - 60_000,
    };
    await redis.set(API_INSTANCE_LEASE_KEY, JSON.stringify(staleHolder), 'PX', 5_000);

    const lease = new ApiInstanceLease(redis, {
      instanceId: 'new-runtime',
      pid: 1234,
      hostname: 'same-host',
      apiPort: 3012,
      cwd: '/new-runtime',
      ttlMs: 100,
      heartbeatMs: 20,
      isPidAlive: (pid) => pid !== 9999,
    });
    const acquired = await lease.acquire();

    assert.equal(acquired.acquired, true);
    const holder = JSON.parse(await redis.get(API_INSTANCE_LEASE_KEY));
    assert.equal(holder.instanceId, 'new-runtime');
    assert.equal(holder.pid, 1234);

    await lease.release();
  });

  test('heartbeats keep the lease alive until explicit release', async () => {
    const redis = new FakeRedis();
    const lease = new ApiInstanceLease(redis, {
      instanceId: 'runtime-a',
      pid: 1111,
      hostname: 'same-host',
      apiPort: 3002,
      cwd: '/runtime-a',
      ttlMs: 30,
      heartbeatMs: 5,
      isPidAlive: () => true,
    });

    const acquired = await lease.acquire();
    assert.equal(acquired.acquired, true);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok((await redis.pttl(API_INSTANCE_LEASE_KEY)) > 0, 'heartbeat should keep lease TTL above zero');

    await lease.release();
    assert.equal(await redis.get(API_INSTANCE_LEASE_KEY), null);
  });

  test('fails fast when heartbeat renewals start throwing', async () => {
    const redis = new FakeRedis();
    let primaryAlive = true;
    const invalidations = [];
    const livePids = new Set([2222]);

    const lease1 = new ApiInstanceLease(redis, {
      instanceId: 'runtime-a',
      pid: 1111,
      hostname: 'same-host',
      apiPort: 3002,
      cwd: '/runtime-a',
      ttlMs: 30,
      heartbeatMs: 5,
      isPidAlive: (pid) => (pid === 1111 ? primaryAlive : livePids.has(pid)),
      onLeaseInvalidated: (event) => {
        invalidations.push(event);
        primaryAlive = false;
      },
    });

    const first = await lease1.acquire();
    assert.equal(first.acquired, true);

    redis.failNextRenewals(20);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0].reason, 'renew_failed');
    assert.equal(primaryAlive, false);

    const lease2 = new ApiInstanceLease(redis, {
      instanceId: 'runtime-b',
      pid: 2222,
      hostname: 'same-host',
      apiPort: 3012,
      cwd: '/runtime-b',
      ttlMs: 30,
      heartbeatMs: 5,
      isPidAlive: (pid) => (pid === 1111 ? primaryAlive : livePids.has(pid)),
    });
    const second = await lease2.acquire();

    assert.equal(second.acquired, true);

    await lease1.release();
    await lease2.release();
  });

  test('retry acquisition path preserves lease invalidation callback', async () => {
    const redis = new FakeRedis();
    redis.failNextSetNx(1);

    const invalidations = [];
    const lease = new ApiInstanceLease(redis, {
      instanceId: 'runtime-a',
      pid: 1111,
      hostname: 'same-host',
      apiPort: 3002,
      cwd: '/runtime-a',
      ttlMs: 30,
      heartbeatMs: 5,
      isPidAlive: () => true,
      onLeaseInvalidated: (event) => {
        invalidations.push(event);
      },
    });

    const acquired = await lease.acquire();
    assert.equal(acquired.acquired, true);

    redis.failNextRenewals(20);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0].reason, 'renew_failed');

    await lease.release();
  });

  test('release is ownership-safe and does not delete another holder lease', async () => {
    const redis = new FakeRedis();
    const lease = new ApiInstanceLease(redis, {
      instanceId: 'runtime-a',
      pid: 1111,
      hostname: 'same-host',
      apiPort: 3002,
      cwd: '/runtime-a',
      ttlMs: 100,
      heartbeatMs: 20,
      isPidAlive: () => true,
    });
    const acquired = await lease.acquire();
    assert.equal(acquired.acquired, true);

    const otherHolder = {
      version: 1,
      token: 'other-token',
      instanceId: 'runtime-b',
      pid: 2222,
      hostname: 'same-host',
      apiPort: 3012,
      cwd: '/runtime-b',
      startedAt: Date.now(),
      acquiredAt: Date.now(),
    };
    await redis.set(API_INSTANCE_LEASE_KEY, JSON.stringify(otherHolder), 'PX', 100);

    await lease.release();

    const holder = JSON.parse(await redis.get(API_INSTANCE_LEASE_KEY));
    assert.equal(holder.instanceId, 'runtime-b');
  });
});
