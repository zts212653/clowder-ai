/**
 * SessionMutex Tests
 * per-cliSessionId 串行锁 — 防止同一 session 被并发 resume
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { SessionMutex } = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');

function owner(overrides = {}) {
  return {
    key: 'session-1',
    invocationId: 'inv-1',
    executionId: 'exec-1',
    threadId: 'thread-1',
    catId: 'codex-sol',
    userId: 'user-1',
    acquiredAt: Date.now(),
    ...overrides,
  };
}

test('acquire returns release function when no contention', async () => {
  const mutex = new SessionMutex();
  const release = await mutex.acquire('session-1');
  assert.equal(typeof release, 'function');
  release();
});

test('second acquire waits until first releases', async () => {
  const mutex = new SessionMutex();
  const order = [];

  const release1 = await mutex.acquire('s1');
  order.push('acquired-1');

  const p2 = mutex.acquire('s1').then((release) => {
    order.push('acquired-2');
    return release;
  });

  // Give p2 a tick — it should NOT resolve yet
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['acquired-1']);

  release1();
  const release2 = await p2;
  assert.deepEqual(order, ['acquired-1', 'acquired-2']);
  release2();
});

test('different sessionIds do not block each other', async () => {
  const mutex = new SessionMutex();
  const release1 = await mutex.acquire('s1');
  const release2 = await mutex.acquire('s2'); // Should not block
  assert.equal(typeof release2, 'function');
  release1();
  release2();
});

test('queued acquire rejects when signal is aborted', async () => {
  const mutex = new SessionMutex();
  const release1 = await mutex.acquire('s1');

  const controller = new AbortController();
  const p2 = mutex.acquire('s1', controller.signal);

  // Abort while waiting
  controller.abort();
  await assert.rejects(p2, /abort/i);
  release1();
});

test('already-aborted signal rejects immediately', async () => {
  const mutex = new SessionMutex();
  const release1 = await mutex.acquire('s1');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(mutex.acquire('s1', controller.signal), /abort/i);
  release1();
});

test('three concurrent acquires are serialized in order', async () => {
  const mutex = new SessionMutex();
  const order = [];

  const r1 = await mutex.acquire('s1');
  order.push('a1');

  const p2 = mutex.acquire('s1').then((r) => {
    order.push('a2');
    return r;
  });
  const p3 = mutex.acquire('s1').then((r) => {
    order.push('a3');
    return r;
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['a1']);

  r1();
  const r2 = await p2;
  assert.deepEqual(order, ['a1', 'a2']);

  r2();
  const r3 = await p3;
  assert.deepEqual(order, ['a1', 'a2', 'a3']);
  r3();
});

test('release is idempotent — double release does not corrupt state', async () => {
  const mutex = new SessionMutex();
  const release = await mutex.acquire('s1');
  release();
  release(); // Second call should be a no-op

  // Should be able to acquire again without deadlock
  const release2 = await mutex.acquire('s1');
  assert.equal(typeof release2, 'function');
  release2();
});

test('integration: concurrent invocations with same sessionId are serialized', async () => {
  const mutex = new SessionMutex();
  const timeline = [];

  async function simulateInvocation(id) {
    const release = await mutex.acquire('shared-session');
    timeline.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, 50)); // simulate work
    timeline.push(`end-${id}`);
    release();
  }

  await Promise.all([simulateInvocation('A'), simulateInvocation('B')]);

  // A and B should not overlap
  const startA = timeline.indexOf('start-A');
  const endA = timeline.indexOf('end-A');
  const startB = timeline.indexOf('start-B');
  assert.ok(startB > endA, `B should start after A ends (timeline: ${timeline.join(', ')})`);
});

test('forceReleaseByScope releases a matching holder and rejects matching waiters', async () => {
  const mutex = new SessionMutex();
  await mutex.acquire(owner());
  const waiting = mutex.acquire(owner({ invocationId: 'inv-waiter' }));

  const result = mutex.forceReleaseByScope({ threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1' });

  assert.deepEqual(result, { releasedHolders: 1, rejectedWaiters: 1, catIds: ['codex-sol'] });
  await assert.rejects(waiting, /force released/i);
  const releaseAfterReset = await mutex.acquire(owner({ invocationId: 'inv-after-reset' }));
  releaseAfterReset();
});

test('forceReleaseByScope preserves a cancelled runner holder until its finally releases', async () => {
  const mutex = new SessionMutex();
  const runnerRelease = await mutex.acquire(owner());
  const waiting = mutex.acquire(owner({ invocationId: 'inv-waiter' }));

  const result = mutex.forceReleaseByScope(
    { threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1' },
    { preserveHolderExecutionIds: ['exec-1'] },
  );

  assert.deepEqual(result, { releasedHolders: 0, rejectedWaiters: 1, catIds: ['codex-sol'] });
  await assert.rejects(waiting, /force released/i);

  let replacementAcquired = false;
  const replacement = mutex.acquire(owner({ invocationId: 'inv-replacement' })).then((release) => {
    replacementAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replacementAcquired, false, 'replacement must wait for the cancelled runner finally');

  runnerRelease();
  const replacementRelease = await replacement;
  replacementRelease();
});

test('forceReleaseByScope preserves only the aborted invocation and releases a same-cat orphan', async () => {
  const mutex = new SessionMutex();
  await mutex.acquire(owner({ key: 'session-orphan', invocationId: 'child-orphan', executionId: 'exec-orphan' }));
  const activeRelease = await mutex.acquire(
    owner({ key: 'session-active', invocationId: 'child-active', executionId: 'exec-active' }),
  );
  const activeWaiter = mutex.acquire(
    owner({ key: 'session-orphan', invocationId: 'child-waiter', executionId: 'exec-active' }),
  );

  const result = mutex.forceReleaseByScope(
    { threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1' },
    { preserveHolderExecutionIds: ['exec-active'] },
  );

  assert.deepEqual(result, { releasedHolders: 1, rejectedWaiters: 1, catIds: ['codex-sol'] });
  await assert.rejects(activeWaiter, /force released/i);

  const orphanReplacement = await mutex.acquire(
    owner({ key: 'session-orphan', invocationId: 'child-replacement', executionId: 'exec-replacement' }),
  );
  orphanReplacement();

  let activeReplacementAcquired = false;
  const activeReplacement = mutex
    .acquire(
      owner({
        key: 'session-active',
        invocationId: 'child-active-replacement',
        executionId: 'exec-active-replacement',
      }),
    )
    .then((release) => {
      activeReplacementAcquired = true;
      return release;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(activeReplacementAcquired, false, 'the exact aborted runner holder must remain protected');
  activeRelease();
  const activeReplacementRelease = await activeReplacement;
  activeReplacementRelease();
});

test('forceReleaseByScope rejects every matching waiter so canceled work cannot revive', async () => {
  const mutex = new SessionMutex();
  await mutex.acquire(owner());
  const waiterA = mutex.acquire(owner({ invocationId: 'inv-waiter-a' }));
  const waiterB = mutex.acquire(owner({ invocationId: 'inv-waiter-b' }));

  const result = mutex.forceReleaseByScope({ threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1' });

  assert.deepEqual(result, { releasedHolders: 1, rejectedWaiters: 2, catIds: ['codex-sol'] });
  await Promise.all([assert.rejects(waiterA, /force released/i), assert.rejects(waiterB, /force released/i)]);
  const release = await mutex.acquire(owner({ invocationId: 'inv-after-waiters' }));
  release();
});

test('forceReleaseByScope only releases holders present when the scoped reset begins', async () => {
  const mutex = new SessionMutex();
  await mutex.acquire(owner());

  const originalDrainNext = mutex.drainNext.bind(mutex);
  let reentrantAcquire;
  mutex.drainNext = (sessionId) => {
    if (!reentrantAcquire) {
      reentrantAcquire = mutex.acquire(owner({ key: 'session-reentrant', invocationId: 'inv-reentrant' }));
    }
    originalDrainNext(sessionId);
  };

  const result = mutex.forceReleaseByScope({ threadId: 'thread-1', userId: 'user-1' });
  const reentrantRelease = await reentrantAcquire;
  let competingAcquired = false;
  const competing = mutex
    .acquire(owner({ key: 'session-reentrant', invocationId: 'inv-competing' }))
    .then((release) => {
      competingAcquired = true;
      return release;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.releasedHolders, 1, 'a holder acquired during reset must not be revisited and released');
  assert.equal(competingAcquired, false, 'the reentrant holder must remain locked');

  reentrantRelease();
  const competingRelease = await competing;
  competingRelease();
});

test('late release from a force-released holder cannot delete the new owner lock', async () => {
  const mutex = new SessionMutex();
  const staleRelease = await mutex.acquire(owner());
  mutex.forceReleaseByScope({ threadId: 'thread-1', userId: 'user-1' });
  const currentRelease = await mutex.acquire(owner({ invocationId: 'inv-current' }));

  staleRelease();
  let thirdAcquired = false;
  const third = mutex.acquire(owner({ invocationId: 'inv-third' })).then((release) => {
    thirdAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdAcquired, false, 'stale release must not unlock the current owner');

  currentRelease();
  const thirdRelease = await third;
  thirdRelease();
});

test('forceReleaseByScope is user scoped on shared threads', async () => {
  const mutex = new SessionMutex();
  const userARelease = await mutex.acquire(owner({ key: 'session-a', invocationId: 'inv-a' }));
  const userBRelease = await mutex.acquire(owner({ key: 'session-b', invocationId: 'inv-b', userId: 'user-2' }));

  const result = mutex.forceReleaseByScope({ threadId: 'thread-1', userId: 'user-1' });
  assert.deepEqual(result, { releasedHolders: 1, rejectedWaiters: 0, catIds: ['codex-sol'] });

  const userANext = await mutex.acquire(owner({ key: 'session-a', invocationId: 'inv-a-next' }));
  let userBNextAcquired = false;
  const userBNext = mutex
    .acquire(owner({ key: 'session-b', invocationId: 'inv-b-next', userId: 'user-2' }))
    .then((release) => {
      userBNextAcquired = true;
      return release;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(userBNextAcquired, false, 'user B holder must survive user A reset');

  userARelease();
  userANext();
  userBRelease();
  const userBNextRelease = await userBNext;
  userBNextRelease();
});
