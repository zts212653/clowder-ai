import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { reconcileFreshnessClosuresAtStartup } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStartupReconciler.js'
);

const now = 7_200_000;

async function open(store, id, openedAt = 100) {
  return store.openOrAdvance({
    closureId: id,
    userId: 'user-1',
    threadId: `thread-${id}`,
    catId: 'gpt52',
    invocationId: `base-${id}`,
    draftContent: 'stale draft',
    requiredMessageIds: ['msg-2'],
    requiredFrontierMessageId: 'msg-2',
    observedRawFrontierMessageId: 'msg-2',
    now: openedAt,
  });
}

function harness(store) {
  const enqueued = [];
  const executed = [];
  const projections = [];
  return {
    enqueued,
    executed,
    projections,
    deps: {
      closureStore: store,
      now: () => now,
      enqueue: (closure) => {
        enqueued.push(closure.id);
        return { outcome: 'enqueued' };
      },
      executeThread: async (threadId) => executed.push(threadId),
      onProjection: (projection) => projections.push(projection),
      log: { info() {}, warn() {}, error() {} },
    },
  };
}

describe('F254 startup closure recovery fence', () => {
  it('blocks a pre-existing pending closure instead of summoning a cat', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await open(store, 'pending');
    const h = harness(store);

    const result = await reconcileFreshnessClosuresAtStartup(h.deps);

    assert.deepEqual(h.enqueued, []);
    assert.deepEqual(h.executed, []);
    assert.equal(result.blocked, 1);
    const closure = await store.get('pending');
    assert.equal(closure.status, 'blocked');
    assert.equal(closure.blockedReason, 'startup_recovery_requires_explicit_retry');
    assert.equal(h.projections.at(-1).status, 'blocked');
  });

  it('recovers one recent running crash forward', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const opened = await open(store, 'recent-running', now - 1_000);
    await store.claimAttempt(opened.id, {
      invocationId: 'inv-crashed',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: now - 900,
    });
    const h = harness(store);

    const result = await reconcileFreshnessClosuresAtStartup(h.deps);

    assert.deepEqual(h.enqueued, ['recent-running']);
    assert.deepEqual(h.executed, ['thread-recent-running']);
    assert.equal(result.recovered, 1);
    assert.equal((await store.get(opened.id)).status, 'pending');
  });

  it('blocks a running attempt older than the liveness horizon', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const opened = await open(store, 'stale-running', 100);
    await store.claimAttempt(opened.id, {
      invocationId: 'inv-hours-old',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    const h = harness(store);

    const result = await reconcileFreshnessClosuresAtStartup({
      ...h.deps,
      maxRunningAttemptAgeMs: 60 * 60_000,
    });

    assert.deepEqual(h.enqueued, []);
    assert.deepEqual(h.executed, []);
    assert.equal(result.blocked, 1);
    assert.equal((await store.get(opened.id)).blockedReason, 'startup_recovery_requires_explicit_retry');
  });

  it('blocks when the process-local queue cannot accept recovered work', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const opened = await open(store, 'queue-full', now - 1_000);
    await store.claimAttempt(opened.id, {
      invocationId: 'inv-crashed',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: now - 900,
    });
    const h = harness(store);
    h.deps.enqueue = () => ({ outcome: 'full' });

    const result = await reconcileFreshnessClosuresAtStartup(h.deps);

    assert.equal(result.recovered, 0);
    assert.equal(result.blocked, 1);
    assert.deepEqual(h.executed, []);
    const closure = await store.get(opened.id);
    assert.equal(closure.blockedReason, 'startup_recovery_requires_explicit_retry');
    assert.deepEqual(closure.blockedEvidenceRefs, ['startup:queue_full']);
  });

  it('continues fencing later candidates when one candidate races to another state', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await open(store, 'raced-candidate');
    await open(store, 'later-pending');
    const h = harness(store);
    const errors = [];
    h.deps.closureStore = {
      listRecoverable: store.listRecoverable.bind(store),
      recoverAttempt: store.recoverAttempt.bind(store),
      blockRecovery: async (closureId, input) => {
        if (closureId === 'raced-candidate') throw new Error('simulated CAS/state race');
        return store.blockRecovery(closureId, input);
      },
    };
    h.deps.log.error = (fields) => errors.push(fields);

    const result = await reconcileFreshnessClosuresAtStartup(h.deps);

    assert.equal(result.blocked, 1);
    assert.equal((await store.get('later-pending')).blockedReason, 'startup_recovery_requires_explicit_retry');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].closureId, 'raced-candidate');
  });

  it('continues auto-executing later recovered threads when one thread fails', async () => {
    const store = new InMemoryFreshnessClosureStore();
    for (const id of ['first-running', 'second-running']) {
      const opened = await open(store, id, now - 1_000);
      await store.claimAttempt(opened.id, {
        invocationId: `inv-${id}`,
        inputFrontierMessageId: 'msg-2',
        observedRawFrontierMessageId: 'msg-2',
        now: now - 900,
      });
    }
    const h = harness(store);
    const attemptedThreads = [];
    const errors = [];
    h.deps.executeThread = async (threadId) => {
      attemptedThreads.push(threadId);
      if (threadId === 'thread-first-running') throw new Error('simulated execution failure');
    };
    h.deps.log.error = (fields) => errors.push(fields);

    const result = await reconcileFreshnessClosuresAtStartup(h.deps);

    assert.deepEqual(attemptedThreads, ['thread-first-running', 'thread-second-running']);
    assert.equal(result.executedThreads, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].threadId, 'thread-first-running');
  });
});
