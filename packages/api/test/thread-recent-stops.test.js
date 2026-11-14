import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createThreadExecutionSituationSource, readRecentStops, selectRecentStops, RECENT_STOP_WINDOW_MS } =
  await import('../dist/domains/cats/services/agents/invocation/thread-execution-situation.js');
const { describeRecentStop } = await import('../dist/domains/cats/services/agents/routing/navigation-context.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);

const NOW = 1794576000000;
const record = (catId, status, endedAt, extra = {}) => ({
  invocationId: `${catId}-${endedAt}`,
  catId,
  status,
  endedAt,
  threadId: 'thread-a',
  userId: 'owner',
  executionKind: 'ordinary',
  ...extra,
});

async function endTurn(store, invocationId, threadId, catId, status, endedAt, terminalReason) {
  await store.createRunning({
    invocationId,
    parentInvocationId: `p-${invocationId}`,
    threadId,
    userId: 'owner',
    catId,
    executionKind: 'ordinary',
    startedAt: endedAt - 1,
  });
  await store.transitionTerminal(invocationId, { status, endedAt, ...(terminalReason ? { terminalReason } : {}) });
  await store.markResponseSettled(invocationId, { kind: 'no_response', reason: 'empty_turn', settledAt: endedAt });
}

describe('F337 selectRecentStops', () => {
  test('keeps each member’s latest ending only when it did not succeed', () => {
    const stops = selectRecentStops(
      [
        record('kimi31-pro', 'failed', NOW - 60_000, { terminalReason: 'host_sleep' }),
        record('codex61-sol', 'failed', NOW - 50_000, { terminalReason: 'provider_execution_failed' }),
        record('codex61-sol', 'succeeded', NOW - 10_000),
        record('gemini-argon', 'canceled', NOW - 20_000, { terminalReason: 'user_cancel' }),
      ],
      NOW,
    );
    assert.deepEqual(
      stops.map((stop) => [stop.catId, stop.status, stop.terminalReason]),
      [
        ['gemini-argon', 'canceled', 'user_cancel'],
        ['kimi31-pro', 'failed', 'host_sleep'],
      ],
    );
  });

  test('leaves out watchers and anything older than the window', () => {
    const stops = selectRecentStops(
      [
        record('codex61-sol', 'failed', NOW - 1_000, { executionKind: 'watcher' }),
        record('kimi31-pro', 'canceled', NOW - RECENT_STOP_WINDOW_MS - 1),
      ],
      NOW,
    );
    assert.deepEqual(stops, []);
  });

  // Review R4 (codex61-sol, PR #7038): no silent cap on how many members are listed.
  test('lists every member that stopped, not only the first few', () => {
    const cats = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const stops = selectRecentStops(
      cats.map((catId, index) => record(catId, 'canceled', NOW - index * 1_000, { terminalReason: 'user_cancel' })),
      NOW,
    );
    assert.equal(stops.length, cats.length);
  });
});

describe('F337 describeRecentStop', () => {
  test('promises a continuation only where one is scheduled', () => {
    const say = (status, terminalReason) => describeRecentStop({ catId: 'k', status, terminalReason, endedAt: 1 });
    assert.equal(say('failed', 'host_sleep'), '电脑睡眠打断，开盖后会自动接着做');
    assert.equal(say('failed', 'host_sleep_repeat'), '电脑睡眠打断；这一轮本身是被叫回来的，这次不再自动叫回');
    assert.equal(say('interrupted', 'process_restart'), 'runtime 重启打断，重启后会尝试自动叫回');
    assert.equal(say('canceled', 'user_cancel'), '被停止，不是失败；没人要你叫它就别再叫醒');
    assert.equal(say('failed', 'provider_execution_failed'), '失败（provider_execution_failed）');
  });
});

describe('F337 thread execution situation recent stops', () => {
  test('reads recent stops for the thread owner', async () => {
    const source = createThreadExecutionSituationSource({
      messageStore: { getById: async () => null },
      listActiveRuns: () => [],
      listRecentStops: async ({ threadId, userId }) => {
        assert.deepEqual([threadId, userId], ['thread-a', 'owner']);
        return {
          stops: [{ catId: 'kimi31-pro', status: 'canceled', terminalReason: 'user_cancel', endedAt: NOW }],
          complete: true,
        };
      },
    });
    const situation = await source.resolve('thread-a', 'owner');
    assert.deepEqual(situation.recentStops, [
      { catId: 'kimi31-pro', status: 'canceled', terminalReason: 'user_cancel', endedAt: NOW },
    ]);
    assert.equal(situation.recentStopsComplete, true);
  });

  // Review R5 (codex61-sol, PR #7038): private-only work is still work.
  test('a member already running private input is not described as stopped', async () => {
    const source = createThreadExecutionSituationSource({
      messageStore: { getById: async () => null },
      listActiveRuns: () => [
        {
          threadId: 'thread-a',
          targetId: 'kimi31-pro',
          invocationId: 'new-run',
          responseMessageId: 'new-r',
          inputEntryIds: ['private'],
          privateInputEntryIds: ['private'],
          inputMessageIds: [],
          startedAt: 1000,
        },
      ],
      listRecentStops: async () => ({
        stops: [{ catId: 'kimi31-pro', status: 'canceled', terminalReason: 'user_cancel', endedAt: 999 }],
        complete: true,
      }),
    });
    const situation = await source.resolve('thread-a', 'owner');
    assert.deepEqual(situation.recentStops, []);
    assert.deepEqual(situation.activeRuns, [], 'the private run is still not projected publicly');
  });

  test('unknown running state or unreadable stop history leaves recent stops absent', async () => {
    const unreadableRuns = createThreadExecutionSituationSource({
      messageStore: { getById: async () => null },
      listActiveRuns: () => {
        throw new Error('tracker unavailable');
      },
      listRecentStops: async () => ({ stops: [{ catId: 'k', status: 'canceled', endedAt: NOW }], complete: true }),
    });
    assert.equal('recentStops' in (await unreadableRuns.resolve('thread-a', 'owner')), false);

    const unreadableStops = createThreadExecutionSituationSource({
      messageStore: { getById: async () => null },
      listActiveRuns: () => [],
      listRecentStops: async () => {
        throw new Error('redis down');
      },
    });
    assert.equal('recentStops' in (await unreadableStops.resolve('thread-a', 'owner')), false);
    assert.equal('recentStops' in (await unreadableStops.resolve('thread-a')), false);
  });

  // Review R4 (codex61-sol, PR #7038): another busy thread cannot push this thread's stop out of view.
  test('the thread’s own newest turns are read, however busy other threads are', async () => {
    const store = new InMemoryTurnExecutionStore();
    await endTurn(store, 'just-canceled', 'thread-a', 'kimi31-pro', 'canceled', NOW - 60_000, 'user_cancel');
    for (let index = 0; index < 401; index += 1) {
      await endTurn(store, `other-${index}`, 'thread-b', 'codex61-sol', 'succeeded', NOW - 30_000 + index);
    }
    const records = await store.listRecentSettled({ userId: 'owner', threadId: 'thread-a', limit: 100 });
    assert.deepEqual(
      selectRecentStops(records, NOW).map((stop) => stop.catId),
      ['kimi31-pro'],
    );
  });
});

// Review R4-round2 (codex61-sol, PR #7038): settlement order is not end-time order.
describe('F337 readRecentStops coverage', () => {
  test('a full page is incomplete even when its oldest entry is a late-settled old reply', async () => {
    const store = new InMemoryTurnExecutionStore();
    await endTurn(store, 'kimi-cancel', 'thread-a', 'kimi31-pro', 'canceled', NOW - 60_000, 'user_cancel');
    await endTurn(store, 'opus-yesterday', 'thread-a', 'opus', 'succeeded', NOW - 86_400_000);
    for (let index = 0; index < 99; index += 1) {
      await endTurn(store, `opus-now-${index}`, 'thread-a', 'opus', 'succeeded', NOW - 1_000 + index);
    }
    const read = await readRecentStops(store, { threadId: 'thread-a', userId: 'owner' }, NOW);
    assert.equal(read.complete, false);
  });

  test('fewer turns than a page is complete', async () => {
    const store = new InMemoryTurnExecutionStore();
    await endTurn(store, 'kimi-cancel', 'thread-a', 'kimi31-pro', 'canceled', NOW - 60_000, 'user_cancel');
    const read = await readRecentStops(store, { threadId: 'thread-a', userId: 'owner' }, NOW);
    assert.deepEqual(
      read.stops.map((stop) => stop.catId),
      ['kimi31-pro'],
    );
    assert.equal(read.complete, true);
  });
});

// Review R3 (codex61-sol, PR #7038): the outbound receipt carries the recorded reason.
describe('F337 outbound receipt stop reason', () => {
  async function receiptFor(status, reason) {
    const source = {
      id: 's',
      threadId: 't',
      userId: 'u',
      from: { kind: 'agent', catId: 'opus' },
      content: '请验证',
      timestamp: 1,
      lifecycle: {
        kind: 'input',
        orderKey: '1:s',
        dispatchRefs: [{ targetId: 'kimi31-pro', phase: 'settled', statusMessageId: 'r', dispatchedAt: 2 }],
      },
    };
    const response = {
      id: 'r',
      threadId: 't',
      userId: 'u',
      from: { kind: 'agent', catId: 'kimi31-pro' },
      content: '部分正文',
      timestamp: 2,
      lifecycle: {
        kind: 'response',
        orderKey: '2:r',
        invocationId: 'inv-kimi',
        targetId: 'kimi31-pro',
        inputEntryIds: ['entry'],
        inputMessageIds: ['s'],
        status,
        startedAt: 2,
        completedAt: 3,
        ...(reason ? { reason } : {}),
      },
    };
    const registry = new CallerDispatchObservationRegistry();
    registry.registerPersistedSource(source, ['kimi31-pro']);
    const projection = await registry.project(
      { getById: async (id) => (id === 's' ? source : response) },
      { ownerId: 'u', threadId: 't', callerCatId: 'opus' },
    );
    return projection.prompt;
  }

  test('a canceled return says it was stopped, not failed', async () => {
    assert.match(await receiptFor('canceled', 'user_cancel'), /canceled; reason=user_cancel（被停止，不是失败/);
  });

  test('a sleep-cut return says the cat will continue after the lid opens', async () => {
    assert.match(
      await receiptFor('failed', 'HOST_SLEEP'),
      /failed; reason=HOST_SLEEP（电脑睡眠打断，开盖后会自动接着做）/,
    );
  });

  test('without a recorded reason nothing is invented', async () => {
    assert.match(await receiptFor('canceled', undefined), /- s → kimi31-pro: canceled; response=r/);
  });
});
