import assert from 'node:assert/strict';
import { test } from 'node:test';

const controlModule = import('../dist/domains/cats/services/agents/providers/CodexAppServerReviewControl.js');

class Inbox {
  #values = [];
  #waiters = [];
  #closed = false;
  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }
  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function reviewWire({ terminalStatus = 'completed' } = {}) {
  const inbox = new Inbox();
  const writes = [];
  return {
    writes,
    wire: {
      read: () => inbox,
      write: async (message) => {
        writes.push(message);
        if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
        if (message.method === 'thread/resume') {
          inbox.push({ id: message.id, result: { thread: { id: 'native-thread-1' } } });
        }
        if (message.method === 'review/start') {
          inbox.push({
            id: message.id,
            result: {
              reviewThreadId: 'native-thread-1',
              turn: { id: 'review-turn-1', status: 'inProgress', items: [] },
            },
          });
          inbox.push({
            method: 'item/completed',
            params: {
              threadId: 'native-thread-1',
              turnId: 'review-turn-1',
              completedAtMs: 101,
              item: { id: 'enter-1', type: 'enteredReviewMode', review: 'Reviewing current changes' },
            },
          });
          inbox.push({
            method: 'item/completed',
            params: {
              threadId: 'native-thread-1',
              turnId: 'review-turn-1',
              completedAtMs: 102,
              item: { id: 'exit-1', type: 'exitedReviewMode', review: 'P1: reject unsafe delete' },
            },
          });
          inbox.push({
            method: 'turn/completed',
            params: {
              threadId: 'native-thread-1',
              turn: { id: 'review-turn-1', status: terminalStatus, items: [] },
            },
          });
        }
      },
      close: async () => inbox.close(),
      terminate: async () => inbox.close(),
    },
  };
}

test('native review maps provider wire events into structured review lifecycle and result', async () => {
  const { requestCodexAppServerReview } = await controlModule;
  const fixture = reviewWire();
  const updates = [];
  const result = await requestCodexAppServerReview({
    wire: fixture.wire,
    threadId: 'native-thread-1',
    timeoutMs: 1_000,
    request: { target: { kind: 'uncommitted_changes' }, delivery: 'inline' },
    onUpdate: (update) => updates.push(update),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.runtimeSessionId, 'native-thread-1');
  assert.equal(result.reviewThreadId, 'native-thread-1');
  assert.equal(result.turnId, 'review-turn-1');
  assert.deepEqual(result.items, [
    { id: 'enter-1', kind: 'mode_entered', text: 'Reviewing current changes', completedAt: 101 },
    { id: 'exit-1', kind: 'mode_exited', text: 'P1: reject unsafe delete', completedAt: 102 },
  ]);
  assert.deepEqual(result.result, { status: 'completed', summary: 'P1: reject unsafe delete' });
  assert.ok(updates.some((update) => update.status === 'running'));
  assert.deepEqual(
    fixture.writes.filter((message) => typeof message.method === 'string').map((message) => message.method),
    ['initialize', 'initialized', 'thread/resume', 'review/start'],
  );
  assert.deepEqual(fixture.writes.at(-1).params, {
    threadId: 'native-thread-1',
    target: { type: 'uncommittedChanges' },
    delivery: 'inline',
  });
});

test('native review maps an interrupted provider turn to a failed terminal result', async () => {
  const { requestCodexAppServerReview } = await controlModule;
  const fixture = reviewWire({ terminalStatus: 'interrupted' });

  const result = await requestCodexAppServerReview({
    wire: fixture.wire,
    threadId: 'native-thread-1',
    timeoutMs: 1_000,
    request: { target: { kind: 'uncommitted_changes' }, delivery: 'inline' },
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.result, {
    status: 'failed',
    summary: 'P1: reject unsafe delete',
    errorCode: 'provider_review_interrupted',
  });
});

test('native review rejects a detached response whose turn has no stable identity', async () => {
  const { requestCodexAppServerReview } = await controlModule;
  const fixture = reviewWire();
  const originalWrite = fixture.wire.write;
  fixture.wire.write = async (message) => {
    if (message.method === 'review/start') {
      fixture.writes.push(message);
      fixture.wire
        .read()
        .push({ id: message.id, result: { reviewThreadId: 'detached-1', turn: { status: 'inProgress' } } });
      return;
    }
    return originalWrite(message);
  };
  await assert.rejects(
    requestCodexAppServerReview({
      wire: fixture.wire,
      threadId: 'native-thread-1',
      timeoutMs: 1_000,
      request: { target: { kind: 'commit', sha: 'a'.repeat(40) }, delivery: 'detached' },
    }),
    /authoritative_native_review_response_invalid/,
  );
});
