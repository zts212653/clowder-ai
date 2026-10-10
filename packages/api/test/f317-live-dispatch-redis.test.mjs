import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { RedisQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.ts';
import { settleLifecycleResponseInputs } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { RedisTurnExecutionStore } from '../src/domains/cats/services/stores/redis/RedisTurnExecutionStore.ts';
import { commitFailedResponseAndEnqueueA2ACaller } from '../src/routes/callback-a2a-trigger.ts';
import { failedResponseFixture } from './helpers/1398-failed-response-fixture.mjs';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('a2a-live-delivery');
for (const content of ['\n\nfailure explanation \n', '\n \t\n']) {
  test(
    'Redis normal failed transaction and lost settlement ack replays the exact durable snapshot: ' +
      JSON.stringify(content),
    async () => {
      const redis = owned.client('normal-failed-replay-' + randomUUID() + ':');
      const messages = new RedisMessageStore(redis);
      const turns = new RedisTurnExecutionStore(redis);
      const f = await failedResponseFixture({ messages, turns, ledger: new RedisQueueLedgerStore(redis) });
      try {
        await commitFailedResponseAndEnqueueA2ACaller(f.deps, {
          responseMessageId: f.response.id,
          invocationId: 'child',
          terminal: { status: 'failed', completedAt: 120, reason: 'provider_error' },
          message: {
            from: { kind: 'agent', catId: 'opus' },
            userId: 'owner',
            threadId: 'thread',
            content,
            mentions: [],
            timestamp: 110,
            replyTo: f.input.id,
            origin: 'stream',
            contentBlocks: [{ type: 'text', text: 'original block' }],
            toolEvents: [{ id: 'tool', type: 'tool_result', label: 'original tool', timestamp: 115 }],
            extra: { rich: { v: 1, blocks: [{ id: 'card', kind: 'card', v: 1, title: 'Original', tone: 'info' }] } },
            metadata: { provider: 'openai', model: 'original-model' },
            thinking: '\noriginal thinking\n',
          },
          userId: 'owner',
          threadId: 'thread',
          reporterCatId: 'opus',
          predecessorCatId: 'codex',
          ownerAuthProvenance: 'strict',
          parentInvocationId: 'parent',
        });
        const before = await messages.getById(f.response.id);
        assert.equal(before.content, content);
        assert.equal((await turns.listResponsePending()).length, 1);
        const restoredMessages = new RedisMessageStore(redis);
        const restoredQueue = new InvocationQueue(new RedisQueueLedgerStore(redis));
        await restoredQueue.hydrateFromLedger(restoredMessages);
        const outcome = await f
          .recovery({ messageStore: restoredMessages, queueOwner: restoredQueue })
          .reconcile({ processStartedAt: 200 });
        assert.deepEqual(outcome.responseSettlementFailures, []);
        assert.deepEqual(await restoredMessages.getById(f.response.id), before);
        assert.deepEqual(await turns.listResponsePending(), []);
        assert.equal((await restoredQueue.listAllDurable('thread')).length, 1);
        assert.equal((await restoredMessages.getByThread('thread', 30, 'owner')).length, 2);
      } finally {
        await redis.quit();
      }
    },
  );
}
for (const lostAcknowledgement of [false, true]) {
  test(
    'Redis failed child crash recovery retains exact result and one caller wake, lost ack=' + lostAcknowledgement,
    async () => {
      const redis = owned.client('failed-recovery-' + randomUUID() + ':');
      const messages = new RedisMessageStore(redis);
      const turns = new RedisTurnExecutionStore(redis);
      const ledger = new RedisQueueLedgerStore(redis);
      const f = await failedResponseFixture({ messages, turns, ledger });
      try {
        if (lostAcknowledgement) {
          await f
            .recovery({
              afterCommit: () => {
                throw new Error('lost acknowledgement');
              },
            })
            .reconcile({ processStartedAt: 200 });
          assert.equal((await turns.listResponsePending()).length, 1);
        }
        const restoredMessages = new RedisMessageStore(redis);
        const restoredQueue = new InvocationQueue(new RedisQueueLedgerStore(redis));
        await restoredQueue.hydrateFromLedger(restoredMessages);
        await f
          .recovery({ messageStore: restoredMessages, queueOwner: restoredQueue })
          .reconcile({ processStartedAt: 200 });
        const rows = await restoredQueue.listAllDurable('thread');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sourceCategory, 'a2a_failure');
        assert.deepEqual(rows[0].targets, ['codex']);
        assert.equal(rows[0].payload.messageId, f.response.id);
        assert.equal(rows[0].execution.ownerAuthProvenance, 'strict');
        assert.equal((await restoredMessages.getById(f.response.id)).lifecycle.status, 'failed');
        assert.deepEqual(await turns.listResponsePending(), []);
        await f
          .recovery({ messageStore: restoredMessages, queueOwner: restoredQueue })
          .reconcile({ processStartedAt: 200 });
        assert.equal((await restoredQueue.listAllDurable('thread')).length, 1);
        assert.equal((await restoredMessages.getByThread('thread', 30, 'owner')).length, 2);
      } finally {
        await redis.quit();
      }
    },
  );
}
for (const status of ['completed', 'failed', 'interrupted']) {
  test(
    'Redis crash after History commit recovers one exact Live result and only pending sibling: ' + status,
    async () => {
      const redis = owned.client('f317-delivery-' + randomUUID() + ':');
      const store = new RedisMessageStore(redis);
      const ledger = new RedisQueueLedgerStore(redis);
      const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' }, 'agent', {
        messageStore: store,
        ledgerStore: ledger,
        turnExecutionStore: new RedisTurnExecutionStore(redis),
      });
      try {
        const commit = store.commitLifecycleAppendAdmission.bind(store);
        const get = store.getById.bind(store);
        let unreadable = false;
        store.getById = async (id) => {
          if (unreadable) throw new Error('fixture read outage');
          return get(id);
        };
        store.commitLifecycleAppendAdmission = async (input) => {
          await commit(input);
          unreadable = true;
          throw new Error('fixture lost acknowledgement after durable commit');
        };
        assert.equal((await f.read()).statusCode, 503);
        assert.equal((await ledger.get('home', f.entry.id)).status, 'claimed');
        const restartedStore = new RedisMessageStore(redis);
        const restartedQueue = new InvocationQueue(new RedisQueueLedgerStore(redis));
        await restartedQueue.hydrateFromLedger(restartedStore);
        assert.deepEqual(
          restartedQueue.list('home', 'owner').map((e) => e.targets),
          [['kimi']],
        );
        const terminal = await restartedStore.commitLifecycleResponseTerminal(f.response.id, {
          invocationId: f.auth.invocationId,
          status,
          completedAt: Date.now(),
          content: status === 'completed' ? 'one exact result' : '',
          reason: 'fixture_' + status,
          extra: f.response.extra,
          mentions: [],
          origin: 'stream',
        });
        assert.equal(terminal.kind, 'applied');
        await settleLifecycleResponseInputs(restartedStore, terminal.message, f.response.id);
        await restartedQueue.hydrateFromLedger(restartedStore);
        const input = await restartedStore.getById(f.message.id);
        assert.equal(input.lifecycle.dispatchRefs.length, 1);
        assert.equal(input.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
        assert.equal(input.lifecycle.dispatchRefs[0].phase, 'settled');
        assert.equal(Object.hasOwn(input, 'queueCustody'), false);
        assert.deepEqual(
          restartedQueue.list('home', 'owner').map((e) => e.targets),
          [['kimi']],
        );
        const rows = await restartedStore.getByThread('home', 30, 'owner');
        assert.equal(rows.filter((m) => m.lifecycle?.kind === 'response').length, 1);
        assert.equal(rows.filter((m) => m.from.kind === 'system').length, 0);
        assert.equal(await redis.ttl('msg:' + f.message.id), -1);
        assert.equal(await redis.ttl('msg:' + f.response.id), -1);
        assert.equal(
          (await new RedisTurnExecutionStore(redis).get(f.auth.invocationId)).queueCompletionPolicy,
          'explicit_source',
        );
      } finally {
        await f.close();
        await redis.quit();
      }
    },
  );
}
