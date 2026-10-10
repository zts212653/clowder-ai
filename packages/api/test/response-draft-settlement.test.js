import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { lifecycleResponseIdempotencyKey, responseOutcomeForEndedTurn, settleResponseFromDraft } = await import(
  '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
);

const USER = 'user-1';
const THREAD = 'thread-1';

function appendProcessingResponse(store, invocationId, { content = '', lifecycleInvocationId = invocationId } = {}) {
  return store.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: USER,
    content,
    mentions: [],
    origin: 'stream',
    timestamp: 100,
    threadId: THREAD,
    idempotencyKey: lifecycleResponseIdempotencyKey(invocationId),
    extra: { stream: { invocationId: 'parent-1', turnInvocationId: invocationId } },
    lifecycle: {
      kind: 'response',
      orderKey: `100:${lifecycleInvocationId}`,
      invocationId: lifecycleInvocationId,
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
}

function upsertDraft(drafts, invocationId, overrides = {}) {
  return drafts.upsert({
    userId: USER,
    threadId: THREAD,
    invocationId,
    catId: 'opus',
    content: 'streamed so far',
    updatedAt: Date.now(),
    ...overrides,
  });
}

/**
 * Settles with a turn store. Without an explicit one, the turn is an ordinary unfenced child, whose
 * draft may be published; pass `null` to settle with no turn store at all.
 */
async function settle(store, drafts, emitted, input, turns) {
  const turnStore = turns === undefined ? await unfencedTurn(input.invocationId) : turns;
  return settleResponseFromDraft(
    {
      messageStore: store,
      draftStore: drafts,
      ...(turnStore ? { turnStore } : {}),
      emit: (userId, message) => emitted.push({ userId, message }),
    },
    { userId: USER, threadId: THREAD, status: 'failed', reason: 'execution_owner_lost', endedAt: 300, ...input },
  );
}

async function unfencedTurn(invocationId) {
  const turns = new InMemoryTurnExecutionStore();
  await endedTurn(turns, invocationId);
  return turns;
}

/** A child turn that has ended, so its terminal transition entered it in the response-pending ledger. */
async function endedTurn(
  turns,
  invocationId,
  terminal = { status: 'failed', endedAt: 200, terminalReason: 'x' },
  { outputFence } = {},
) {
  await turns.createRunning({
    invocationId,
    parentInvocationId: 'parent-1',
    threadId: THREAD,
    userId: USER,
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: 100,
    ...(outputFence ? { outputFence } : {}),
  });
  await turns.transitionTerminal(invocationId, terminal);
}

function pendingIds(turns) {
  return turns.listResponsePending().map((turn) => turn.invocationId);
}

describe('F117 KD-21 settleResponseFromDraft', () => {
  test('a processing R takes the streamed draft body with its terminal state, then the draft goes', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const response = await appendProcessingResponse(store, 'turn-1');
    const toolEvent = { id: 'tool-1', type: 'tool_use', label: 'Read', timestamp: 120 };
    await upsertDraft(drafts, 'turn-1', {
      content:
        'partial answer\n```cc_rich\n{"v":1,"blocks":[{"id":"b1","kind":"card","v":1,"title":"Summary","tone":"info"}]}\n```',
      toolEvents: [toolEvent, { unrelated: true }],
      thinking: 'weighing options',
    });
    const emitted = [];

    const settlement = await settle(store, drafts, emitted, {
      invocationId: 'turn-1',
      explanation: '执行进程归属已丢失',
    });

    assert.equal(settlement.kind, 'committed');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'failed');
    assert.equal(stored.lifecycle.reason, 'execution_owner_lost');
    assert.equal(stored.lifecycle.completedAt, 300);
    assert.equal(stored.content, 'partial answer\n\n执行进程归属已丢失');
    assert.deepEqual(stored.toolEvents, [toolEvent]);
    assert.equal(stored.thinking, 'weighing options');
    assert.deepEqual(stored.extra.stream, { invocationId: 'parent-1', turnInvocationId: 'turn-1' });
    assert.deepEqual(
      stored.extra.rich.blocks.map((block) => block.id),
      ['b1'],
    );
    assert.deepEqual(await drafts.getByThread(USER, THREAD), []);
    assert.deepEqual(
      emitted.map(({ userId, message }) => [userId, message.id, message.lifecycle.status]),
      [[USER, response.id, 'failed']],
    );
  });

  test('without a draft the R keeps its own body and the explanation is appended once', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const response = await appendProcessingResponse(store, 'turn-1', { content: 'own body\n\n执行控制面不可用' });

    const settlement = await settle(store, drafts, [], {
      invocationId: 'turn-1',
      status: 'interrupted',
      reason: 'process_restart',
      explanation: '执行控制面不可用',
    });

    assert.equal(settlement.kind, 'committed');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'interrupted');
    assert.equal(stored.content, 'own body\n\n执行控制面不可用');
  });

  test('an R that is already terminal keeps its body and only sheds the leftover draft', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const response = await appendProcessingResponse(store, 'turn-1');
    await store.commitLifecycleResponseTerminal(response.id, {
      invocationId: 'turn-1',
      status: 'completed',
      completedAt: 200,
      content: 'the committed answer',
      mentions: [],
    });
    await upsertDraft(drafts, 'turn-1', { content: 'an older partial' });
    const emitted = [];

    const settlement = await settle(store, drafts, emitted, { invocationId: 'turn-1' });

    assert.equal(settlement.kind, 'already_terminal');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'completed');
    assert.equal(stored.content, 'the committed answer');
    assert.deepEqual(await drafts.getByThread(USER, THREAD), []);
    assert.equal(emitted.length, 1);
  });

  test('a turn without a response R deletes its draft before it leaves the ledger (F117 KD-23)', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    await endedTurn(turns, 'turn-orphan');
    await upsertDraft(drafts, 'turn-orphan');
    const emitted = [];

    const settlement = await settle(store, drafts, emitted, { invocationId: 'turn-orphan' }, turns);

    assert.deepEqual(settlement, { kind: 'no_response' });
    assert.deepEqual(await drafts.getByThread(USER, THREAD), [], 'no R will take it, and drafts no longer expire');
    assert.deepEqual(pendingIds(turns), []);
    assert.equal(emitted.length, 0);
  });

  for (const [label, withResponse, firstKind] of [
    ['a committed R', true, 'committed'],
    ['a turn without a response R', false, 'no_response'],
  ]) {
    test(`${label}: a draft that cannot be deleted keeps the turn in the ledger for the next settlement (F117 KD-23)`, async () => {
      const store = new MessageStore();
      const drafts = new DraftStore();
      const turns = new InMemoryTurnExecutionStore();
      await endedTurn(turns, 'turn-1');
      if (withResponse) await appendProcessingResponse(store, 'turn-1');
      await upsertDraft(drafts, 'turn-1');
      const deleteDraft = drafts.delete.bind(drafts);
      let failures = 1;
      drafts.delete = (...args) => {
        if (failures-- > 0) throw new Error('redis unavailable');
        return deleteDraft(...args);
      };

      await assert.rejects(settle(store, drafts, [], { invocationId: 'turn-1' }, turns), /redis unavailable/);
      assert.deepEqual(pendingIds(turns), ['turn-1'], 'the turn stays for the next settlement');
      assert.equal((await drafts.getByThread(USER, THREAD)).length, 1);

      const retried = await settle(store, drafts, [], { invocationId: 'turn-1' }, turns);

      assert.equal(retried.kind, withResponse ? 'already_terminal' : firstKind);
      assert.deepEqual(await drafts.getByThread(USER, THREAD), []);
      assert.deepEqual(pendingIds(turns), []);
    });
  }

  test('a rejected commit throws and keeps the draft for whoever settles R next', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    // The admission key names turn-1 but the lifecycle belongs to another turn: the store refuses.
    const response = await appendProcessingResponse(store, 'turn-1', { lifecycleInvocationId: 'turn-other' });
    await upsertDraft(drafts, 'turn-1');
    const emitted = [];

    await assert.rejects(settle(store, drafts, emitted, { invocationId: 'turn-1' }), /invocation_mismatch/);

    assert.equal((await store.getById(response.id)).lifecycle.status, 'processing');
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 1);
    assert.equal(emitted.length, 0);
  });
  test('a settled R takes its ended turn out of the response-pending ledger', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    await endedTurn(turns, 'turn-1');
    await appendProcessingResponse(store, 'turn-1');
    await upsertDraft(drafts, 'turn-1');
    assert.deepEqual(pendingIds(turns), ['turn-1']);

    const settlement = await settle(store, drafts, [], { invocationId: 'turn-1' }, turns);

    assert.equal(settlement.kind, 'committed');
    assert.deepEqual(pendingIds(turns), []);
  });

  test('a rejected commit keeps the ended turn in the ledger for the next settlement pass', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    await endedTurn(turns, 'turn-1');
    await appendProcessingResponse(store, 'turn-1', { lifecycleInvocationId: 'turn-other' });
    await upsertDraft(drafts, 'turn-1');

    await assert.rejects(settle(store, drafts, [], { invocationId: 'turn-1' }, turns), /invocation_mismatch/);

    assert.deepEqual(pendingIds(turns), ['turn-1']);
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 1);
  });

  test('a turn that never opened a response R leaves the ledger', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    await endedTurn(turns, 'turn-guard');

    assert.deepEqual(await settle(store, drafts, [], { invocationId: 'turn-guard' }, turns), { kind: 'no_response' });
    assert.deepEqual(pendingIds(turns), []);
  });

  /** A fenced child whose draft holds output the fence may not have allowed. */
  async function fencedTurn(verdict) {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    await endedTurn(turns, 'turn-fenced', undefined, { outputFence: 'gated' });
    if (verdict) await turns.settleOutputFence('turn-fenced', verdict);
    const response = await appendProcessingResponse(store, 'turn-fenced');
    const toolEvent = { id: 'tool-1', type: 'tool_use', label: 'Read', timestamp: 120 };
    await upsertDraft(drafts, 'turn-fenced', {
      content: 'HIDDEN_ACTION_OUTPUT',
      thinking: 'hidden reasoning',
      toolEvents: [toolEvent],
    });
    return { store, drafts, turns, response, toolEvent };
  }

  test('a rejected output ends R empty as output_commit_rejected, whatever the caller asked for', async () => {
    const { store, drafts, turns, response } = await fencedTurn('rejected');

    const settlement = await settle(
      store,
      drafts,
      [],
      { invocationId: 'turn-fenced', status: 'failed', reason: 'execution_error', explanation: '执行出错' },
      turns,
    );

    assert.equal(settlement.kind, 'committed');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'interrupted');
    assert.equal(stored.lifecycle.reason, 'output_commit_rejected');
    assert.equal(stored.content, '');
    assert.equal(stored.thinking, undefined);
    assert.equal(stored.toolEvents, undefined);
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 0);
    assert.deepEqual(pendingIds(turns), []);
  });

  test('a rejected output stays unpublished when its commit fails and the draft is still there', async () => {
    const { store, drafts, turns, response } = await fencedTurn('rejected');
    const commit = store.commitLifecycleResponseTerminal.bind(store);
    store.commitLifecycleResponseTerminal = async () => {
      throw new Error('redis unavailable');
    };

    await assert.rejects(settle(store, drafts, [], { invocationId: 'turn-fenced' }, turns), /redis unavailable/);
    assert.equal((await store.getById(response.id)).lifecycle.status, 'processing');
    assert.equal((await drafts.getByThread(USER, THREAD))[0].content, 'HIDDEN_ACTION_OUTPUT');
    assert.deepEqual(pendingIds(turns), ['turn-fenced']);

    store.commitLifecycleResponseTerminal = commit;
    await settle(store, drafts, [], { invocationId: 'turn-fenced' }, turns);

    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.reason, 'output_commit_rejected');
    assert.equal(stored.content, '');
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 0);
  });

  test('a gated turn whose fence never decided keeps its draft unpublished', async () => {
    const { store, drafts, turns, response } = await fencedTurn();

    await settle(store, drafts, [], { invocationId: 'turn-fenced', explanation: '执行进程归属已丢失' }, turns);

    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'failed');
    assert.equal(stored.lifecycle.reason, 'execution_owner_lost');
    assert.equal(stored.content, '执行进程归属已丢失');
    assert.equal(stored.thinking, undefined);
    assert.equal(stored.toolEvents, undefined);
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 0);
  });

  test('an output the fence allowed is published like an unfenced one', async () => {
    const { store, drafts, turns, response, toolEvent } = await fencedTurn('allowed');

    await settle(store, drafts, [], { invocationId: 'turn-fenced' }, turns);

    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'failed');
    assert.equal(stored.content, 'HIDDEN_ACTION_OUTPUT');
    assert.equal(stored.thinking, 'hidden reasoning');
    assert.deepEqual(stored.toolEvents, [toolEvent]);
  });

  test('a draft whose fence cannot be read is withheld: no turn store, or no turn record', async () => {
    for (const turns of [null, new InMemoryTurnExecutionStore()]) {
      const store = new MessageStore();
      const drafts = new DraftStore();
      const response = await appendProcessingResponse(store, 'turn-unknown');
      await upsertDraft(drafts, 'turn-unknown', { content: 'output nobody vouched for' });

      await settle(store, drafts, [], { invocationId: 'turn-unknown' }, turns);

      assert.equal((await store.getById(response.id)).content, '');
    }
  });

  test('a later settlement pass ends R with the terminal truth of its ended turn', () => {
    const turn = { invocationId: 't', startedAt: 100, endedAt: 250 };
    assert.deepEqual(responseOutcomeForEndedTurn({ ...turn, status: 'failed', terminalReason: 'user_cancel' }), {
      status: 'failed',
      reason: 'user_cancel',
      endedAt: 250,
    });
    assert.deepEqual(responseOutcomeForEndedTurn({ ...turn, status: 'canceled', terminalReason: 'user_cancel' }), {
      status: 'canceled',
      reason: 'user_cancel',
      endedAt: 250,
    });
    assert.deepEqual(responseOutcomeForEndedTurn({ ...turn, status: 'interrupted' }), {
      status: 'interrupted',
      reason: 'process_restart',
      endedAt: 250,
    });
    // It succeeded, but its R never committed: the restart cut off the delivery.
    assert.deepEqual(responseOutcomeForEndedTurn({ ...turn, status: 'succeeded' }), {
      status: 'interrupted',
      reason: 'process_restart',
      endedAt: 250,
    });
    assert.equal(responseOutcomeForEndedTurn({ invocationId: 't', startedAt: 100, status: 'succeeded' }).endedAt, 100);
  });
});
