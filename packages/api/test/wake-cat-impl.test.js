import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWakeCatFn } from '../dist/domains/cats/services/game/wakeCatImpl.js';

function createMockDeps() {
  const enqueuedEntries = [];
  const autoExecuteCalls = [];

  let enqueueResult = {
    outcome: 'enqueued',
    entry: { id: 'entry-1' },
    queuePosition: 1,
  };

  return {
    deps: {
      threadStore: {
        async get(threadId) {
          return { threadId, createdBy: 'user-landy', title: 'Game Thread' };
        },
      },
      invocationQueue: {
        enqueue(input) {
          enqueuedEntries.push(input);
          return enqueueResult;
        },
      },
      queueProcessor: {
        async tryAutoExecute(threadId) {
          autoExecuteCalls.push(threadId);
        },
      },
      log: {
        info() {},
        warn() {},
        error() {},
      },
    },
    enqueuedEntries,
    autoExecuteCalls,
    setEnqueueResult(result) {
      enqueueResult = result;
    },
  };
}

describe('createWakeCatFn', () => {
  it('enqueues cat in InvocationQueue with correct params', async () => {
    const { deps, enqueuedEntries } = createMockDeps();
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'thread-game-1', catId: 'opus', briefing: 'You are wolf.', timeoutMs: 45000 });

    assert.equal(enqueuedEntries.length, 1);
    const entry = enqueuedEntries[0];
    assert.equal(entry.threadId, 'thread-game-1');
    assert.equal(entry.userId, 'user-landy');
    assert.equal(entry.content, 'You are wolf.');
    assert.equal(entry.source, 'agent');
    assert.deepEqual(entry.targetCats, ['opus']);
    assert.equal(entry.intent, 'execute');
    assert.equal(entry.autoExecute, true);
  });

  it('does not write to messageStore (briefing only via queue)', async () => {
    const { deps, enqueuedEntries } = createMockDeps();
    assert.equal(deps.messageStore, undefined, 'WakeCatDeps should not have messageStore');
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'thread-game-1', catId: 'opus', briefing: 'Secret role info', timeoutMs: 45000 });

    assert.equal(enqueuedEntries.length, 1, 'should enqueue via InvocationQueue only');
  });

  it('triggers auto-execute after enqueue', async () => {
    const { deps, autoExecuteCalls } = createMockDeps();
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'thread-game-1', catId: 'opus', briefing: 'You are wolf.', timeoutMs: 45000 });

    assert.equal(autoExecuteCalls.length, 1);
    assert.equal(autoExecuteCalls[0], 'thread-game-1');
  });

  it('handles queue full gracefully (no crash, no auto-execute)', async () => {
    const { deps, autoExecuteCalls, setEnqueueResult } = createMockDeps();
    setEnqueueResult({ outcome: 'full' });
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'thread-game-1', catId: 'opus', briefing: 'You are wolf.', timeoutMs: 45000 });

    assert.equal(autoExecuteCalls.length, 0);
  });

  it('resolves userId from thread owner', async () => {
    const lookups = [];
    const { deps, enqueuedEntries } = createMockDeps();
    deps.threadStore = {
      async get(threadId) {
        lookups.push(threadId);
        return { threadId, createdBy: 'custom-user-123' };
      },
    };
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'thread-x', catId: 'gemini', briefing: 'Guard briefing', timeoutMs: 20000 });

    assert.equal(lookups.length, 1);
    assert.equal(lookups[0], 'thread-x');
    assert.equal(enqueuedEntries[0].userId, 'custom-user-123');
  });

  it('falls back to default-user when thread not found', async () => {
    const { deps, enqueuedEntries } = createMockDeps();
    deps.threadStore = {
      async get() {
        return null;
      },
    };
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'missing-thread', catId: 'opus', briefing: 'Brief', timeoutMs: 10000 });

    assert.equal(enqueuedEntries[0].userId, 'default-user');
  });

  it('handles second enqueue without crash', async () => {
    const { deps, autoExecuteCalls, setEnqueueResult } = createMockDeps();
    setEnqueueResult({ outcome: 'enqueued', entry: { id: 'entry-2' } });
    const wakeCat = createWakeCatFn(deps);

    await wakeCat({ threadId: 'thread-game-1', catId: 'codex', briefing: 'Seer briefing', timeoutMs: 30000 });

    assert.equal(autoExecuteCalls.length, 1, 'should auto-execute after enqueue');
  });
});
