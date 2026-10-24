/**
 * Cancel broadcast integration test
 * Verifies that cancel_invocation produces correct catId-aware broadcasts.
 *
 * Tests the REAL production buildCancelMessages function (not a copy).
 * - Per-cat done messages to clear each cat's loading state
 * - No duplicate system row: the durable response bubble owns the terminal label
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { buildCancelMessages } = await import('../dist/infrastructure/websocket/SocketManager.js');

describe('buildCancelMessages (production function)', () => {
  test('single cat cancel: only 1 done with correct catId', () => {
    const tracker = new InvocationTracker();
    // start(threadId, catId, userId, catIds)
    tracker.start('t1', 'gemini', 'user1', ['gemini']);
    const result = tracker.cancel('t1', 'gemini', 'user1');
    const messages = buildCancelMessages(result);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
    assert.equal(messages[0].catId, 'gemini');
    assert.equal(messages[0].isFinal, true);
  });

  test('multi-cat cancel: only N done messages (no duplicate system row)', () => {
    const tracker = new InvocationTracker();
    // start(threadId, catId, userId, catIds) — primary cat is opus
    tracker.start('t1', 'opus', 'user1', ['opus', 'codex', 'gemini']);
    const result = tracker.cancel('t1', 'opus', 'user1');
    const messages = buildCancelMessages(result);

    assert.equal(messages.length, 3);
    const systemInfos = messages.filter((m) => m.type === 'system_info');
    assert.equal(systemInfos.length, 0);

    // Three done messages, one per cat
    const dones = messages.filter((m) => m.type === 'done');
    assert.equal(dones.length, 3);
    assert.deepEqual(
      dones.map((d) => d.catId),
      ['opus', 'codex', 'gemini'],
    );
    assert.ok(dones.every((d) => d.isFinal === true));
  });

  // F-parallel-cancel: when SocketManager / queue.ts scope the broadcast to the requested cat,
  // a single-cat Stop on a multi-cat batch must clear ONLY that cat — not its siblings. This is
  // the most direct cause of "取消一只两只一起取消" from the real Stop button.
  test('scoped single-cat cancel from multi-cat batch: only the requested cat gets a done', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex', 'gemini'], 'user1');
    const result = tracker.cancel('t1', 'codex', 'user1');
    // result.catIds carries the whole batch [opus,codex,gemini]; SocketManager scopes to [codex].
    const scopedResult = { ...result, catIds: ['codex'] };
    const messages = buildCancelMessages(scopedResult);
    const dones = messages.filter((m) => m.type === 'done');
    assert.equal(dones.length, 1, 'only the cancelled cat gets a done — siblings stay alive in UI');
    assert.equal(dones[0].catId, 'codex');
  });

  test('empty catIds fallback: defaults to opus', () => {
    const tracker = new InvocationTracker();
    // start(threadId, catId, userId) — no catIds
    tracker.start('t1', 'opus', 'user1');
    const result = tracker.cancel('t1', 'opus', 'user1');
    const messages = buildCancelMessages(result);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].catId, 'opus');
  });

  test('failed cancel: no messages', () => {
    const result = { cancelled: false, catIds: [] };
    const messages = buildCancelMessages(result);
    assert.equal(messages.length, 0);
  });

  test('cancelled with unknown catId still produces messages (F32-a: any string is valid catId)', () => {
    // F32-a: createCatId accepts any non-empty string, so unknown catId no longer throws
    const result = { cancelled: true, catIds: ['unknown-cat'] };
    const messages = buildCancelMessages(result);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
    assert.equal(messages[0].catId, 'unknown-cat');
  });
});

describe('#1671 cancellation ownership', () => {
  test('snapshots parent, turn and response identities before teardown', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['gemini', 'codex'], 'user1', 'parent');
    const run = {
      threadId: 't1',
      targetId: 'gemini',
      invocationId: 'turn',
      responseMessageId: 'response',
      inputEntryIds: [],
      inputMessageIds: [],
      privateInputEntryIds: [],
      startedAt: 1,
    };
    assert.equal(tracker.bindLifecycleActiveRun(run, 'parent'), true);
    const result = tracker.cancel('t1', 'gemini', 'user1', 'user_cancel');
    tracker.startAll('t1', ['gemini'], 'user1', 'replacement');
    const [message] = buildCancelMessages({ ...result, catIds: ['gemini'] });
    assert.equal(message.errorCode, 'INVOCATION_CANCELLED');
    assert.equal(message.invocationId, 'parent');
    assert.equal(message.turnInvocationId, 'turn');
    assert.equal(message.messageId, 'response');
  });

  test('cancelAll keeps each independent execution owner', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['gemini'], 'user1', 'gemini-parent');
    tracker.startAll('t1', ['codex'], 'user1', 'codex-parent');
    const messages = buildCancelMessages({ ...tracker.cancelAll('t1', 'user1', 'cancel_all'), cancelled: true });
    assert.deepEqual(
      messages.map((m) => [m.catId, m.invocationId, m.errorCode]),
      [
        ['gemini', 'gemini-parent', 'INVOCATION_CANCELLED'],
        ['codex', 'codex-parent', 'INVOCATION_CANCELLED'],
      ],
    );
  });

  test('trackerless exact owner and unknown orphan retain cancellation cleanup', () => {
    const [exact] = buildCancelMessages({ cancelled: true, catIds: ['gemini'], executionIds: ['orphan-parent'] });
    assert.equal(exact.invocationId, 'orphan-parent');
    assert.equal(exact.errorCode, 'INVOCATION_CANCELLED');
    const [unknown] = buildCancelMessages({ cancelled: true, catIds: ['gemini'] });
    assert.equal(unknown.type, 'done');
    assert.equal(unknown.errorCode, 'INVOCATION_CANCELLED');
    assert.equal(unknown.invocationId, undefined);
  });
});

test('#1671 lock-only recovery carries the released owner after its tracker vanished', async () => {
  const { SessionMutex } = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');
  const mutex = new SessionMutex();
  await mutex.acquire({
    key: 'orphan-session',
    invocationId: 'orphan-turn',
    executionId: 'orphan-parent',
    threadId: 't1',
    catId: 'gemini',
    userId: 'user1',
    acquiredAt: 1,
  });
  const released = mutex.forceReleaseByScope({ threadId: 't1', catId: 'gemini', userId: 'user1' });
  const [message] = buildCancelMessages({ cancelled: true, catIds: ['gemini'] }, released.releasedInvocations);
  assert.equal(message.invocationId, 'orphan-parent');
  assert.equal(message.turnInvocationId, 'orphan-turn');
  assert.equal(message.errorCode, 'INVOCATION_CANCELLED');
});

test('#1671 every recovered record of one cat retains its own owner', () => {
  const messages = buildCancelMessages({ cancelled: true, catIds: ['gemini'] }, [
    { catId: 'gemini', executionId: 'orphan-1' },
    { catId: 'gemini', executionId: 'orphan-2' },
  ]);
  assert.deepEqual(
    messages.map((m) => m.invocationId),
    ['orphan-1', 'orphan-2'],
  );
});

test('#1671 a known turn still owns cleanup when a legacy tracker has no parent id', () => {
  const tracker = new InvocationTracker();
  tracker.startAll('t1', ['gemini'], 'user1');
  tracker.bindLifecycleActiveRun({
    threadId: 't1',
    targetId: 'gemini',
    invocationId: 'known-turn',
    responseMessageId: 'response',
    inputEntryIds: [],
    inputMessageIds: [],
    privateInputEntryIds: [],
    startedAt: 1,
  });
  const [message] = buildCancelMessages(tracker.cancel('t1', 'gemini', 'user1', 'user_cancel'));
  assert.equal(message.invocationId, 'known-turn');
  assert.equal(message.messageId, 'response');
});
