import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { NarratorDriver } = await import('../dist/domains/community/NarratorDriver.js');

// ---------------------------------------------------------------------------
// Helpers — lightweight fakes
// ---------------------------------------------------------------------------

/** In-memory implementation of NarratorDedupStore for testing (atomic claim). */
function createTestDedupStore() {
  const store = new Set();
  return {
    async claim(key) {
      if (store.has(key)) return false;
      store.add(key);
      return true;
    },
    /** Expose for assertions. */
    _store: store,
  };
}

function createFakeRoleResolver() {
  return {
    resolve(role) {
      if (role === 'narrator') {
        return { catId: 'gemini35', capabilities: ['triage', 'route-recommend', 'public-reply'] };
      }
      return null;
    },
  };
}

function createSpyWakeCat() {
  const calls = [];
  const fn = async (params) => {
    calls.push(params);
  };
  fn.calls = calls;
  return fn;
}

function createSilentLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function makeSpawnParams(overrides = {}) {
  return {
    caseId: 'case-001',
    subjectKey: 'issue:test/repo#1',
    sourceEventId: 'dispatch:001:1700000000000',
    briefingContext: 'Test issue [bug] (test/repo#1)',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D0.2 — NarratorDriver persistent dedup (INV-3 upgrade)
// ---------------------------------------------------------------------------

describe('NarratorDriver persistent dedup (D0.2)', () => {
  test('two instances sharing dedup store do NOT double-spawn same (subjectKey, sourceEventId)', async () => {
    const dedupStore = createTestDedupStore();
    const wakeCat1 = createSpyWakeCat();
    const wakeCat2 = createSpyWakeCat();

    const driver1 = new NarratorDriver({
      roleResolver: createFakeRoleResolver(),
      narratorThreadId: 'thread-narrator-ops',
      wakeCat: wakeCat1,
      log: createSilentLog(),
      dedupStore,
    });

    const driver2 = new NarratorDriver({
      roleResolver: createFakeRoleResolver(),
      narratorThreadId: 'thread-narrator-ops',
      wakeCat: wakeCat2,
      log: createSilentLog(),
      dedupStore,
    });

    const params = makeSpawnParams();

    // First instance spawns successfully
    await driver1.spawnNarrator(params);
    assert.equal(wakeCat1.calls.length, 1, 'driver1 should spawn');

    // Second instance is dedup no-op via shared store
    await driver2.spawnNarrator(params);
    assert.equal(wakeCat2.calls.length, 0, 'driver2 should NOT spawn (dedup via shared store)');
  });

  test('same instance does not double-spawn same sourceEventId', async () => {
    const dedupStore = createTestDedupStore();
    const wakeCat = createSpyWakeCat();

    const driver = new NarratorDriver({
      roleResolver: createFakeRoleResolver(),
      narratorThreadId: 'thread-narrator-ops',
      wakeCat,
      log: createSilentLog(),
      dedupStore,
    });

    const params = makeSpawnParams();

    await driver.spawnNarrator(params);
    await driver.spawnNarrator(params);
    assert.equal(wakeCat.calls.length, 1, 'should spawn exactly once');
  });

  test('different sourceEventIds are NOT deduped', async () => {
    const dedupStore = createTestDedupStore();
    const wakeCat = createSpyWakeCat();

    const driver = new NarratorDriver({
      roleResolver: createFakeRoleResolver(),
      narratorThreadId: 'thread-narrator-ops',
      wakeCat,
      log: createSilentLog(),
      dedupStore,
    });

    await driver.spawnNarrator(makeSpawnParams({ sourceEventId: 'dispatch:001:1' }));
    await driver.spawnNarrator(makeSpawnParams({ sourceEventId: 'dispatch:002:2' }));
    assert.equal(wakeCat.calls.length, 2, 'different events should both spawn');
  });

  test('dedup store is consulted BEFORE wakeCat call (persistent check)', async () => {
    const dedupStore = createTestDedupStore();
    const wakeCat = createSpyWakeCat();
    const log = createSilentLog();

    // Pre-seed the dedup store (simulating another process already spawned this)
    await dedupStore.claim('dispatch:pre-seeded:1');

    const driver = new NarratorDriver({
      roleResolver: createFakeRoleResolver(),
      narratorThreadId: 'thread-narrator-ops',
      wakeCat,
      log,
      dedupStore,
    });

    await driver.spawnNarrator(makeSpawnParams({ sourceEventId: 'dispatch:pre-seeded:1' }));
    assert.equal(wakeCat.calls.length, 0, 'pre-seeded dedup key should prevent spawn');
  });
});

// ---------------------------------------------------------------------------
// D0.3 — Boot warning when narrator role configured but thread ID absent
// ---------------------------------------------------------------------------

describe('NarratorDriver env warning (D0.3)', () => {
  test('NarratorDriver.checkBootConfig warns when narrator role configured but threadId absent', () => {
    const warnings = [];
    const log = {
      info() {},
      warn(obj, msg) {
        warnings.push(msg || obj);
      },
      error() {},
    };

    // Static check — doesn't need a full NarratorDriver instance
    const { checkNarratorBootConfig } = NarratorDriver;
    assert.ok(
      typeof checkNarratorBootConfig === 'function',
      'NarratorDriver should export a static checkNarratorBootConfig',
    );

    checkNarratorBootConfig({
      narratorRoleConfigured: true,
      narratorThreadId: undefined,
      log,
    });

    assert.ok(warnings.length > 0, 'should log a warning when thread ID is absent');
    assert.ok(
      warnings.some((w) => typeof w === 'string' && w.includes('COMMUNITY_NARRATOR_THREAD_ID')),
      'warning should mention COMMUNITY_NARRATOR_THREAD_ID',
    );
  });

  test('no warning when both role and threadId are present', () => {
    const warnings = [];
    const log = {
      info() {},
      warn(obj, msg) {
        warnings.push(msg || obj);
      },
      error() {},
    };

    NarratorDriver.checkNarratorBootConfig({
      narratorRoleConfigured: true,
      narratorThreadId: 'thread-001',
      log,
    });

    assert.equal(warnings.length, 0, 'should NOT warn when threadId is present');
  });
});

// ---------------------------------------------------------------------------
// Cloud P2 #2 fix: dedupStore.claim() rejection must be caught + logged
// ---------------------------------------------------------------------------

describe('NarratorDriver claim() error handling', () => {
  test('dedupStore.claim() rejection is caught and logged, not propagated', async () => {
    const errors = [];
    const log = {
      info() {},
      warn() {},
      error(obj, msg) {
        errors.push(msg || obj);
      },
    };

    const failingDedupStore = {
      async claim() {
        throw new Error('Redis connection refused');
      },
    };

    const wakeCat = createSpyWakeCat();

    const driver = new NarratorDriver({
      roleResolver: createFakeRoleResolver(),
      narratorThreadId: 'thread-narrator-ops',
      wakeCat,
      log,
      dedupStore: failingDedupStore,
    });

    // Must NOT reject — fire-and-forget contract
    await driver.spawnNarrator(makeSpawnParams());

    assert.equal(wakeCat.calls.length, 0, 'wakeCat should NOT be called when claim fails');
    assert.ok(errors.length > 0, 'claim failure should be logged at error level');
    assert.ok(
      errors.some((e) => typeof e === 'string' && e.includes('claim')),
      'error message should mention claim failure',
    );
  });
});

// ---------------------------------------------------------------------------
// Cloud R3 P2: claim must NOT be consumed when role is unresolved
// ---------------------------------------------------------------------------

describe('NarratorDriver claim/resolve ordering (R3 P2)', () => {
  test('null role does NOT consume dedup key — retry after role fix succeeds', async () => {
    const dedupStore = createTestDedupStore();
    const wakeCat = createSpyWakeCat();
    const log = createSilentLog();

    // Role resolver returns null initially, then resolves after "config fix"
    let resolveRole = false;
    const roleResolver = {
      resolve(role) {
        if (role === 'narrator' && resolveRole) {
          return { catId: 'gemini35', capabilities: ['triage'] };
        }
        return null;
      },
    };

    const driver = new NarratorDriver({
      roleResolver,
      narratorThreadId: 'thread-narrator-ops',
      wakeCat,
      log,
      dedupStore,
    });

    // First attempt: role unresolved → should NOT spawn AND should NOT consume dedup key
    await driver.spawnNarrator(makeSpawnParams());
    assert.equal(wakeCat.calls.length, 0, 'should not spawn when role is null');
    assert.equal(dedupStore._store.size, 0, 'dedup key should NOT be consumed when role is null');

    // Fix role config
    resolveRole = true;

    // Second attempt: role now resolved → should succeed (dedup key was preserved)
    await driver.spawnNarrator(makeSpawnParams());
    assert.equal(wakeCat.calls.length, 1, 'should spawn after role is fixed (dedup key was preserved)');
  });
});
