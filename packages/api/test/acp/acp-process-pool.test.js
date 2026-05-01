// @ts-check

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

/**
 * F149 Phase C — AcpProcessPool tests.
 *
 * Uses a mock AcpClient factory to avoid spawning real processes.
 * Each mock client tracks: initialize called, newSession, close, isAlive state.
 */

// ── Mock AcpClient factory ────────────────────────────────────

let clientIdCounter = 0;

function createMockClient() {
  const id = ++clientIdCounter;
  let alive = false;
  let closed = false;
  return {
    id,
    get isAlive() {
      return alive && !closed;
    },
    async initialize() {
      alive = true;
      return { agentInfo: { name: 'mock', version: '1.0' } };
    },
    async newSession(cwd) {
      return { sessionId: `sess-${id}-${Date.now()}` };
    },
    cancelSession(_sid) {},
    async close() {
      closed = true;
      alive = false;
    },
    // Test helpers
    _kill() {
      alive = false;
    }, // simulate process death
    _isClosed() {
      return closed;
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────

const defaultPoolConfig = {
  maxLiveProcesses: 3,
  idleTtlMs: 5 * 60 * 1000,
  evictionPolicy: /** @type {const} */ ('lru'),
  healthCheckIntervalMs: 30_000,
};

const defaultVariantConfig = {
  command: 'gemini',
  startupArgs: ['--acp'],
  supportsMultiplexing: true,
};

const key1 = { projectPath: '/tmp/a', providerProfile: 'gemini-default' };
const key2 = { projectPath: '/tmp/b', providerProfile: 'gemini-default' };
const key3 = { projectPath: '/tmp/c', providerProfile: 'gemini-default' };

// ── Tests ─────────────────────────────────────────────────────

describe('AcpProcessPool', () => {
  /** @type {import('../../src/domains/cats/services/agents/providers/acp/AcpProcessPool.js').AcpProcessPool} */
  let pool;

  afterEach(async () => {
    if (pool) await pool.closeAll();
    clientIdCounter = 0;
  });

  describe('acquire / release basics', () => {
    test('acquire returns a lease with a live client', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const lease = await pool.acquire(key1);
      assert.ok(lease.client);
      assert.ok(lease.client.isAlive);
      lease.release();
    });

    test('acquire reuses warm process for second lease (multiplexing)', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const lease1 = await pool.acquire(key1);
      const lease2 = await pool.acquire(key1);
      // Same underlying client — multiplexed
      assert.strictEqual(lease1.client, lease2.client);
      const m = pool.getMetrics();
      assert.strictEqual(m.warmHitCount, 1);
      assert.strictEqual(m.coldStartCount, 1);
      lease1.release();
      lease2.release();
    });

    test('release decrements active lease count', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const lease = await pool.acquire(key1);
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 1);
      lease.release();
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 0);
      assert.strictEqual(pool.getMetrics().idleProcessCount, 1);
    });

    test('different pool keys get different processes', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const lease1 = await pool.acquire(key1);
      const lease2 = await pool.acquire(key2);
      assert.notStrictEqual(lease1.client, lease2.client);
      assert.strictEqual(pool.getMetrics().coldStartCount, 2);
      lease1.release();
      lease2.release();
    });

    test('double release is safe (no-op)', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const lease = await pool.acquire(key1);
      lease.release();
      lease.release(); // should not throw or double-decrement
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 0);
    });
  });

  describe('idle TTL + LRU eviction', () => {
    test('idle process is closed after idleTtlMs', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, idleTtlMs: 50, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease = await pool.acquire(key1);
      lease.release();
      assert.strictEqual(pool.getMetrics().liveProcessCount, 1);

      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(pool.getMetrics().liveProcessCount, 0);
      assert.strictEqual(pool.getMetrics().evictionCount, 1);
    });

    test('active lease prevents idle eviction', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, idleTtlMs: 50, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease = await pool.acquire(key1);
      // Don't release — should not be evicted
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(pool.getMetrics().liveProcessCount, 1);
      assert.strictEqual(pool.getMetrics().evictionCount, 0);
      lease.release();
    });

    test('evicts LRU idle process when maxLiveProcesses reached', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, maxLiveProcesses: 2, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const l1 = await pool.acquire(key1);
      l1.release(); // idle, oldest
      const l2 = await pool.acquire(key2);
      l2.release(); // idle, newer

      assert.strictEqual(pool.getMetrics().liveProcessCount, 2);

      const l3 = await pool.acquire(key3); // should evict key1 (LRU)
      assert.strictEqual(pool.getMetrics().liveProcessCount, 2);
      assert.strictEqual(pool.getMetrics().evictionCount, 1);
      l3.release();
    });

    test('does not evict process with active lease', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, maxLiveProcesses: 2, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const l1 = await pool.acquire(key1); // active — don't release
      const l2 = await pool.acquire(key2);
      l2.release(); // idle

      // key2 (idle) should be evicted, not key1 (active)
      const l3 = await pool.acquire(key3);
      assert.strictEqual(pool.getMetrics().liveProcessCount, 2);
      assert.strictEqual(pool.getMetrics().evictionCount, 1);
      l1.release();
      l3.release();
    });
  });

  describe('health check + zombie cleanup', () => {
    test('dead process detected and removed by health check', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, healthCheckIntervalMs: 30, idleTtlMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease = await pool.acquire(key1);
      const client = lease.client;
      lease.release();

      // Simulate process death
      client._kill();

      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(pool.getMetrics().liveProcessCount, 0);
      assert.strictEqual(pool.getMetrics().zombieCleanupCount, 1);
    });

    test('acquire after zombie gives fresh process', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, healthCheckIntervalMs: 30, idleTtlMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease1 = await pool.acquire(key1);
      const deadClient = lease1.client;
      lease1.release();
      deadClient._kill();

      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(pool.getMetrics().liveProcessCount, 0);

      const lease2 = await pool.acquire(key1);
      assert.ok(lease2.client.isAlive);
      assert.notStrictEqual(lease2.client, deadClient);
      assert.strictEqual(pool.getMetrics().coldStartCount, 2);
      lease2.release();
    });
  });

  describe('metrics', () => {
    test('getMetrics reflects current pool state through lifecycle', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);

      let m = pool.getMetrics();
      assert.strictEqual(m.liveProcessCount, 0);
      assert.strictEqual(m.activeLeaseCount, 0);

      const l1 = await pool.acquire(key1);
      m = pool.getMetrics();
      assert.strictEqual(m.liveProcessCount, 1);
      assert.strictEqual(m.activeLeaseCount, 1);
      assert.strictEqual(m.coldStartCount, 1);

      const l2 = await pool.acquire(key1); // multiplexed
      m = pool.getMetrics();
      assert.strictEqual(m.activeLeaseCount, 2);
      assert.strictEqual(m.warmHitCount, 1);

      l1.release();
      l2.release();
      m = pool.getMetrics();
      assert.strictEqual(m.activeLeaseCount, 0);
      assert.strictEqual(m.idleProcessCount, 1);
    });
  });

  describe('capacity enforcement (P1 fixes)', () => {
    test('acquire rejects when at capacity with all leases active', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, maxLiveProcesses: 1, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease = await pool.acquire(key1); // fills the single slot
      // key2 should be rejected — no idle process to evict
      await assert.rejects(() => pool.acquire(key2), /capacity/i);
      assert.strictEqual(pool.getMetrics().liveProcessCount, 1);
      lease.release();
    });

    test('concurrent acquire for same key coalesces into single cold start', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, maxLiveProcesses: 1, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const [l1, l2] = await Promise.all([pool.acquire(key1), pool.acquire(key1)]);
      const m = pool.getMetrics();
      assert.strictEqual(m.liveProcessCount, 1, 'should only have 1 process');
      assert.strictEqual(m.coldStartCount, 1, 'should only cold start once');
      assert.strictEqual(l1.client, l2.client, 'should share same client');
      l1.release();
      l2.release();
    });

    test('concurrent acquire for different keys respects maxLiveProcesses', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, maxLiveProcesses: 1, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      // One should succeed, one should fail
      const results = await Promise.allSettled([pool.acquire(key1), pool.acquire(key2)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.strictEqual(fulfilled.length, 1, 'exactly one should succeed');
      assert.strictEqual(rejected.length, 1, 'exactly one should be rejected');
      assert.strictEqual(pool.getMetrics().liveProcessCount, 1);
      fulfilled[0].value.release();
    });
  });

  describe('closeAll', () => {
    test('closeAll shuts down all processes', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const l1 = await pool.acquire(key1);
      const l2 = await pool.acquire(key2);
      l1.release();
      l2.release();
      assert.strictEqual(pool.getMetrics().liveProcessCount, 2);

      await pool.closeAll();
      assert.strictEqual(pool.getMetrics().liveProcessCount, 0);
    });
  });

  describe('initialize failure cleanup', () => {
    test('child process is closed when initialize throws', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      const spawnedClients = [];
      const failingFactory = () => {
        const client = createMockClient();
        spawnedClients.push(client);
        const origInit = client.initialize.bind(client);
        client.initialize = async () => {
          await origInit();
          throw new Error('ACP timeout: initialize did not respond within 60000ms');
        };
        return client;
      };

      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, failingFactory);
      await assert.rejects(() => pool.acquire(key1), /initialize did not respond/);

      assert.strictEqual(spawnedClients.length, 1);
      assert.strictEqual(spawnedClients[0]._isClosed(), true, 'leaked client must be closed');
      assert.strictEqual(pool.getMetrics().liveProcessCount, 0);
    });
  });
});
