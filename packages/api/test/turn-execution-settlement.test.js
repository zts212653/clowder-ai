import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

function child(invocationId, overrides = {}) {
  return {
    invocationId,
    parentInvocationId: 'parent',
    threadId: 'thread',
    userId: 'owner',
    catId: 'codex61-sol',
    executionKind: 'ordinary',
    startedAt: 100,
    ...overrides,
  };
}

async function end(store, invocationId, overrides = {}) {
  await store.createRunning(child(invocationId, overrides));
  await store.transitionTerminal(invocationId, { status: 'succeeded', endedAt: 200 });
}

test('a child becomes discoverable only after its own output settles, before its parent ends', async () => {
  const store = new InMemoryTurnExecutionStore();
  await end(store, 'first');
  await store.createRunning(child('second'));
  assert.deepEqual((await store.listSettled({ userId: 'owner', threadId: 'thread' })).records, []);

  const result = await store.markResponseSettled('first', { kind: 'message', messageId: 'reply-1', settledAt: 220 });
  assert.equal(result.outcome, 'settled');
  assert.equal((await store.get('second')).status, 'running');
  const page = await store.listSettled({ userId: 'owner', threadId: 'thread' });
  assert.deepEqual(
    page.records.map((record) => record.invocationId),
    ['first'],
  );
  assert.equal(page.records[0].responseSettlement.messageId, 'reply-1');
  assert.deepEqual(await store.listResponsePending(), []);
});

test('a canceled Host response settles while missing physical stop evidence remains visible', async () => {
  const store = new InMemoryTurnExecutionStore();
  await store.createRunning(child('stopping', { providerLifecycleTracked: true }));
  await store.markProviderStarted('stopping', 120);
  await store.transitionTerminal('stopping', { status: 'canceled', endedAt: 200, terminalReason: 'user_cancel' });
  const response = { kind: 'message', messageId: 'cancel-reply', settledAt: 210 };
  assert.equal((await store.markResponseSettled('stopping', response)).outcome, 'settled');
  assert.equal((await store.get('stopping')).providerTeardownAt, undefined);
  assert.deepEqual(await store.listResponsePending(), []);
  await store.recordProviderTeardown('stopping', 230);
  assert.equal((await store.markResponseSettled('stopping', { ...response, settledAt: 240 })).outcome, 'replayed');
});

test('parallel output may finish first; teardown and terminal publication join it exactly once', async () => {
  const store = new InMemoryTurnExecutionStore();
  await store.createRunning(child('parallel', { providerLifecycleTracked: true }));
  await store.markProviderStarted('parallel', 120);
  assert.equal(
    (
      await store.markResponseSettled('parallel', {
        kind: 'message',
        messageId: 'parallel-reply',
        settledAt: 150,
      })
    ).outcome,
    'not_ready',
  );
  assert.equal((await store.listSettled({ userId: 'owner' })).records.length, 0);
  await store.recordProviderTeardown('parallel', 200);
  await store.transitionTerminal('parallel', { status: 'succeeded', endedAt: 210 });
  const page = await store.listSettled({ userId: 'owner' });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].responseSettlement.messageId, 'parallel-reply');
  assert.equal(page.records[0].responseSettlement.settledAt, 210);
});

test('settlement is immutable and retries preserve the first sequence and time', async () => {
  const store = new InMemoryTurnExecutionStore();
  await end(store, 'once');
  const first = await store.markResponseSettled('once', { kind: 'message', messageId: 'reply', settledAt: 250 });
  const replay = await store.markResponseSettled('once', { kind: 'message', messageId: 'reply', settledAt: 999 });
  assert.equal(replay.outcome, 'replayed');
  assert.deepEqual(replay.record, first.record);
  assert.equal(
    (await store.markResponseSettled('once', { kind: 'no_response', reason: 'empty_turn', settledAt: 999 })).outcome,
    'conflict',
  );
  assert.equal((await store.listSettled({ userId: 'owner' })).records.length, 1);
});

test('paging follows commit sequence, so late settlements and equal timestamps are never lost', async () => {
  const store = new InMemoryTurnExecutionStore();
  for (const id of ['late', 'first', 'sibling', 'other']) {
    await end(store, id, id === 'other' ? { userId: 'other-owner' } : id === 'sibling' ? { threadId: 'sibling' } : {});
  }
  const settle = (id) => store.markResponseSettled(id, { kind: 'no_response', reason: 'tool_only', settledAt: 300 });
  await settle('first');
  await settle('sibling');
  await settle('other');
  const page = await store.listSettled({ userId: 'owner', threadId: 'thread', limit: 1 });
  assert.deepEqual(
    page.records.map((record) => record.invocationId),
    ['first'],
  );
  await settle('late');
  const tail = await store.listSettled({ userId: 'owner', threadId: 'thread', afterSequence: page.nextCursor });
  assert.deepEqual(
    tail.records.map((record) => record.invocationId),
    ['late'],
  );
  assert.deepEqual(
    (await store.listSettled({ userId: 'other-owner' })).records.map((r) => r.invocationId),
    ['other'],
  );
});

test('pending cannot be cleared before output evidence exists; snapshots do not mutate the owner', async () => {
  const store = new InMemoryTurnExecutionStore();
  await end(store, 'pending');
  await store.clearResponsePending('pending');
  assert.equal((await store.listResponsePending()).length, 1);
  await store.markResponseSettled('pending', { kind: 'no_response', reason: 'empty_turn', settledAt: 300 });
  const snapshot = await store.get('pending');
  snapshot.responseSettlement.reason = 'changed-by-reader';
  assert.equal((await store.get('pending')).responseSettlement.reason, 'empty_turn');
});
