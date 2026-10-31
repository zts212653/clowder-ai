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
import { canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

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
let InvocationQueue;
let InMemoryQueueLedgerStore;
try {
  const mod = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');
  StartupReconciler = mod.StartupReconciler;
  ({ InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'));
  ({ InMemoryQueueLedgerStore } = await import(
    '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
  ));
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

  test('F233 PR3: running startup sweep records invocation.died after failed transition', async () => {
    const updatedAt = Date.now() - 45_000;
    const r1 = makeRecord({
      id: 'startup-died-1',
      threadId: 'thread-startup-died',
      status: 'running',
      targetCats: ['opus'],
      updatedAt,
    });
    const queued = makeRecord({
      id: 'startup-queued-1',
      threadId: 'thread-startup-queued',
      status: 'queued',
      targetCats: ['codex'],
      createdAt: Date.now() - 10 * 60_000,
    });
    store.seed(r1);
    store.seed(queued);

    const recorded = [];
    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      ballCustody: {
        async record(event) {
          recorded.push(event);
        },
      },
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.running, 1);
    assert.equal(result.queued, 1);
    assert.equal(recorded.length, 1, 'only running invocations should produce invocation.died');
    assert.equal(recorded[0].kind, 'invocation.died');
    assert.equal(recorded[0].sourceEventId, 'inv:startup-died-1:died');
    assert.equal(recorded[0].subjectKey, 'ball:thread:thread-startup-died');
    assert.deepEqual(recorded[0].payload, {
      invocationId: 'startup-died-1',
      catId: 'opus',
      reason: 'process_restart',
      lastScanAt: updatedAt,
    });
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

  // Parent projection recovery cannot append a second result or socket-only notice.
  for (const status of ['running', 'queued']) {
    test('restart projection recovery stays silent for multiple owners: ' + status, async () => {
      const writes = [],
        broadcasts = [];
      for (const [id, userId, threadId] of [
        ['a', 'alice', 'thread-alice'],
        ['b', 'bob', 'thread-bob'],
      ]) {
        store.seed(makeRecord({ id, userId, threadId, status, createdAt: Date.now() - 10 * 60_000 }));
      }
      const reconciler = new StartupReconciler({
        invocationRecordStore: store,
        taskProgressStore,
        log,
        messageStore: {
          append(input) {
            writes.push(input);
            throw new Error('must not create a chat result');
          },
        },
        socketManager: {
          broadcastToRoom(...args) {
            broadcasts.push(args);
            throw new Error('must not create a socket-only result');
          },
        },
      });
      const result = await reconciler.reconcileOrphans();
      assert.equal(result.swept, 2);
      assert.equal(result.notifiedThreads, 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(broadcasts, []);
      assert.equal((await store.get('a')).status, 'failed');
      assert.equal((await store.get('b')).status, 'failed');
    });
  }

  // ── P1-C: queued message visibility convergence ──

  test('P1-C: calls ensureMessageVisible for both running and queued orphans', async () => {
    // Running invocation — markDelivered called but store guard makes it no-op for non-queued
    const r1 = makeRecord({
      id: 'vis1',
      status: 'running',
      userMessageId: 'umsg-1',
      targetCats: ['opus'],
    });
    // Stale queued invocation — message still queued, SHOULD be recovered
    const r2 = makeRecord({
      id: 'vis2',
      status: 'queued',
      userMessageId: 'umsg-2',
      targetCats: ['codex'],
      createdAt: Date.now() - 10 * 60_000, // stale
    });
    // Running, no userMessageId — should not attempt recovery
    const r3 = makeRecord({
      id: 'vis3',
      status: 'running',
      userMessageId: null,
      targetCats: ['opus'],
    });
    store.seed(r1);
    store.seed(r2);
    store.seed(r3);

    const deliveredIds = [];
    const messageStore = {
      append(msg) {
        return { ...msg, id: `msg-appended`, threadId: msg.threadId ?? 'default' };
      },
      markDelivered(id, deliveredAt) {
        deliveredIds.push({ id, deliveredAt });
        if (id === 'umsg-1') {
          return { id, deliveryStatus: 'delivered', deliveredAt, deliveryTransitioned: false };
        }
        return { id, deliveryStatus: 'delivered', deliveredAt, deliveryTransitioned: true };
      },
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      messageStore,
    });

    const result = await reconciler.reconcileOrphans();

    // Both get markDelivered called, but CAS decides: umsg-1 (already visible) = no-op,
    // umsg-2 (queued orphan) = recovered. Only the CAS winner counts.
    assert.equal(result.messagesRecovered, 1, 'only queued orphan counts as recovered (running = CAS no-op)');
    assert.deepEqual(
      deliveredIds.map((d) => d.id).sort(),
      ['umsg-1', 'umsg-2'],
      'markDelivered called for both (CAS decides actual effect)',
    );
  });

  test('P1-C: message recovery is best-effort (failure does not block sweep)', async () => {
    store.seed(
      makeRecord({
        id: 'be-msg1',
        status: 'queued',
        userMessageId: 'umsg-fail',
        targetCats: ['opus'],
        createdAt: Date.now() - 10 * 60_000, // stale
      }),
    );

    const messageStore = {
      append(msg) {
        return { ...msg, id: 'msg-x', threadId: msg.threadId ?? 'default' };
      },
      markDelivered() {
        throw new Error('simulated markDelivered failure');
      },
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      messageStore,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.queued, 1, 'sweep still happens despite markDelivered failure');
    assert.equal(result.messagesRecovered, 0, 'recovery fails gracefully');
    assert.ok(
      log.messages.some((m) => m.level === 'warn' && m.msg.includes('umsg-fail')),
      'should log warning about failed recovery',
    );
  });

  test('P1-C: messagesRecovered is 0 when messageStore has no markDelivered', async () => {
    store.seed(
      makeRecord({ id: 'no-md1', status: 'queued', userMessageId: 'umsg-x', createdAt: Date.now() - 10 * 60_000 }),
    );

    const messageStore = {
      append(msg) {
        return { ...msg, id: 'msg-x', threadId: msg.threadId ?? 'default' };
      },
      // No markDelivered method
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      messageStore,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.messagesRecovered, 0);
    assert.equal(result.queued, 1, 'sweep still works');
  });

  test('P2 review fix: running invocations call markDelivered (store guard makes it safe)', async () => {
    const r1 = makeRecord({
      id: 'already-vis',
      status: 'running',
      userMessageId: 'umsg-already-delivered',
      targetCats: ['opus'],
    });
    store.seed(r1);

    let markDeliveredCallCount = 0;
    const messageStore = {
      append(msg) {
        return { ...msg, id: 'msg-x', threadId: msg.threadId ?? 'default' };
      },
      markDelivered(id) {
        markDeliveredCallCount++;
        return {
          id,
          deliveryStatus: 'delivered',
          deliveredAt: Date.now() - 60_000,
          deliveryTransitioned: false,
        };
      },
    };

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      messageStore,
    });

    const result = await reconciler.reconcileOrphans();

    // markDelivered IS called (ensures crash-recovery path is exercised), but CAS
    // reports applied=false for already-visible messages → not counted as recovered.
    assert.equal(markDeliveredCallCount, 1, 'markDelivered should be called');
    assert.equal(result.messagesRecovered, 0, 'CAS no-op: already-visible message not counted as recovered');
    assert.equal(result.running, 1);
  });

  test('ADR-043: restart resumes pending Queue work without reconstructing already-claimed work', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const processingAdmission = queue.enqueueDurableNow(
      canonicalTestQueueInput({
        sourceId: 'processing-source',
        threadId: 'thread-ledger-restart',
        userId: 'user-1',
        kind: 'conversation_input',
        content: 'processing source',
        targetCats: ['opus'],
        messageId: 'processing-source',
        intent: 'execute',
      }),
    );
    const claimed = await queue.markProcessingByIdDurable(
      'thread-ledger-restart',
      processingAdmission.entry.id,
      'opus',
    );
    assert.ok(claimed);
    assert.equal(await queue.commitClaimedProcessing('thread-ledger-restart', [claimed.id]), true);
    assert.equal(
      await ledger.get('thread-ledger-restart', claimed.id),
      null,
      'History owns processing/terminal truth after Queue releases its claim',
    );

    queue.enqueueDurableNow(
      canonicalTestQueueInput({
        sourceId: 'queued-source',
        threadId: 'thread-ledger-restart',
        userId: 'user-1',
        kind: 'conversation_input',
        content: 'queued source',
        targetCats: ['opus'],
        messageId: 'queued-source',
        intent: 'execute',
      }),
    );

    const reconciler = new StartupReconciler({
      invocationRecordStore: store,
      taskProgressStore,
      log,
      invocationQueue: queue,
    });
    const result = await reconciler.reconcileOrphans();

    assert.equal(result.queueMessagesTerminalized, 0);
    assert.deepEqual(result.queueResumeScopes, [{ threadId: 'thread-ledger-restart', userId: 'user-1' }]);
    assert.deepEqual(
      queue.list('thread-ledger-restart', 'user-1').map((entry) => entry.payload.messageId),
      ['queued-source'],
    );
    assert.equal(await ledger.get('thread-ledger-restart', claimed.id), null);
  });

  // ── Phase A (original) tests continue ──

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
