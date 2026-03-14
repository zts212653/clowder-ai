/**
 * F048 Phase A: StartupReconciler — sweep orphaned invocations on startup.
 *
 * Tests use in-memory fakes (no real Redis) to verify:
 * 1. scanByStatus finds records by status
 * 2. reconcileOrphans sweeps running → failed, stale queued → failed
 * 3. task progress is cleared for swept records
 * 4. memory-mode is a no-op
 * 5. edge cases: CAS mismatch, error resilience, fresh queued survives
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// ── Fake InvocationRecordStore (simulates RedisInvocationRecordStore) ──

class FakeRedisInvocationRecordStore {
  records = new Map();

  /** Seed a record directly (bypassing create flow) */
  seed(record) {
    this.records.set(record.id, { ...record });
  }

  async get(id) {
    return this.records.get(id) ?? null;
  }

  async update(id, input) {
    const record = this.records.get(id);
    if (!record) return null;
    // CAS guard
    if (input.expectedStatus !== undefined && record.status !== input.expectedStatus) {
      return null;
    }
    // State machine guard (simplified: running→failed, queued→failed OK)
    if (input.status !== undefined) {
      const allowed = {
        queued: ['running', 'failed', 'canceled'],
        running: ['succeeded', 'failed', 'canceled'],
        failed: ['running', 'canceled'],
      };
      if (!(allowed[record.status] ?? []).includes(input.status)) {
        return null;
      }
    }
    if (input.status !== undefined) record.status = input.status;
    if (input.error !== undefined) record.error = input.error;
    record.updatedAt = Date.now();
    return record;
  }

  /** The method StartupReconciler checks for — simulates SCAN */
  async scanByStatus(status) {
    const ids = [];
    for (const [id, record] of this.records) {
      if (record.status === status) ids.push(id);
    }
    return ids;
  }
}

// ── Fake TaskProgressStore ──

class FakeTaskProgressStore {
  snapshots = new Map(); // key = `${threadId}:${catId}`

  async getSnapshot(threadId, catId) {
    return this.snapshots.get(`${threadId}:${catId}`) ?? null;
  }

  async setSnapshot(snapshot) {
    this.snapshots.set(`${snapshot.threadId}:${snapshot.catId}`, snapshot);
  }

  async deleteSnapshot(threadId, catId) {
    this.snapshots.delete(`${threadId}:${catId}`);
  }

  async getThreadSnapshots(threadId) {
    const out = {};
    for (const [key, snap] of this.snapshots) {
      if (key.startsWith(`${threadId}:`)) {
        out[snap.catId] = snap;
      }
    }
    return out;
  }

  async deleteThread(threadId) {
    for (const key of [...this.snapshots.keys()]) {
      if (key.startsWith(`${threadId}:`)) this.snapshots.delete(key);
    }
  }
}

// ── Fake Logger ──

function createFakeLog() {
  return {
    messages: [],
    info(msg) {
      this.messages.push({ level: 'info', msg });
    },
    warn(msg) {
      this.messages.push({ level: 'warn', msg });
    },
  };
}

// ── Helpers ──

function makeRecord(overrides = {}) {
  return {
    id: `inv-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    userId: 'user-1',
    userMessageId: 'msg-1',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'running',
    idempotencyKey: `key-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now() - 60_000, // 1 min ago
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function makeTaskSnapshot(threadId, catId) {
  return {
    threadId,
    catId,
    tasks: [{ id: 't1', subject: 'test', status: 'running' }],
    status: 'running',
    updatedAt: Date.now(),
  };
}

// ── Import StartupReconciler (lazy — file may not exist yet in RED phase) ──

let StartupReconciler;
try {
  const mod = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');
  StartupReconciler = mod.StartupReconciler;
} catch {
  // RED phase: module doesn't exist yet — tests will fail with clear message
}

// ── Tests ──

describe('StartupReconciler', () => {
  let store;
  let taskProgressStore;
  let log;

  beforeEach(() => {
    store = new FakeRedisInvocationRecordStore();
    taskProgressStore = new FakeTaskProgressStore();
    log = createFakeLog();
  });

  test('module can be imported', () => {
    assert.ok(StartupReconciler, 'StartupReconciler should be importable');
  });

  test('sweeps running records to failed with process_restart error', async () => {
    const r1 = makeRecord({ id: 'r1', status: 'running', targetCats: ['opus'] });
    const r2 = makeRecord({ id: 'r2', status: 'running', targetCats: ['codex'] });
    const r3 = makeRecord({ id: 'r3', status: 'succeeded' });
    store.seed(r1);
    store.seed(r2);
    store.seed(r3);

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.running, 2, 'should sweep 2 running records');
    assert.equal(result.swept, 2, 'total swept = running + queued');

    // Verify records are now failed
    const updated1 = await store.get('r1');
    assert.equal(updated1.status, 'failed');
    assert.equal(updated1.error, 'process_restart');

    const updated2 = await store.get('r2');
    assert.equal(updated2.status, 'failed');

    // succeeded record untouched
    const unchanged = await store.get('r3');
    assert.equal(unchanged.status, 'succeeded');
  });

  test('clears task progress for swept records', async () => {
    const r1 = makeRecord({ id: 'r1', threadId: 't1', targetCats: ['opus', 'codex'] });
    store.seed(r1);
    taskProgressStore.setSnapshot(makeTaskSnapshot('t1', 'opus'));
    taskProgressStore.setSnapshot(makeTaskSnapshot('t1', 'codex'));
    taskProgressStore.setSnapshot(makeTaskSnapshot('t2', 'opus')); // different thread, untouched

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.taskProgressCleared, 2);
    assert.equal(await taskProgressStore.getSnapshot('t1', 'opus'), null);
    assert.equal(await taskProgressStore.getSnapshot('t1', 'codex'), null);
    // Unrelated thread untouched
    assert.ok(await taskProgressStore.getSnapshot('t2', 'opus'));
  });

  test('sweeps stale queued records (> 5min old)', async () => {
    const staleQueued = makeRecord({
      id: 'sq1',
      status: 'queued',
      createdAt: Date.now() - 10 * 60_000, // 10 min ago
    });
    const freshQueued = makeRecord({
      id: 'fq1',
      status: 'queued',
      createdAt: Date.now() - 60_000, // 1 min ago (fresh, should survive)
    });
    store.seed(staleQueued);
    store.seed(freshQueued);

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.queued, 1, 'only stale queued swept');
    assert.equal((await store.get('sq1')).status, 'failed');
    assert.equal((await store.get('fq1')).status, 'queued', 'fresh queued survives');
  });

  test('does not sweep succeeded/failed/canceled records', async () => {
    store.seed(makeRecord({ id: 's1', status: 'succeeded' }));
    store.seed(makeRecord({ id: 'f1', status: 'failed' }));
    store.seed(makeRecord({ id: 'c1', status: 'canceled' }));

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.swept, 0);
    assert.equal((await store.get('s1')).status, 'succeeded');
    assert.equal((await store.get('f1')).status, 'failed');
    assert.equal((await store.get('c1')).status, 'canceled');
  });

  test('CAS guard prevents double-sweep (already swept by another process)', async () => {
    const r1 = makeRecord({ id: 'cas1', status: 'running' });
    store.seed(r1);

    // Simulate another process sweeping first
    const originalUpdate = store.update.bind(store);
    let callCount = 0;
    store.update = async (id, input) => {
      callCount++;
      if (callCount === 1) {
        // Simulate race: record already swept to 'failed' by another process
        store.records.get(id).status = 'failed';
        return originalUpdate(id, input); // CAS will mismatch
      }
      return originalUpdate(id, input);
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.running, 0, 'CAS mismatch → not counted as swept');
  });

  test('memory mode (no scanByStatus) is a no-op', async () => {
    // Plain object without scanByStatus method
    const memoryStore = {
      get: async () => null,
      update: async () => null,
      create: () => ({ outcome: 'created', invocationId: 'x' }),
      getByIdempotencyKey: async () => null,
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: memoryStore,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.swept, 0);
    assert.ok(log.messages.some((m) => m.msg.includes('Memory mode')));
  });

  test('continues sweeping if individual record update fails', async () => {
    const r1 = makeRecord({ id: 'err1', status: 'running' });
    const r2 = makeRecord({ id: 'err2', status: 'running' });
    store.seed(r1);
    store.seed(r2);

    // Make get() throw for first record
    const originalGet = store.get.bind(store);
    store.get = async (id) => {
      if (id === 'err1') throw new Error('simulated redis error');
      return originalGet(id);
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    // err1 failed to process, err2 should still be swept
    assert.equal(result.running, 1);
    assert.equal((await originalGet('err2')).status, 'failed');
  });

  test('logs sweep summary', async () => {
    store.seed(makeRecord({ id: 'log1', status: 'running' }));

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    await reconciler.reconcileOrphans();

    assert.ok(
      log.messages.some((m) => m.msg.includes('Sweep complete') && m.msg.includes('1 running')),
      'should log sweep summary',
    );
  });

  test('returns timing information', async () => {
    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
  });

  // #77: Notification tests
  test('#77: posts visible error message to affected threads', async () => {
    const r1 = makeRecord({ id: 'n1', threadId: 'thread-a', status: 'running', targetCats: ['opus'] });
    const r2 = makeRecord({ id: 'n2', threadId: 'thread-b', status: 'running', targetCats: ['codex'] });
    store.seed(r1);
    store.seed(r2);

    const appendedMessages = [];
    const messageStore = {
      append(msg) {
        appendedMessages.push(msg);
        return { ...msg, id: `msg-${appendedMessages.length}` };
      },
    };

    const broadcastedMessages = [];
    const socketManager = {
      broadcastAgentMessage(msg, threadId) {
        broadcastedMessages.push({ msg, threadId });
      },
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      messageStore,
      socketManager,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.notifiedThreads, 2, 'should notify 2 threads');
    assert.equal(appendedMessages.length, 2, 'should append 2 messages');
    assert.equal(broadcastedMessages.length, 2, 'should broadcast 2 messages');

    // Verify message content
    const msgA = appendedMessages.find((m) => m.threadId === 'thread-a');
    assert.ok(msgA, 'thread-a should have a message');
    assert.equal(msgA.userId, 'system');
    assert.equal(msgA.catId, null);
    assert.ok(msgA.content.includes('opus'), 'message should mention affected cat');
    assert.ok(msgA.content.includes('restart') || msgA.content.includes('interrupted'), 'message should explain restart');

    // Verify broadcast
    const bcA = broadcastedMessages.find((b) => b.threadId === 'thread-a');
    assert.ok(bcA);
    assert.equal(bcA.msg.type, 'error');
    assert.equal(bcA.msg.isFinal, true);
  });

  test('#77: deduplicates notifications per thread', async () => {
    // Two invocations in the same thread
    const r1 = makeRecord({ id: 'dup1', threadId: 'thread-x', status: 'running', targetCats: ['opus'] });
    const r2 = makeRecord({ id: 'dup2', threadId: 'thread-x', status: 'running', targetCats: ['codex'] });
    store.seed(r1);
    store.seed(r2);

    const appendedMessages = [];
    const messageStore = {
      append(msg) {
        appendedMessages.push(msg);
        return { ...msg, id: `msg-${appendedMessages.length}` };
      },
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      messageStore,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.notifiedThreads, 1, 'only 1 thread notification despite 2 invocations');
    assert.equal(appendedMessages.length, 1, 'only 1 message appended');
    assert.ok(appendedMessages[0].content.includes('2 cats'), 'message should mention 2 cats');
  });

  test('#77: no notification when messageStore/socketManager not provided', async () => {
    store.seed(makeRecord({ id: 'quiet1', status: 'running' }));

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      // no messageStore, no socketManager
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.notifiedThreads, 0);
    assert.equal(result.running, 1, 'still sweeps even without notification deps');
  });

  test('does not sweep running records created after processStartAt', async () => {
    const processStartAt = Date.now() - 5_000; // 5 sec ago
    // Old orphan: created before process started → should be swept
    const orphan = makeRecord({ id: 'old1', status: 'running', createdAt: processStartAt - 60_000 });
    // New record: created after process started → must survive
    const fresh = makeRecord({ id: 'new1', status: 'running', createdAt: processStartAt + 1_000 });
    store.seed(orphan);
    store.seed(fresh);

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      processStartAt,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.running, 1, 'only old orphan swept');
    assert.equal((await store.get('old1')).status, 'failed');
    assert.equal((await store.get('new1')).status, 'running', 'fresh record survives');
  });
});
