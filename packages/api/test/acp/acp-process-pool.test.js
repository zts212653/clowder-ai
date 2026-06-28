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
  idleTtlMs: 30 * 60 * 1000,
  evictionPolicy: /** @type {const} */ ('lru'),
  healthCheckIntervalMs: 30_000,
};

const defaultVariantConfig = {
  command: 'gemini',
  startupArgs: ['--acp'],
  supportsMultiplexing: true,
};

const nonMultiplexedVariantConfig = {
  command: 'single-flight-agent',
  startupArgs: ['--acp'],
  supportsMultiplexing: false,
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

  describe('defaults', () => {
    test('uses 30 minutes as the default idle TTL', async () => {
      const { AcpProcessPool, DEFAULT_ACP_IDLE_TTL_MS } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { maxLiveProcesses: 3, healthCheckIntervalMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      assert.equal(DEFAULT_ACP_IDLE_TTL_MS, 30 * 60 * 1000);
      assert.equal(pool.config.idleTtlMs, DEFAULT_ACP_IDLE_TTL_MS);
    });

    test('exposes the typed spawn signature used for registry staleness checks', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient, 'spawn:v1');
      assert.equal(pool.spawnSignature, 'spawn:v1');
      assert.equal(Object.hasOwn(pool, '_spawnSignature'), false);
    });
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

    test('non-multiplexed carriers do not share an active warm process for the same key', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, nonMultiplexedVariantConfig, createMockClient);

      const lease1 = await pool.acquire(key1);
      const lease2 = await pool.acquire(key1);

      assert.notStrictEqual(lease1.client, lease2.client);
      assert.strictEqual(pool.getMetrics().liveProcessCount, 2);
      assert.strictEqual(pool.getMetrics().coldStartCount, 2);

      lease1.release();
      lease2.release();
    });

    test('non-multiplexed carriers still reuse idle processes for later turns', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, nonMultiplexedVariantConfig, createMockClient);

      const lease1 = await pool.acquire(key1);
      const client = lease1.client;
      lease1.release();

      const lease2 = await pool.acquire(key1);
      assert.strictEqual(lease2.client, client);
      assert.strictEqual(pool.getMetrics().liveProcessCount, 1);
      lease2.release();
    });

    test('session affinity leases the client that owns a resumed session', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, nonMultiplexedVariantConfig, createMockClient);

      const lease1 = await pool.acquire(key1);
      const firstClient = lease1.client;
      const lease2 = await pool.acquire(key1);
      const secondClient = lease2.client;
      pool.rememberSession(key1, 'sess-on-second-client', lease2);

      lease1.release();
      lease2.release();

      const resumeLease = await pool.acquire(key1, { sessionId: 'sess-on-second-client' });
      assert.strictEqual(
        resumeLease.client,
        secondClient,
        'resume must lease the remembered session owner, not the first idle warm client',
      );
      assert.notStrictEqual(resumeLease.client, firstClient);
      resumeLease.release();
    });

    test('stale lease on session-owned entry is force-released on re-acquire (#992)', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, nonMultiplexedVariantConfig, createMockClient);

      // Simulate: first acquire + rememberSession, but lease never released (zombie)
      const lease1 = await pool.acquire(key1);
      const ownerClient = lease1.client;
      pool.rememberSession(key1, 'stale-sess', lease1);
      // Do NOT release lease1 — simulates Windows console disconnect where finally never runs

      assert.strictEqual(pool.getMetrics().activeLeaseCount, 1);

      // Second acquire with same sessionId should recover, not throw
      const lease2 = await pool.acquire(key1, { sessionId: 'stale-sess' });
      assert.strictEqual(lease2.client, ownerClient, 'should reuse the same process');
      assert.ok(lease2.client.isAlive);

      // The stale lease was force-released, and a new lease was granted
      // activeLeaseCount should be 1 (the new lease), not 2
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 1);

      lease2.release();
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 0);
    });

    test('late release of stale lease does not corrupt new lease (#992 P1)', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, idleTtlMs: 20, healthCheckIntervalMs: 999_999 },
        nonMultiplexedVariantConfig,
        createMockClient,
      );

      // Step 1: acquire lease1, remember session, don't release (zombie)
      const lease1 = await pool.acquire(key1);
      const ownerClient = lease1.client;
      pool.rememberSession(key1, 'late-sess', lease1);

      // Step 2: re-acquire same session → force-release recovery
      const lease2 = await pool.acquire(key1, { sessionId: 'late-sess' });
      assert.strictEqual(lease2.client, ownerClient);
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 1);

      // Step 3: old lease1.release() arrives late (async generator finally fires)
      lease1.release();

      // Invariants that must hold after late release:
      // - new lease2 is still active (not corrupted)
      assert.ok(lease2.client.isAlive, 'new lease client must still be alive');
      // - activeLeaseCount must not go negative
      assert.ok(pool.getMetrics().activeLeaseCount >= 0, 'activeLeaseCount must not go negative');
      // - activeLeaseCount should still be 1 (lease2 is active, lease1's release was stale)
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 1, 'late stale release must be no-op');
      // - idleProcessCount must not go negative
      assert.ok(pool.getMetrics().idleProcessCount >= 0, 'idleProcessCount must not go negative');

      // Step 4: wait past idle TTL — process must NOT be evicted while lease2 is active
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(lease2.client.isAlive, 'lease2 client must survive idle TTL');
      assert.strictEqual(pool.getMetrics().liveProcessCount, 1);

      // Step 5: normal release of lease2 should work correctly
      lease2.release();
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 0);
      assert.strictEqual(pool.getMetrics().idleProcessCount, 1);
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

    test('concurrent acquire for non-multiplexed same key starts separate processes', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, maxLiveProcesses: 2, healthCheckIntervalMs: 999_999 },
        nonMultiplexedVariantConfig,
        createMockClient,
      );

      const [l1, l2] = await Promise.all([pool.acquire(key1), pool.acquire(key1)]);

      assert.notStrictEqual(l1.client, l2.client);
      assert.strictEqual(pool.getMetrics().liveProcessCount, 2);
      assert.strictEqual(pool.getMetrics().coldStartCount, 2);

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
