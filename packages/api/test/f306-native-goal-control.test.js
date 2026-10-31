import assert from 'node:assert/strict';
import { test } from 'node:test';

const controlModule = import('../dist/domains/cats/services/agents/providers/CodexAppServerGoalControl.js');

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

function goalWire(resumeId = 'native-thread-1') {
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
          inbox.push({ id: message.id, result: { thread: { id: resumeId } } });
        }
        if (message.method === 'thread/goal/set') {
          inbox.push({
            id: message.id,
            result: {
              goal: {
                threadId: 'native-thread-1',
                objective: message.params.objective,
                status: message.params.status,
                tokenBudget: message.params.tokenBudget,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 100,
                updatedAt: 101,
              },
            },
          });
        }
        if (message.method === 'thread/goal/get') {
          inbox.push({ id: message.id, result: { goal: null } });
        }
        if (message.method === 'thread/goal/clear') {
          inbox.push({ id: message.id, result: { cleared: true } });
        }
      },
      close: async () => inbox.close(),
      terminate: async () => inbox.close(),
    },
  };
}

test('native goal control binds set/get/clear to the resumed provider thread', async () => {
  const { requestCodexAppServerGoal } = await controlModule;
  for (const request of [
    { action: 'set', objective: 'Ship Phase C', status: 'active', tokenBudget: 20_000 },
    { action: 'get' },
    { action: 'clear' },
  ]) {
    const fixture = goalWire();
    const result = await requestCodexAppServerGoal({
      wire: fixture.wire,
      threadId: 'native-thread-1',
      timeoutMs: 1_000,
      request,
    });
    assert.equal(result.action, request.action);
    assert.equal(result.runtimeSessionId, 'native-thread-1');
    assert.deepEqual(
      fixture.writes.filter((message) => typeof message.method === 'string').map((message) => message.method),
      ['initialize', 'initialized', 'thread/resume', `thread/goal/${request.action}`],
    );
  }
});

test('native goal control rejects a mismatched resumed runtime before mutation', async () => {
  const { requestCodexAppServerGoal } = await controlModule;
  const fixture = goalWire('other-thread');
  await assert.rejects(
    requestCodexAppServerGoal({
      wire: fixture.wire,
      threadId: 'native-thread-1',
      timeoutMs: 1_000,
      request: { action: 'clear' },
    }),
    /authoritative_native_rpc_rejoin_mismatch/,
  );
  assert.equal(
    fixture.writes.some((message) => message.method === 'thread/goal/clear'),
    false,
  );
});

test('native goal control rejects malformed provider goal responses', async () => {
  const { requestCodexAppServerGoal } = await controlModule;
  const fixture = goalWire();
  const originalWrite = fixture.wire.write;
  fixture.wire.write = async (message) => {
    if (message.method === 'thread/goal/set') {
      fixture.writes.push(message);
      const inbox = fixture.wire.read();
      inbox.push({ id: message.id, result: { goal: { threadId: 'other-thread', objective: 'wrong' } } });
      return;
    }
    return originalWrite(message);
  };
  await assert.rejects(
    requestCodexAppServerGoal({
      wire: fixture.wire,
      threadId: 'native-thread-1',
      timeoutMs: 1_000,
      request: { action: 'set', objective: 'Ship Phase C', status: 'active' },
    }),
    /authoritative_native_goal_response_invalid/,
  );
});
