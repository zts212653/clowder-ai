import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { Redis } from 'ioredis';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { runDispatch, waitFor } from './helpers/issue1862-dispatch-fixture.js';
import { runPrestartFailure } from './helpers/issue1862-prestart-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
function isolatedClient(keyPrefix) {
  assertRedisIsolationOrThrow(redisUrl, 'Issue #1862');
  return createRedisClient({ url: redisUrl, keyPrefix });
}

async function redisFixture(t, redis, threadId) {
  return queueHttpFixture(t, {
    messageStore: new RedisMessageStore(redis, { ttlSeconds: 0 }),
    threadStore: new RedisThreadStore(redis, { ttlSeconds: 0 }),
    ledgerStore: new RedisQueueLedgerStore(redis),
    threadId,
  });
}

if (process.send && process.env.ISSUE1862_CRASH_FIXTURE) {
  const keyPrefix = process.env.ISSUE1862_CRASH_FIXTURE;
  const socket = process.env.ISSUE1862_REDIS_SOCKET;
  const redis = socket ? new Redis({ path: socket, keyPrefix }) : isolatedClient(keyPrefix);
  const f = await redisFixture({ after() {} }, redis);
  const commit = f.queue.terminalizeClaimedAdmissionFailure.bind(f.queue);
  f.queue.terminalizeClaimedAdmissionFailure = async (...args) => {
    const result = await commit(...args);
    assert.equal(result.kind, 'applied');
    const [, source, entry] = args;
    process.send(
      { threadId: source.threadId, sourceId: source.id, entryId: entry.id, failureId: result.failureMessage.id },
      () => process.exit(0),
    );
    await new Promise(() => {});
  };
  await runDispatch({ after() {} }, { f });
} else {
  const isolated = !redisIsolationSkipReason(redisUrl);
  const owned = !isolated && process.platform !== 'win32' ? ownedRedisFixture('issue1862-admission') : null;
  for (const processing of [false, true]) {
    test(
      `Redis prestart failure commits its result and caller wake together (processing=${processing})`,
      {
        skip: !isolated && !owned && 'Windows requires an isolated Redis runner',
      },
      async (t) => {
        const prefix = `issue1862:${randomUUID()}:`;
        const redis = owned ? owned.client(prefix) : isolatedClient(prefix);
        t.after(() => redis.disconnect());
        const f = await redisFixture(t, redis);
        const commit = f.messages.commitLifecyclePreAdmissionFailure.bind(f.messages);
        f.messages.commitLifecyclePreAdmissionFailure = async (input) => {
          if (!processing) {
            const withoutClaim = await commit({ ...input, claim: { ...input.claim, id: undefined } });
            assert.equal(withoutClaim.kind, 'conflict', 'a live ledger target cannot use retired-attempt settlement');
            assert.equal(
              (await f.queue.ledgerStore.list(f.thread.id)).filter((row) => row.sourceCategory === 'a2a_failure')
                .length,
              0,
            );
          }
          const result = await commit(input);
          assert.ok(result.kind === 'applied' || result.kind === 'replayed', JSON.stringify(result));
          const wakes = (await f.queue.ledgerStore.list(f.thread.id)).filter(
            (row) => row.sourceCategory === 'a2a_failure',
          );
          assert.equal(wakes.length, 1, 'the caller wake must exist when the Redis transaction returns');
          assert.equal(wakes[0].payload.sourceRecordId, result.failureMessage.id);
          return result;
        };
        const { outcome, source, entry, threadId } = await runPrestartFailure(t, {
          f,
          reason: 'prestart_timeout',
          processing,
        });
        assert.equal(outcome, 'retired');
        const recovered = new InvocationQueue(f.queue.ledgerStore);
        await recovered.hydrateFromLedger(f.messages);
        assert.equal(await recovered.getDurableEntry(threadId, entry.id), null);
        const [wake, ...duplicates] = await recovered.listAllDurable(threadId);
        assert.deepEqual(duplicates, []);
        assert.deepEqual(wake.targets, ['codex']);
        const [ref] = (await f.messages.getById(source.id)).lifecycle.dispatchRefs;
        assert.deepEqual(
          [ref.targetId, ref.phase, ref.statusMessageId],
          ['gemini', 'settled', wake.payload.sourceRecordId],
        );
        assert.equal(
          (await f.messages.getByThread(threadId)).filter((row) => row.lifecycle?.kind === 'delivery_failure').length,
          1,
        );
      },
    );
  }
  test(
    'API process loss after the atomic Redis write preserves the exact result and one caller turn',
    {
      skip: !isolated && !owned && 'Windows requires an isolated Redis runner',
    },
    async (t) => {
      const prefix = `issue1862:${randomUUID()}:`;
      const redis = owned ? owned.client(prefix) : isolatedClient(prefix);
      t.after(() => redis.disconnect());
      const child = fork(import.meta.filename, [], {
        execArgv: [],
        env: {
          ...process.env,
          ISSUE1862_CRASH_FIXTURE: prefix,
          ISSUE1862_REDIS_SOCKET: owned ? redis.options.path : '',
        },
      });
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      let receipt;
      child.once('message', (message) => {
        receipt = message;
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.ok(receipt);
      const { threadId, sourceId, entryId, failureId } = receipt;
      const f = await redisFixture(t, redis, threadId);
      const claimed = await f.queue.getDurableEntry(threadId, entryId);
      assert.equal(claimed.status, 'claimed', 'the first worker exited before retiring the original target');
      await f.queue.hydrateFromLedger(f.messages);
      assert.equal(await f.queue.getDurableEntry(threadId, entryId), null);
      assert.equal(await f.queue.markProcessingByIdDurable(threadId, entryId, 'gemini'), null);
      const [wake] = await f.queue.listAllDurable(threadId);
      assert.equal(wake.sourceCategory, 'a2a_failure');
      assert.deepEqual(wake.targets, ['codex']);
      assert.equal(wake.payload.sourceRecordId, failureId);

      const prompts = [];
      f.agents.get('codex').invoke = async function* (prompt, options) {
        prompts.push([prompt, options.systemPrompt].join('\n'));
        yield { type: 'text', catId: 'codex', content: 'Caller read the failure', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      };
      f.router.refreshFromRegistry(f.agents);
      const tracker = new InvocationTracker();
      const processor = new QueueProcessor({
        queue: f.queue,
        invocationTracker: tracker,
        invocationRecordStore: new InvocationRecordStore(),
        messageStore: f.messages,
        router: f.router,
        socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
        log: { info() {}, warn() {}, error() {} },
      });
      await processor.requestDrain(threadId);
      await waitFor(
        async () => !tracker.getActiveSlots(threadId).length && !(await f.queue.listAllDurable(threadId)).length,
      );
      await f.queue.hydrateFromLedger(f.messages);
      await processor.requestDrain(threadId);
      assert.equal(prompts.length, 1);
      assert.ok(
        prompts[0].includes(
          `${sourceId} → gemini: delivery_failure(execution_binding_conflict); response=${failureId}`,
        ),
      );
      const history = await f.messages.getByThread(threadId);
      assert.deepEqual(
        history.filter((row) => row.lifecycle?.kind === 'delivery_failure').map((row) => row.id),
        [failureId],
      );
      assert.equal(
        history.some((row) => row.lifecycle?.kind === 'response' && row.lifecycle.targetId === 'gemini'),
        false,
      );
      assert.deepEqual(await f.queue.listAllDurable(threadId), []);
    },
  );
}
