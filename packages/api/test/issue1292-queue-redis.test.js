import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';
import { privateInput, successorFixture } from './helpers/successor-routing-fixture.js';

// CI owns a portless fixture; the native Windows runner supplies its already isolated TCP child.
const isolated = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const owned = isolated ? null : ownedRedisFixture('issue1292-receipt');
async function fixture(t) {
  if (isolated) assertRedisIsolationOrThrow(process.env.REDIS_URL, 'issue1292 receipt');
  const prefix = `issue1292:${randomUUID()}:`;
  const redis = owned ? owned.client(prefix) : createRedisClient({ url: process.env.REDIS_URL, keyPrefix: prefix });
  await redis.ping();
  t.after(() => redis.quit());
  const ledger = new RedisQueueLedgerStore(redis);
  return { ...successorFixture(t, {}, ledger), redis };
}

test('Redis private receipt survives partial and full retirement, changed config and reopen', async (t) => {
  const h = await fixture(t);
  const input = privateInput(h.threadId, { targetCats: ['opus', 'codex'] });
  const admitted = await h.queue.enqueueDurable(input);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'partial', 200, 'opus-5');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'partial', 'processing', 201);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  const replay = await h.queue.enqueueDurable(input);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.entry.targets, ['codex']);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'last', 202, 'codex');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'last', 'processing', 203);
  const reopenedLedger = new RedisQueueLedgerStore(h.redis);
  const reopened = new InvocationQueue(reopenedLedger, {
    resolvePreResolvedTargets: () => assert.fail('receipt replay must not reroute'),
  });
  const retired = await reopened.enqueueDurable(input);
  assert.equal(retired.deduped, true);
  assert.deepEqual(retired.entries, []);
  await assert.rejects(reopened.enqueueDurable({ ...input, content: 'different work' }), /identity conflict/);
  assert.deepEqual(await reopenedLedger.list(h.threadId), []);
});

test('Redis base-shape receipt without requestedTargetCats remains compatible', async (t) => {
  const h = await fixture(t);
  const legacy = new InvocationQueue(h.ledger);
  const input = privateInput(h.threadId, { targetCats: ['codex'] });
  const admitted = await legacy.enqueueDurable(input);
  assert.equal(admitted.entry.payload.requestedTargetCats, undefined);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'old', 200, 'codex');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'old', 'processing', 201);
  getRoster().codex = { ...getRoster().codex, available: false };
  const replay = await h.queue.enqueueDurable(input);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.entries, []);
});

test('Redis visible-notice replay keeps the old receipt after its target retires', async (t) => {
  const h = await fixture(t);
  const messages = new RedisMessageStore(h.redis, { ttlSeconds: 0 });
  const input = privateInput(h.threadId);
  const notice = {
    from: input.from,
    userId: input.userId,
    threadId: h.threadId,
    content: 'notice',
    mentions: [],
    timestamp: 1,
    idempotencyKey: 'notice',
  };
  const admitted = await h.queue.enqueueDurableWithVisibleNotice(input, notice, messages);
  await h.ledger.claim(h.threadId, admitted.entry.id, 'notice', 200, 'opus-5');
  await h.ledger.commit(h.threadId, admitted.entry.id, 'notice', 'processing', 201);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  const replay = await h.queue.enqueueDurableWithVisibleNotice(input, notice, messages);
  assert.equal(replay.deduped, true);
  assert.equal(replay.notice.id, admitted.notice.id);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.equal((await messages.getByThread(h.threadId)).length, 1);
});

for (const format of ['confirmed', 'bundle', 'live']) {
  test(`Redis ${format} HTTP receipt survives pending, partial, retired and reopened storage`, async (t) => {
    const h = await fixture(t);
    const targets = format === 'live' ? ['opus-5'] : ['opus-5', 'codex'];
    const sources = new RedisMessageStore(h.redis, { ttlSeconds: 0 });
    const sourceThread = h.threads.create('owner', 'Source');
    const source = await sources.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: sourceThread.id,
      content: 'source',
      mentions: [],
      timestamp: 1,
    });
    const bundle = {
      sourceThreadId: sourceThread.id,
      note: 'original note',
      items: [{ kind: 'message', messageId: source.id }],
      targetCats: targets,
    };
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: {
        'x-cat-cafe-user': 'owner',
        ...(format === 'live' ? { 'x-cat-cafe-live-session': 'redis-call' } : {}),
      },
      payload: {
        threadId: h.threadId,
        content: format === 'bundle' ? '' : format === 'live' ? 'work' : '@opus-5 work',
        idempotencyKey: randomUUID(),
        ...(format === 'bundle'
          ? { messageBundle: bundle }
          : format === 'confirmed'
            ? { confirmedTargetCats: targets }
            : {}),
      },
    };
    let sourceId;
    let entryId;
    for (const stage of ['first', 'pending', 'partial', 'retired']) {
      // Recreate all persistence consumers, not only the process-local Queue cache.
      const ledger = new RedisQueueLedgerStore(h.redis);
      const messages = new RedisMessageStore(h.redis, { ttlSeconds: 0 });
      const queue = new InvocationQueue(ledger, {
        resolveTargets: (...args) => h.router.resolveSendTargets(...args),
        resolvePreResolvedTargets: (...args) => h.router.resolveAdmissionTargets(...args),
      });
      const app = Fastify();
      t.after(() => app.close());
      await app.register(messagesRoutes, {
        registry: new InvocationRegistry(),
        router: h.router,
        messageStore: messages,
        threadStore: h.threads,
        invocationQueue: queue,
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      });
      const response = await app.inject(request);
      assert.equal(response.statusCode, 202, `${stage}: ${response.body}`);
      if (stage === 'first') {
        sourceId = response.json().userMessageId;
        entryId = response.json().entryId;
        getRoster()['opus-5'] = { ...getRoster()['opus-5'], available: false, successor: 'codex' };
      }
      assert.equal(response.json().userMessageId, sourceId);
      assert.deepEqual((await messages.getById(sourceId)).mentions, format === 'live' ? [] : targets);
      const expected = stage === 'partial' ? targets.slice(1) : stage === 'retired' ? [] : targets;
      assert.deepEqual(
        (await ledger.list(h.threadId)).flatMap((row) => row.targets),
        expected,
      );
      const change =
        format === 'bundle'
          ? { messageBundle: { ...bundle, note: 'different note' } }
          : format === 'confirmed'
            ? { confirmedTargetCats: ['codex'] }
            : {
                contextAttachments: [
                  { v: 1, id: 'new-context', kind: 'thread', threadId: 'other', title: 'different context' },
                ],
              };
      const conflict = await app.inject({ ...request, payload: { ...request.payload, ...change } });
      assert.notEqual(conflict.statusCode, 202, conflict.body);
      assert.match(conflict.body, /identity conflict/);
      if (stage === 'pending') {
        const configs = catRegistry.getAllConfigs();
        catRegistry.reset();
        Object.entries(configs)
          .filter(([id]) => id !== 'opus-5')
          .forEach(([id, config]) => catRegistry.register(id, config));
      }
      if (stage === 'pending' || (stage === 'partial' && targets.length > 1)) {
        const target = stage === 'pending' ? 'opus-5' : 'codex';
        const claim = await ledger.claim(h.threadId, entryId, stage, 200, target);
        assert.equal(claim.outcome, 'claimed');
        await ledger.commit(h.threadId, entryId, stage, 'processing', 201);
      }
      await app.close();
    }
    assert.deepEqual(h.calls, []);
  });
}
