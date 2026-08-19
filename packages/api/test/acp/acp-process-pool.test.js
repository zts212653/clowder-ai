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

/** @param {Promise<void>} [initializeGate] */
function createMockClient(initializeGate) {
  const id = ++clientIdCounter;
  let alive = false;
  let closed = false;
  let cwdIntact = true;
  const unsafeSessionIds = new Set();
  return {
    id,
    get isAlive() {
      return alive && !closed;
    },
    get isCwdIntact() {
      return cwdIntact;
    },
    get isSafeForSingleFlightReuse() {
      return unsafeSessionIds.size === 0;
    },
    isSessionSafeForReuse(sessionId) {
      return !unsafeSessionIds.has('*') && !unsafeSessionIds.has(sessionId);
    },
    async initialize() {
      if (initializeGate) await initializeGate;
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
    _markUnsafeForSingleFlightReuse(sessionId = '*') {
      unsafeSessionIds.add(sessionId);
    },
    _deleteCwd() {
      cwdIntact = false;
    }, // #1203: simulate external deletion of the bootstrap cwd
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

    test('non-multiplexed carrier is retired after a cancelled prompt may still be running', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, nonMultiplexedVariantConfig, createMockClient);

      const lease1 = await pool.acquire(key1);
      const unsafeClient = lease1.client;
      unsafeClient._markUnsafeForSingleFlightReuse();
      lease1.release();

      assert.equal(unsafeClient._isClosed(), true, 'unsafe single-flight client must be closed');
      assert.deepEqual(pool.getMetrics(), {
        liveProcessCount: 0,
        activeLeaseCount: 0,
        idleProcessCount: 0,
        warmHitCount: 0,
        coldStartCount: 1,
        evictionCount: 1,
        zombieCleanupCount: 0,
      });

      const lease2 = await pool.acquire(key1);
      assert.notStrictEqual(lease2.client, unsafeClient, 'next acquire must cold-start a fresh client');
      lease2.release();
    });

    test('multiplexed carrier keeps unrelated session affinity after another session is cancelled', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);

      const cancelledLease = await pool.acquire(key1);
      const sharedClient = cancelledLease.client;
      pool.rememberSession(key1, 'cancelled-sess', cancelledLease);
      const unrelatedLease = await pool.acquire(key1);
      pool.rememberSession(key1, 'unrelated-sess', unrelatedLease);
      sharedClient._markUnsafeForSingleFlightReuse('cancelled-sess');
      cancelledLease.release();
      unrelatedLease.release();

      assert.equal(sharedClient._isClosed(), false, 'one cancelled session must not close a multiplexed carrier');
      const resumedUnrelated = await pool.acquire(key1, { sessionId: 'unrelated-sess' });
      assert.strictEqual(
        resumedUnrelated.client,
        sharedClient,
        'multiplexed carrier remains available to unrelated sessions',
      );
      assert.notEqual(resumedUnrelated.canResumeRequestedSession, false);
      resumedUnrelated.release();
    });

    test('multiplexed carrier seals an unquiesced cancelled session instead of resuming it', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);

      const cancelledLease = await pool.acquire(key1);
      const sharedClient = cancelledLease.client;
      pool.rememberSession(key1, 'cancelled-sess', cancelledLease);
      sharedClient._markUnsafeForSingleFlightReuse('cancelled-sess');
      cancelledLease.release();

      const replacementLease = await pool.acquire(key1, { sessionId: 'cancelled-sess' });
      assert.equal(
        replacementLease.canResumeRequestedSession,
        false,
        'same logical session must be remapped instead of resumed while its prior prompt is unresolved',
      );
      assert.strictEqual(
        replacementLease.client,
        sharedClient,
        'the multiplexed carrier may host the replacement as a distinct fresh session',
      );
      assert.equal(sharedClient._isClosed(), false);
      replacementLease.release();
    });

    test('unsafe session owner is retired instead of stale-lease force reuse', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, nonMultiplexedVariantConfig, createMockClient);

      const lease1 = await pool.acquire(key1);
      const unsafeClient = lease1.client;
      pool.rememberSession(key1, 'cancelled-sess', lease1);
      unsafeClient._markUnsafeForSingleFlightReuse();

      const lease2 = await pool.acquire(key1, { sessionId: 'cancelled-sess' });
      assert.notStrictEqual(lease2.client, unsafeClient, 'resume must not reuse an unquiesced session owner');
      assert.equal(
        lease2.canResumeRequestedSession,
        false,
        'replacement process must create a fresh session rather than load the still-running logical session',
      );
      assert.equal(unsafeClient._isClosed(), true);
      assert.equal(pool.getMetrics().activeLeaseCount, 1, 'only replacement lease should remain active');

      // The retired lease was generation-invalidated; its late release is a no-op.
      lease1.release();
      assert.equal(pool.getMetrics().activeLeaseCount, 1);
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

  describe('bootstrap cwd loss (#1203)', () => {
    test('warm process whose bootstrap cwd was deleted is retired and cold-started on acquire', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, healthCheckIntervalMs: 999_999, idleTtlMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease1 = await pool.acquire(key1);
      const staleClient = lease1.client;
      lease1.release();

      // External cleaner (e.g. a stray test) deletes the shared bootstrap root —
      // the child process is alive but its cwd is gone, so any prompt dies with
      // getcwd ENOENT. The pool must not hand this process out again.
      staleClient._deleteCwd();

      const lease2 = await pool.acquire(key1);
      assert.notStrictEqual(lease2.client, staleClient, 'must cold-start instead of reusing cwd-less process');
      assert.ok(lease2.client.isAlive);
      assert.ok(staleClient._isClosed(), 'retired process must be closed');
      const m = pool.getMetrics();
      assert.strictEqual(m.coldStartCount, 2);
      assert.strictEqual(m.liveProcessCount, 1);
      lease2.release();
    });

    test('session owner whose bootstrap cwd was deleted is retired — re-acquire cold-starts', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(
        { ...defaultPoolConfig, healthCheckIntervalMs: 999_999, idleTtlMs: 999_999 },
        defaultVariantConfig,
        createMockClient,
      );
      const lease1 = await pool.acquire(key1);
      const staleClient = lease1.client;
      pool.rememberSession(key1, 'sess-cwd-lost', lease1);
      lease1.release();

      staleClient._deleteCwd();

      const lease2 = await pool.acquire(key1, { sessionId: 'sess-cwd-lost' });
      assert.notStrictEqual(lease2.client, staleClient, 'must not resume on a cwd-less owner');
      assert.ok(staleClient._isClosed(), 'retired owner must be closed');
      assert.strictEqual(pool.getMetrics().coldStartCount, 2);
      lease2.release();
    });

    test('health check proactively cleans alive-but-cwd-less processes', async () => {
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

      client._deleteCwd();

      await new Promise((r) => setTimeout(r, 80));
      const m = pool.getMetrics();
      assert.strictEqual(m.liveProcessCount, 0);
      // FC-1: cwd-less retirement must close the process, not just unlink it
      assert.ok(client._isClosed(), 'retired cwd-less process must be closed');
    });

    test('health check retires cwd-less process with active lease — late release() is a no-op (FC-1)', async () => {
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
      // Do NOT release — the lease is still active when the cwd disappears
      // (e.g. mid-prompt). Retirement must invalidate the lease generation.
      client._deleteCwd();

      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(pool.getMetrics().liveProcessCount, 0);
      assert.strictEqual(pool.getMetrics().activeLeaseCount, 0);
      assert.ok(client._isClosed(), 'retired cwd-less process must be closed');

      // The in-flight consumer's finally block releases the stale lease — it
      // must not decrement metrics a second time.
      lease.release();
      const m = pool.getMetrics();
      assert.strictEqual(m.activeLeaseCount, 0, 'stale release must not double-decrement activeLeaseCount');
      assert.strictEqual(m.liveProcessCount, 0);
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
    test('retirement cannot close a spawned process before its first acquire owns the lease', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      let releaseInitialization = () => {};
      const initializeGate = new Promise((resolve) => {
        releaseInitialization = resolve;
      });
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, () => createMockClient(initializeGate));

      const leasePromise = pool.acquire(key1);
      releaseInitialization();
      while (pool.getMetrics().coldStartCount === 0) await Promise.resolve();

      assert.equal(
        pool.getMetrics().activeLeaseCount,
        1,
        'a published cold-start entry must already be owned by the acquire that spawned it',
      );
      pool.retireWhenIdle();

      const lease = await leasePromise;
      assert.equal(lease.client.isAlive, true, 'retirement must preserve the admitted in-flight acquire');
      assert.equal(pool.getMetrics().idleProcessCount, 0, 'the new active process was never counted idle');

      lease.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lease.client.isAlive, false, 'the retired generation closes after the admitted lease releases');
      assert.deepEqual(pool.getMetrics(), {
        liveProcessCount: 0,
        activeLeaseCount: 0,
        idleProcessCount: 0,
        warmHitCount: 0,
        coldStartCount: 1,
        evictionCount: 0,
        zombieCleanupCount: 0,
      });
    });

    test('retirement keeps active leases alive and closes their process after release', async () => {
      const { AcpProcessPool } = await import(
        '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js'
      );
      pool = new AcpProcessPool(defaultPoolConfig, defaultVariantConfig, createMockClient);
      const lease = await pool.acquire(key1);

      pool.retireWhenIdle();

      assert.equal(lease.client.isAlive, true, 'config refresh must not interrupt the active invocation');
      await assert.rejects(() => pool.acquire(key1), /retired/i);

      lease.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lease.client.isAlive, false, 'the retired generation closes after its final lease drains');
      assert.equal(pool.getMetrics().activeLeaseCount, 0);
      assert.equal(pool.getMetrics().liveProcessCount, 0);
    });

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
