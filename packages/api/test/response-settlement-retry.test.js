import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { lifecycleResponseIdempotencyKey, responseOutcomeForEndedTurn, settleResponseFromDraft } = await import(
  '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
);
const { TurnExecutionStartupReconciler } = await import(
  '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
);
const { createZombieTerminalRecovery } = await import(
  '../dist/domains/cats/services/agents/invocation/ZombieTerminalRecovery.js'
);

const USER = 'user-retry';
const THREAD = 'thread-retry';
const PARENT = 'parent-retry';

/**
 * F117 KD-21 retry exit: an ended turn stays in the response-pending ledger until its R is confirmed
 * terminal, so every settlement that fails, and every crash between the turn's terminal write and
 * its R commit, is settled by the next startup. Real settlement, real in-memory stores.
 */
function world() {
  const messages = new MessageStore();
  const drafts = new DraftStore();
  const turns = new InMemoryTurnExecutionStore();
  const records = new InvocationRecordStore();
  return { messages, drafts, turns, records };
}

async function streamingTurn(
  { messages, drafts, turns },
  invocationId,
  startedAt,
  body,
  { outputFence, parentInvocationId = PARENT } = {},
) {
  await turns.createRunning({
    invocationId,
    parentInvocationId,
    threadId: THREAD,
    userId: USER,
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt,
    ...(outputFence ? { outputFence } : {}),
  });
  const response = await messages.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: USER,
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: startedAt,
    threadId: THREAD,
    idempotencyKey: lifecycleResponseIdempotencyKey(invocationId),
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${invocationId}`,
      invocationId,
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  // Fresh: the in-memory draft store still expires drafts 300 s after their last update.
  await drafts.upsert({
    userId: USER,
    threadId: THREAD,
    invocationId,
    catId: 'opus',
    content: body,
    updatedAt: Date.now(),
  });
  return response.id;
}

/** The message store with its next `times` terminal commits failing, as when Redis drops a write. */
function failingCommits(store, times) {
  let remaining = times;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'commitLifecycleResponseTerminal' && remaining > 0) {
        return async () => {
          remaining -= 1;
          throw new Error('redis unavailable');
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Production wiring: a later pass ends R with the ended turn's own terminal truth. */
function startup({ drafts, turns, records }, messageStore) {
  return new TurnExecutionStartupReconciler({
    store: turns,
    settleEndedTurnResponse: (turn) =>
      settleResponseFromDraft(
        { messageStore, draftStore: drafts, turnStore: turns, invocationRecords: records },
        {
          userId: turn.userId,
          threadId: turn.threadId,
          invocationId: turn.invocationId,
          ...responseOutcomeForEndedTurn(turn),
        },
      ),
  });
}

async function assertSettledFromDraft({ messages, drafts, turns }, responseId, expected) {
  const response = await messages.getById(responseId);
  assert.equal(response.lifecycle.status, expected.status);
  assert.equal(response.lifecycle.reason, expected.reason);
  assert.equal(response.content, expected.content);
  assert.equal((await drafts.getByThread(USER, THREAD)).length, 0);
  assert.deepEqual(turns.listResponsePending(), []);
}

describe('F117 KD-21 response settlement retry exit', () => {
  test('a settlement that fails at startup is retried by the next startup', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-a', 10, 'streamed before the restart');

    const first = await startup(w, failingCommits(w.messages, 1)).reconcile({ processStartedAt: 100 });
    assert.equal(first.interruptedCount, 1);
    assert.equal(first.settledResponseCount, 0);
    assert.deepEqual(first.responseSettlementFailures, [{ invocationId: 'turn-a', error: 'Error: redis unavailable' }]);
    assert.equal((await w.messages.getById(responseId)).lifecycle.status, 'processing');
    assert.equal((await w.drafts.getByThread(USER, THREAD)).length, 1);
    assert.deepEqual(
      w.turns.listResponsePending().map((turn) => turn.invocationId),
      ['turn-a'],
    );

    const second = await startup(w, w.messages).reconcile({ processStartedAt: 500 });
    assert.equal(second.interruptedCount, 0);
    assert.equal(second.settledResponseCount, 1);
    assert.deepEqual(second.responseSettlementFailures, []);
    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'process_restart',
      content: 'streamed before the restart',
    });
  });

  test('a turn that ended just before a crash, with its R still processing, settles at the next startup', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-b', 10, 'the full answer');
    // invoke-single-cat ended the turn; the route died before it committed R.
    await w.turns.transitionTerminal('turn-b', { status: 'succeeded', endedAt: 40 });

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.interruptedCount, 0);
    assert.equal(result.settledResponseCount, 1);
    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'process_restart',
      content: 'the full answer',
    });
  });

  test('a settlement that failed in the previous process is retried with the turn’s own terminal', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-d', 10, 'partial output');
    // The route threw; the turn ended failed, and the catch path's settlement of R failed.
    await w.turns.transitionTerminal('turn-d', {
      status: 'failed',
      endedAt: 40,
      terminalReason: 'provider_execution_failed',
    });

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.settledResponseCount, 1);
    await assertSettledFromDraft(w, responseId, {
      status: 'failed',
      reason: 'provider_execution_failed',
      content: 'partial output',
    });
  });

  test('a zombie reclaim that cannot settle R leaves it for the next startup', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-c', 10, 'streamed before the owner died');
    const warnings = [];
    const onZombie = createZombieTerminalRecovery({
      queueProcessor: {
        onReconciledZombieComplete: async () => ({ recoveredCatIds: [], replacementCatIds: [], ownerStates: {} }),
      },
      log: { info() {}, warn: (_obj, msg) => warnings.push(msg) },
      childResponses: {
        listChildTurns: (executionId) => w.turns.listByParent(executionId),
        settle: (turn) =>
          settleResponseFromDraft(
            { messageStore: failingCommits(w.messages, 1), draftStore: w.drafts, turnStore: w.turns },
            {
              userId: turn.userId,
              threadId: turn.threadId,
              invocationId: turn.invocationId,
              status: 'interrupted',
              reason: 'zombie_record_detected',
              endedAt: 50,
            },
          ),
      },
    });

    await onZombie({ invocationId: PARENT, threadId: THREAD, userId: USER, catId: 'opus', targetCats: ['opus'] });
    assert.equal(warnings.filter((msg) => msg.includes('could not settle')).length, 1);
    assert.equal((await w.messages.getById(responseId)).lifecycle.status, 'processing');

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.interruptedCount, 1);
    assert.equal(result.settledResponseCount, 1);
    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'process_restart',
      content: 'streamed before the owner died',
    });
  });

  test('an ended turn this process started is left for its live route to confirm', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-live', 150, 'still being committed');
    await w.turns.transitionTerminal('turn-live', { status: 'succeeded', endedAt: 160 });

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.settledResponseCount, 0);
    assert.equal((await w.messages.getById(responseId)).lifecycle.status, 'processing');
    assert.deepEqual(
      w.turns.listResponsePending().map((turn) => turn.invocationId),
      ['turn-live'],
    );
  });
});

describe('F117 KD-21 fenced output across settlement retries', () => {
  test('a rejection recorded just before a crash keeps the draft unpublished at the next startup', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-f1', 10, 'HIDDEN_ACTION_OUTPUT', { outputFence: 'gated' });
    await w.turns.transitionTerminal('turn-f1', {
      status: 'failed',
      endedAt: 40,
      terminalReason: 'provider_execution_failed',
    });
    // The fence rejected the output and the process died before anything else: no delete, no R commit.
    await w.turns.settleOutputFence('turn-f1', 'rejected');

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.settledResponseCount, 1);
    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'output_commit_rejected',
      content: '',
    });
  });

  test('a rejected output whose startup commit fails is still empty after the next startup', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-f2', 10, 'HIDDEN_ACTION_OUTPUT', { outputFence: 'gated' });
    await w.turns.transitionTerminal('turn-f2', { status: 'succeeded', endedAt: 40 });
    await w.turns.settleOutputFence('turn-f2', 'rejected');

    const first = await startup(w, failingCommits(w.messages, 1)).reconcile({ processStartedAt: 100 });
    assert.equal(first.responseSettlementFailures.length, 1);
    assert.equal((await w.drafts.getByThread(USER, THREAD))[0].content, 'HIDDEN_ACTION_OUTPUT');

    await startup(w, w.messages).reconcile({ processStartedAt: 500 });

    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'output_commit_rejected',
      content: '',
    });
  });

  test('a fenced turn that crashed before its fence decided keeps its draft unpublished', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-f3', 10, 'output nobody vouched for', { outputFence: 'gated' });
    // The turn ended; the route died before it asked the fence whether the output may commit.
    await w.turns.transitionTerminal('turn-f3', { status: 'succeeded', endedAt: 40 });

    await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    await assertSettledFromDraft(w, responseId, { status: 'interrupted', reason: 'process_restart', content: '' });
  });

  test('an exposed fenced failure keeps its streamed body through the retry', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-f4', 10, 'partial output', { outputFence: 'gated' });
    await w.turns.transitionTerminal('turn-f4', {
      status: 'failed',
      endedAt: 40,
      terminalReason: 'provider_execution_failed',
    });
    // The fence accepted the failure, so its output may be shown; the catch path's settlement then failed.
    await w.turns.settleOutputFence('turn-f4', 'allowed');

    await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    await assertSettledFromDraft(w, responseId, {
      status: 'failed',
      reason: 'provider_execution_failed',
      content: 'partial output',
    });
  });
});

describe('F117 KD-21 turns recorded before the output fence existed', () => {
  /** The previous release persisted the same record without the fence field. */
  function asLegacyRecord(turns, invocationId) {
    delete turns.records.get(invocationId).outputFence;
    assert.equal('outputFence' in turns.get(invocationId), false);
  }

  /** The invocation the queue created for a dispatch, recording whether it carried action custody. */
  function queueInvocation(records, actionLeaseCarrier) {
    return records.create({
      threadId: THREAD,
      userId: USER,
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: `queue-entry-${actionLeaseCarrier.kind}`,
      actionLeaseCarrier,
    }).invocationId;
  }

  test('a legacy turn of an action-fenced dispatch keeps its draft unpublished through the upgrade restart', async () => {
    const w = world();
    const parent = queueInvocation(w.records, { kind: 'action_successor', leaseId: 'lease-1', generation: 1 });
    const responseId = await streamingTurn(w, 'turn-old-fenced', 10, 'HIDDEN_ACTION_OUTPUT', {
      parentInvocationId: parent,
    });
    // The old process died mid-turn, before its fence had judged the output.
    asLegacyRecord(w.turns, 'turn-old-fenced');

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.interruptedCount, 1);
    assert.equal(result.settledResponseCount, 1);
    await assertSettledFromDraft(w, responseId, { status: 'interrupted', reason: 'process_restart', content: '' });
  });

  test('a legacy turn of an ordinary dispatch keeps its streamed body through the upgrade restart', async () => {
    const w = world();
    const parent = queueInvocation(w.records, { kind: 'none' });
    const responseId = await streamingTurn(w, 'turn-old-open', 10, 'the ordinary answer', {
      parentInvocationId: parent,
    });
    asLegacyRecord(w.turns, 'turn-old-open');

    const result = await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    assert.equal(result.settledResponseCount, 1);
    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'process_restart',
      content: 'the ordinary answer',
    });
  });

  test('a legacy turn that is its own parent had no dispatch to fence it', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-old-direct', 10, 'a direct answer', {
      parentInvocationId: 'turn-old-direct',
    });
    asLegacyRecord(w.turns, 'turn-old-direct');

    await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    await assertSettledFromDraft(w, responseId, {
      status: 'interrupted',
      reason: 'process_restart',
      content: 'a direct answer',
    });
  });

  test('a legacy turn whose parent invocation cannot be read stays gated', async () => {
    const w = world();
    const responseId = await streamingTurn(w, 'turn-old-orphan', 10, 'output nobody can vouch for', {
      parentInvocationId: 'parent-record-gone',
    });
    asLegacyRecord(w.turns, 'turn-old-orphan');

    await startup(w, w.messages).reconcile({ processStartedAt: 100 });

    await assertSettledFromDraft(w, responseId, { status: 'interrupted', reason: 'process_restart', content: '' });
  });

  test('a settlement without the invocation records withholds a legacy draft', async () => {
    const w = world();
    const parent = queueInvocation(w.records, { kind: 'none' });
    const responseId = await streamingTurn(w, 'turn-old-unwired', 10, 'the ordinary answer', {
      parentInvocationId: parent,
    });
    asLegacyRecord(w.turns, 'turn-old-unwired');

    await startup({ ...w, records: undefined }, w.messages).reconcile({ processStartedAt: 100 });

    await assertSettledFromDraft(w, responseId, { status: 'interrupted', reason: 'process_restart', content: '' });
  });
});
