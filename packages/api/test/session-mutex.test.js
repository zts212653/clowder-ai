/**
 * SessionMutex Tests
 * per-cliSessionId 串行锁 — 防止同一 session 被并发 resume
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { SessionMutex } = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');

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
