import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { settleChildResponse } from '../dist/domains/cats/services/agents/invocation/settle-child-response.js';
import { createZombieTerminalRecovery } from '../dist/domains/cats/services/agents/invocation/ZombieTerminalRecovery.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  commitFailedResponseAndEnqueueA2ACaller,
  commitRecoveredFailedResponse,
} from '../dist/routes/callback-a2a-trigger.js';
import { closeExecutionChildTurns } from '../dist/routes/queue-turn-closure.js';
import { crossThreadFailureStores, crossThreadResponseFixture } from './helpers/cross-thread-failure-fixture.mjs';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const kind of ['memory', 'redis']) {
  for (const cleanup of ['route', 'queue', 'zombie', 'closure']) {
    test(
      `${kind}: ${cleanup} cleanup cannot lose the atomic failed response and origin return`,
      {
        skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
      },
      async (t) => {
        const f = await crossThreadResponseFixture(t, kind);
        const enqueue = f.queue.enqueueDurable.bind(f.queue);
        const commit = f.messages.commitLifecycleResponseTerminalWithQueueLedgerAdmission.bind(f.messages);
        // Both entrances are faulted so this check detects the old non-atomic path too.
        f.queue.enqueueDurable = async () => {
          throw new Error('origin admission unavailable');
        };
        f.messages.commitLifecycleResponseTerminalWithQueueLedgerAdmission = (...args) => {
          assert.ok(
            args[2].some((row) => row.threadId === 'origin'),
            'origin must participate in terminal transaction',
          );
          throw new Error('origin admission unavailable');
        };
        await assert.rejects(
          commitFailedResponseAndEnqueueA2ACaller(f.deps, {
            responseMessageId: f.response.id,
            invocationId: 'child',
            terminal: { status: 'failed', completedAt: 120, reason: 'provider_error' },
            message: {
              from: f.response.from,
              userId: f.response.userId,
              threadId: f.response.threadId,
              content: 'provider network unavailable',
              mentions: [],
              timestamp: 110,
              replyTo: f.input.id,
            },
            userId: f.response.userId,
            threadId: f.response.threadId,
            reporterCatId: 'opus',
            predecessorCatId: 'codex',
            ownerAuthProvenance: 'strict',
          }),
          /origin admission unavailable/,
        );
        assert.equal(
          (await f.messages.getById(f.response.id)).lifecycle.status,
          'processing',
          'failed return admission cannot publish a terminal result',
        );
        assert.deepEqual(await f.queue.listAllDurable('origin'), []);
        assert.equal(f.turns.listResponsePending().length, 1);
        let draftDeleted = false;
        if (cleanup === 'route') {
          await settleChildResponse(
            { messageStore: f.messages, turnStore: f.turns },
            {
              invocationId: 'child',
              responseMessageId: f.response.id,
            },
          );
        } else if (cleanup === 'queue') {
          const processor = new QueueProcessor({
            queue: f.queue,
            messageStore: f.messages,
            turnExecutionStore: f.turns,
            invocationTracker: new InvocationTracker(),
            invocationRecordStore: new InvocationRecordStore(),
            router: {},
            socketManager: f.deps.socketManager,
            log: f.deps.log,
            draftStore: {
              delete: async () => {
                draftDeleted = true;
              },
            },
          });
          // The actual finalizer called by QueueProcessor's finally; no duplicate settlement logic.
          await processor.releaseSettledResponseTurn(await f.messages.getById(f.response.id), f.deps.log);
        }
        if (cleanup === 'zombie' || cleanup === 'closure') {
          const commitFailedResponse = (message, patch) => commitRecoveredFailedResponse(f.deps, message, patch);
          const turn = await f.turns.get('child');
          const settlement = {
            messageStore: f.messages,
            turnStore: f.turns,
            commitFailedResponse,
            draftStore: {
              get: async () => null,
              delete: async () => {
                draftDeleted = true;
              },
            },
          };
          if (cleanup === 'zombie') {
            await createZombieTerminalRecovery({
              queueProcessor: {
                onReconciledZombieComplete: async () => ({
                  recoveredCatIds: [],
                  replacementCatIds: [],
                  ownerStates: {},
                }),
              },
              log: f.deps.log,
              childResponses: {
                listChildTurns: () => [turn],
                settle: (child) =>
                  settleResponseFromDraft(settlement, {
                    userId: child.userId,
                    threadId: child.threadId,
                    invocationId: child.invocationId,
                    ...responseOutcomeForEndedTurn(child),
                  }),
              },
            })({ invocationId: 'parent', threadId: 'thread', userId: 'owner', catId: 'opus', targetCats: ['opus'] });
          } else {
            const result = await closeExecutionChildTurns(
              {
                messageStore: f.messages,
                turnExecutionStore: f.turns,
                draftStore: settlement.draftStore,
                commitFailedResponse,
                emit() {},
              },
              {
                executionId: 'parent',
                invocationId: 'child',
                threadId: 'thread',
                userId: 'owner',
                catId: 'opus',
                status: 'failed',
                reason: 'provider_error',
                endedAt: 120,
                onSettlementError() {},
              },
            );
            assert.deepEqual(result.unsettledInvocationIds, ['child']);
          }
        }
        assert.equal(draftDeleted, false, 'unfinished failure return cannot release its durable draft');
        assert.equal(
          f.turns.listResponsePending().length,
          1,
          'the still-processing response keeps its recovery obligation',
        );
        assert.equal((await f.turns.get('child')).responseSettlement, undefined);
        f.queue.enqueueDurable = enqueue;
        f.messages.commitLifecycleResponseTerminalWithQueueLedgerAdmission = commit;
        await f.recovery().reconcile({ processStartedAt: 200 });
        assert.equal((await f.messages.getById(f.response.id)).lifecycle.status, 'failed');
        assert.equal((await f.queue.listAllDurable('origin')).length, 1);
        assert.equal(f.turns.listResponsePending().length, 0);
        await f.recovery().reconcile({ processStartedAt: 300 });
        assert.equal(
          (await f.queue.listAllDurable('origin')).length,
          1,
          'normal cleanup recovery does not duplicate the return',
        );
      },
    );
  }
}

test('a failed private control turn without a caller receipt settles without creating another return', async (t) => {
  const f = await crossThreadFailureStores(t, 'memory');
  const turns = new InMemoryTurnExecutionStore();
  const response = await f.messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId: 'origin',
    replyTo: 'private-control-source-without-history',
    content: 'caller provider unavailable',
    mentions: [],
    timestamp: 100,
    lifecycle: {
      kind: 'response',
      orderKey: '100:control',
      invocationId: 'control-child',
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'failed',
      startedAt: 100,
      completedAt: 120,
    },
  });
  await turns.createRunning({
    invocationId: 'control-child',
    parentInvocationId: 'control-parent',
    userId: 'owner',
    threadId: 'origin',
    catId: 'codex',
    executionKind: 'ordinary',
    startedAt: 100,
  });
  await turns.transitionTerminal('control-child', { status: 'failed', endedAt: 120, terminalReason: 'provider_error' });
  const processor = new QueueProcessor({
    queue: f.queue,
    messageStore: f.messages,
    turnExecutionStore: turns,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: new InvocationRecordStore(),
    router: {},
    socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  await processor.releaseSettledResponseTurn(response, { warn() {} });
  assert.equal(turns.listResponsePending().length, 0, 'a control failure has no caller-return obligation to retain');
  assert.deepEqual(await f.queue.listAllDurable('origin'), [], 'failure reporting cannot bounce recursively');
});
