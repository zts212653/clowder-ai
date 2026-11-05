import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleResponseFromDraft } from '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { settleChildResponse } from '../dist/domains/cats/services/agents/invocation/settle-child-response.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { collectTaskExecutionCandidates } from '../dist/domains/growing/EntrustedWorkTaskExecutionCandidates.js';

async function ended() {
  const store = new InMemoryTurnExecutionStore();
  await store.createRunning({
    invocationId: 'child',
    parentInvocationId: 'parent',
    userId: 'u',
    threadId: 't',
    catId: 'codex',
    executionKind: 'ordinary',
    startedAt: 1,
  });
  await store.transitionTerminal('child', { status: 'succeeded', endedAt: 2 });
  return store;
}

test('a temporarily absent admitted reply never becomes an immutable empty turn', async () => {
  const store = await ended();
  let visible = false;
  const response = { id: 'R', userId: 'u', threadId: 't', extra: { turnExecution: { invocationId: 'child' } } };
  const deps = {
    turnStore: store,
    messageStore: { getById: async () => (visible ? response : null), getByIdempotencyKey: async () => null },
  };
  await settleChildResponse(deps, { invocationId: 'child', responseMessageId: 'R', noResponseReason: 'empty_turn' });
  assert.equal((await store.get('child')).responseSettlement, undefined);
  assert.equal((await store.listResponsePending()).length, 1);
  visible = true;
  await settleChildResponse(deps, { invocationId: 'child', responseMessageId: 'R' });
  assert.equal((await store.get('child')).responseSettlement.messageId, 'R');
});

test('startup cannot discard a draft or certify no-response from a temporary null read', async () => {
  const turns = await ended();
  let deleted = false;
  await assert.rejects(
    settleResponseFromDraft(
      {
        messageStore: { getByIdempotencyKey: async () => null },
        draftStore: {
          delete: async () => {
            deleted = true;
          },
        },
        turnStore: turns,
      },
      {
        userId: 'u',
        threadId: 't',
        invocationId: 'child',
        status: 'interrupted',
        reason: 'process_restart',
        endedAt: 2,
      },
    ),
    /response_admission_unconfirmed/,
  );
  assert.equal(deleted, false);
  assert.equal((await turns.get('child')).responseSettlement, undefined);
  assert.equal((await turns.listResponsePending()).length, 1);
});

test('different owner-certified empty reasons conflict instead of rewriting an audit fact', async () => {
  const store = await ended();
  await store.markResponseSettled('child', { kind: 'no_response', reason: 'empty_turn', settledAt: 3 });
  assert.equal(
    (await store.markResponseSettled('child', { kind: 'no_response', reason: 'tool_only', settledAt: 3 })).outcome,
    'conflict',
  );
});

test('a watcher without a queue parent cannot poison ordinary entrusted-work inspection', async () => {
  const parent = {
    id: 'ordinary-parent',
    userId: 'u',
    threadId: 't',
    targetCats: ['codex'],
    status: 'running',
    actionLeaseCarrier: { kind: 'action_successor', leaseId: 'lease', generation: 2 },
  };
  const reads = [];
  const input = {
    userId: 'u',
    lease: { leaseId: 'lease', generation: 2, holderThreadId: 't', holderCatIds: ['codex'] },
    invocationRecords: {
      listRunningByThread: async () => [parent],
      get: async (id) => {
        reads.push(id);
        return id === parent.id ? parent : null;
      },
    },
    turnExecutions: {
      listRunningByUser: async () => [
        {
          invocationId: 'observer',
          parentInvocationId: 'watcher:no-queue-parent',
          userId: 'u',
          threadId: 't',
          catId: 'codex',
          status: 'running',
          executionKind: 'watcher',
        },
        {
          invocationId: 'work',
          parentInvocationId: parent.id,
          userId: 'u',
          threadId: 't',
          catId: 'codex',
          status: 'running',
          executionKind: 'ordinary',
        },
      ],
    },
  };
  const result = await collectTaskExecutionCandidates(input);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(reads, [parent.id]);
  assert.equal([...result.candidates.values()][0].childInvocationId, 'work');
  input.turnExecutions.listRunningByUser = async () => [
    {
      invocationId: 'bad',
      parentInvocationId: 'missing',
      userId: 'u',
      threadId: 't',
      catId: 'codex',
      status: 'running',
      executionKind: 'ordinary',
    },
  ];
  assert.deepEqual(await collectTaskExecutionCandidates(input), {
    kind: 'failed',
    reason: 'execution_truth_unavailable',
  });
});
