import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { commitFailedResponseAndEnqueueA2ACaller } from '../dist/routes/callback-a2a-trigger.js';

function failingService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'error',
        catId,
        content: 'configured model unavailable',
        error: 'configured model unavailable',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function depsFor(services) {
  let invocation = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocation}`, callbackToken: `tok-${invocation}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (input) => ({ id: `unbound-${invocation}`, ...input }),
      getById: async () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
    socketManager: { broadcastToRoom() {} },
  };
}

describe('provider failure returns through the durable response transaction', () => {
  for (const [name, file, exported] of [
    ['serial', 'route-serial', 'routeSerial'],
    ['parallel', 'route-parallel', 'routeParallel'],
  ]) {
    test(`${name}: each failed provider response persists and enqueues only its exact predecessor`, async () => {
      const { [exported]: route } = await import(`../dist/domains/cats/services/agents/routing/${file}.js`);
      const messageStore = new MessageStore();
      const invocationQueue = new InvocationQueue(new InMemoryQueueLedgerStore());
      let availabilityChecks = 0;
      const triggerDeps = {
        messageStore,
        invocationQueue,
        queueProcessor: { requestDrain: async () => {}, registerCallerDispatchInitialTargets() {} },
        socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
        log: { info() {}, warn() {}, error() {} },
        routingDispatchPreflight: {
          preflight: async () => {
            availabilityChecks++;
            throw new Error('must not check availability');
          },
        },
      };
      const reports = [];
      const services = {
        bengal: failingService('bengal'),
        lihua: failingService('lihua'),
      };

      for await (const _event of route(
        depsFor(services),
        ['bengal', 'lihua'],
        'ideate from Fable',
        'owner-1',
        'thread-a2a-parallel-failure',
        {
          ownerAuthProvenance: 'strict',
          a2aTriggerMessageId: 'source-from-fable',
          a2aCallerCatId: 'fable',
          parentInvocationId: 'parent-invocation',
          onLifecycleInvocationStarted: async ({ catId, invocationId, startedAt }) => {
            const response = messageStore.append({
              from: { kind: 'agent', catId },
              userId: 'owner-1',
              threadId: 'thread-a2a-parallel-failure',
              content: '',
              mentions: [],
              timestamp: startedAt,
              lifecycle: {
                kind: 'response',
                orderKey: `${startedAt}:${catId}`,
                targetId: catId,
                invocationId,
                inputEntryIds: [],
                inputMessageIds: ['source-from-fable'],
                status: 'processing',
                startedAt,
              },
            });
            return {
              responseMessageId: response.id,
              priorFrontierMessageId: null,
              activeRun: {
                threadId: 'thread-a2a-parallel-failure',
                targetId: catId,
                invocationId,
                responseMessageId: response.id,
                inputEntryIds: [],
                inputMessageIds: ['source-from-fable'],
                privateInputEntryIds: [],
                startedAt,
              },
            };
          },
          commitFailedA2AReport: async (input) => {
            reports.push(input);
            return commitFailedResponseAndEnqueueA2ACaller(triggerDeps, input);
          },
        },
      )) {
        // exhaust both failed children
      }

      assert.deepEqual(
        reports
          .map(({ reporterCatId, predecessorCatId }) => ({ reporterCatId, predecessorCatId }))
          .sort((left, right) => left.reporterCatId.localeCompare(right.reporterCatId)),
        [
          { reporterCatId: 'bengal', predecessorCatId: 'fable' },
          { reporterCatId: 'lihua', predecessorCatId: 'fable' },
        ],
      );
      for (const report of reports) {
        assert.equal(report.terminal.status, 'failed');
        assert.equal(report.message.content, 'configured model unavailable');
        assert.equal(messageStore.getById(report.responseMessageId).lifecycle.status, 'failed');
        assert.equal(messageStore.getById(report.responseMessageId).content, report.message.content);
      }
      const rows = await invocationQueue.listAllDurable('thread-a2a-parallel-failure');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.deepEqual(row.targets, ['fable']);
        assert.equal(row.sourceCategory, 'a2a_failure');
        assert.equal(row.execution.a2aParentInvocationId, 'parent-invocation');
        assert.ok(reports.some((report) => report.responseMessageId === row.payload.messageId));
      }
      assert.equal(availabilityChecks, 0);
    });
  }
});
