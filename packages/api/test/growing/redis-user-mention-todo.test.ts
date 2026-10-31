import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { appendMessage } from '../../src/domains/cats/services/stores/redis/redis-message-append.js';
import { canonicalTestMessageInput } from '../helpers/message-from-fixtures.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from '../helpers/redis-test-helpers.js';
import { registerMentionRestorationTests } from '../helpers/user-mention-restoration-contract.js';

const url = process.env.REDIS_URL;
let redis: ReturnType<typeof createRedisClient>;
let messages: RedisMessageStore;
const request = {
  userId: 'owner',
  catId: 'codex61-sol',
  threadId: 'f320',
  content: '@co-creator\n需要你安排重启，建议今天有空时更新；今天不答则继续运行旧版本。',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
};
before(async () => {
  assert.ok(url, 'run with the isolated Redis runner');
  assertRedisIsolationOrThrow(url, 'user-mention-todo');
  redis = createRedisClient({ url, keyPrefix: 'f322-user-mentions:' });
  await redis.ping();
  messages = new RedisMessageStore(redis);
});
beforeEach(async () => {
  await cleanupClientKeyspace(redis);
});
after(async () => {
  if (redis) {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  }
});

async function assertLegacyCompatibleSignalScores(threadId: string, expectedIds: string[]): Promise<void> {
  const rows = await redis.zrange(`msg:user-request-signals:owner:${threadId}`, 0, -1, 'WITHSCORES');
  assert.equal(rows.length % 2, 0);
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < rows.length; index += 2) {
    const id = rows[index];
    const score = rows[index + 1];
    assert.ok(id);
    assert.ok(score);
    entries.push([id, score]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    entries.map(([id]) => id),
    [...expectedIds].sort(),
  );
  assert.deepEqual(
    entries.map(([, score]) => score),
    expectedIds.map(() => '0'),
    'legacy Z*BYLEX readers require every signal member to use the same zero score',
  );
}

test('message persistence opens, updates one thread, and survives a new store instance without TTL', async () => {
  const first = await messages.append(canonicalTestMessageInput(request));
  assert.equal((await messages.listUserMentionRequests('owner'))[0]?.id, first.id);
  const next = await messages.append(canonicalTestMessageInput({ ...request, timestamp: 101 }));
  assert.deepEqual(
    (await messages.listUserMentionRequests('owner')).map((m) => m.id),
    [next.id],
  );
  const reloaded = new RedisMessageStore(redis);
  assert.deepEqual(
    (await reloaded.listUserMentionRequests('owner')).map((m) => m.id),
    [next.id],
  );
  for (const key of ['msg:user-requests:latest:owner', 'msg:user-requests:pending:owner', `msg:${next.id}`]) {
    assert.equal(await redis.ttl(key), -1);
  }
  await reloaded.append(canonicalTestMessageInput({ ...request, catId: null, mentionsUser: false, timestamp: 102 }));
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
  assert.deepEqual(
    (await messages.listHandledUserMentions('owner')).map((message) => message.id),
    [next.id],
  );
  assert.deepEqual((await messages.getUserMentionHandlingMetadata('owner'))[next.id], {
    reason: 'replied',
    handledAt: 102,
  });
});

test('durable read closes only the current @you source at or before its exact visibility boundary', async () => {
  const first = await messages.append(canonicalTestMessageInput(request));
  const boundary = await messages.append(
    canonicalTestMessageInput({ ...request, catId: 'codex61-sol', mentionsUser: false, timestamp: 101 }),
  );
  assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'f320', boundary.id, 555), true);
  assert.equal(await redis.hget('msg:user-requests:closed:owner', 'f320'), null);
  assert.equal(await redis.hget('msg:user-requests:handled-through:owner', 'f320'), boundary.id);
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
  assert.deepEqual((await messages.getUserMentionHandlingMetadata('owner'))[first.id], {
    reason: 'viewed',
    handledAt: 555,
  });

  const later = await messages.append(canonicalTestMessageInput({ ...request, timestamp: 102 }));
  assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'f320', boundary.id, 556), false);
  assert.deepEqual(
    (await messages.listUserMentionRequests('owner')).map((message) => message.id),
    [later.id],
  );
  assert.equal((await messages.getUserMentionHandlingMetadata('owner'))[later.id], undefined);
  assert.equal(await redis.ttl('msg:user-requests:handled-meta:owner'), -1);
  assert.equal(await redis.ttl('msg:user-requests:handled-through:owner'), -1);
});

for (const [scenario, readBeforeLaterCommit] of [
  ['read-before-later-commit', true],
  ['older-boundary-after-both-commits', false],
] as const) {
  test(`durable reads preserve later-visible lower-id @you requests — ${scenario}`, async () => {
    const threadId = `visibility-order-${scenario}`;
    const firstCommitted = await messages.append(
      canonicalTestMessageInput({
        ...request,
        threadId,
        content: '@co-creator first committed',
        timestamp: 200,
      }),
    );
    let laterVisible: Awaited<ReturnType<RedisMessageStore['append']>>;
    let handled: boolean;
    if (readBeforeLaterCommit) {
      handled = await messages.resolveUserMentionRequestFromRead('owner', threadId, firstCommitted.id, 1_000);
      assert.equal(
        await redis.hget('msg:user-requests:latest:owner', threadId),
        null,
        'read closure must not leave an id frontier that an older binary could use to swallow a later lower id',
      );
      laterVisible = await messages.append(
        canonicalTestMessageInput({
          ...request,
          threadId,
          content: '@co-creator later visible',
          timestamp: 100,
        }),
      );
      assert.equal(handled, true);
      assert.deepEqual(
        (await messages.listHandledUserMentions('owner')).map((message) => message.id),
        [firstCommitted.id],
      );
    } else {
      laterVisible = await messages.append(
        canonicalTestMessageInput({
          ...request,
          threadId,
          content: '@co-creator later visible',
          timestamp: 100,
        }),
      );
      await redis.hset('msg:user-requests:latest:owner', threadId, firstCommitted.id);
      await redis.zadd(`msg:user-request-signals:owner:${threadId}`, 0, laterVisible.id, 0, firstCommitted.id);
      handled = await messages.resolveUserMentionRequestFromRead('owner', threadId, firstCommitted.id, 1_000);
      assert.equal(handled, false);
      assert.deepEqual(await messages.listHandledUserMentions('owner'), []);
    }

    assert.ok(laterVisible.id < firstCommitted.id, 'fixture requires message-id order to oppose commit order');
    const firstPosition = Number(await redis.zscore(`msg:visibility:${threadId}`, firstCommitted.id));
    const laterPosition = Number(await redis.zscore(`msg:visibility:${threadId}`, laterVisible.id));
    assert.ok(laterPosition > firstPosition, 'fixture requires the later commit to have the later visibility position');
    assert.deepEqual(
      (await messages.listUserMentionRequests('owner')).map((message) => message.id),
      [laterVisible.id],
    );
  });
}

test('old handled actions cannot close the replacement; handled state survives reload and new mentions reopen', async () => {
  const first = await messages.append(canonicalTestMessageInput(request));
  const next = await messages.append(canonicalTestMessageInput({ ...request, timestamp: 101 }));
  assert.equal(await messages.resolveUserMentionRequest('other', 'f320', next.id), false);
  assert.equal(await messages.resolveUserMentionRequest('owner', 'f320', first.id), false);
  assert.equal(await messages.resolveUserMentionRequest('owner', 'f320', next.id), true);
  assert.equal(await redis.hget('msg:user-requests:closed:owner', 'f320'), next.id);
  assert.equal(await redis.hget('msg:user-requests:handled-through:owner', 'f320'), null);
  assert.equal((await messages.getUserMentionHandlingMetadata('owner'))[next.id]?.reason, 'ignored');
  assert.deepEqual(await new RedisMessageStore(redis).listUserMentionRequests('owner'), []);
  await messages.augmentStreamMetadata(next.id, { mentionsUser: true });
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
  await messages.append(canonicalTestMessageInput({ ...request, timestamp: 102 }));
  assert.equal((await messages.listUserMentionRequests('owner')).length, 1);
});

test('all append paths and callback metadata replacement publish requests at persistence', async () => {
  await messages.append(canonicalTestMessageInput(request));
  await messages.appendAndObservePriorFrontier(canonicalTestMessageInput({ ...request, threadId: 'observed' }));
  await appendMessage({
    redis,
    message: canonicalTestMessageInput({ ...request, threadId: 'legacy' }),
    ttlSeconds: null,
    loadById: (id) => messages.getById(id),
  });
  const replacement = await messages.append(
    canonicalTestMessageInput({ ...request, threadId: 'replacement', mentionsUser: false }),
  );
  await messages.augmentStreamMetadata(replacement.id, { mentionsUser: true });
  assert.deepEqual((await messages.listUserMentionRequests('owner')).map((m) => m.threadId).sort(), [
    'f320',
    'legacy',
    'observed',
    'replacement',
  ]);
});

test('every signal writer preserves the equal-zero score invariant for legacy lex readers', async () => {
  const readBoundary = await messages.append(
    canonicalTestMessageInput({
      ...request,
      threadId: 'score-read',
      content: '@co-creator first visible',
      timestamp: 200,
    }),
  );
  const laterVisible = await messages.append(
    canonicalTestMessageInput({
      ...request,
      threadId: 'score-read',
      content: '@co-creator later visible',
      timestamp: 100,
    }),
  );
  await assertLegacyCompatibleSignalScores('score-read', [laterVisible.id, readBoundary.id]);
  assert.equal(await messages.resolveUserMentionRequestFromRead('owner', 'score-read', readBoundary.id, 300), false);
  await assertLegacyCompatibleSignalScores('score-read', [laterVisible.id, readBoundary.id]);

  const replySurvivor = await messages.append(
    canonicalTestMessageInput({ ...request, threadId: 'score-reply', timestamp: 400 }),
  );
  await messages.append(
    canonicalTestMessageInput({
      ...request,
      threadId: 'score-reply',
      catId: null,
      mentionsUser: false,
      timestamp: 350,
    }),
  );
  await assertLegacyCompatibleSignalScores('score-reply', [replySurvivor.id]);

  const bulk = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'score-bulk', timestamp: 500 }));
  const action = await messages.handleUserMentionRequests('owner', [{ threadId: bulk.threadId, messageId: bulk.id }]);
  assert.ok(action);
  assert.deepEqual(await messages.undoUserMentionHandling('owner', action.undoId), { restored: 1 });
  await assertLegacyCompatibleSignalScores('score-bulk', [bulk.id]);

  const single = await messages.append(
    canonicalTestMessageInput({ ...request, threadId: 'score-single', timestamp: 600 }),
  );
  assert.equal(await messages.resolveUserMentionRequest('owner', single.threadId, single.id), true);
  const revision = (await messages.getUserMentionStateRevisions('owner'))[single.threadId];
  assert.equal(await messages.restoreUserMentionRequest('owner', single.threadId, single.id, revision), true);
  await assertLegacyCompatibleSignalScores('score-single', [single.id]);
});

test('an older append or idempotent replay cannot reopen a replied thread; unrelated output does not close it', async () => {
  const first = await messages.append(canonicalTestMessageInput({ ...request, idempotencyKey: 'once' }));
  await messages.append(canonicalTestMessageInput({ ...request, mentionsUser: false, timestamp: 101 }));
  assert.equal((await messages.listUserMentionRequests('owner')).length, 1);
  await messages.append(canonicalTestMessageInput({ ...request, catId: null, mentionsUser: false, timestamp: 102 }));
  await messages.append(canonicalTestMessageInput({ ...request, idempotencyKey: 'once' }));
  await messages.append(canonicalTestMessageInput({ ...request, timestamp: 99 }));
  await messages.augmentStreamMetadata(first.id, { mentionsUser: true });
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
});

test('existing persisted flags migrate once, and a system receipt does not answer for the owner', async () => {
  const one = await messages.append(canonicalTestMessageInput(request));
  await messages.append(
    canonicalTestMessageInput({
      ...request,
      catId: null,
      mentionsUser: false,
      timestamp: 101,
      extra: { systemKind: 'a2a_routing' },
    }),
  );
  await redis.del(
    'msg:user-requests:latest:owner',
    'msg:user-requests:pending:owner',
    'msg:user-requests:version:owner',
  );
  assert.deepEqual(
    (await messages.listUserMentionRequests('owner')).map((m) => m.id),
    [one.id],
  );
  await messages.resolveUserMentionRequest('owner', 'f320', one.id);
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
});

test('corrupt projection is rejected before append writes and does not create a partially committed message', async () => {
  await redis.set('msg:user-requests:pending:owner', 'invalid');
  await assert.rejects(messages.append(canonicalTestMessageInput(request)), /USER_MENTION_INDEX_INVALID/);
  assert.equal(await redis.zcard('msg:user:owner'), 0);
});

test('legacy histories cross multiple migration batches without dropping the oldest unanswered request', async () => {
  const first = await messages.append(canonicalTestMessageInput(request));
  const write = redis.multi();
  for (let index = 0; index < 1005; index++) {
    const id = `${String(index + 200).padStart(13, '0')}-fixture`;
    write.hset(`msg:${id}`, {
      id,
      userId: 'owner',
      threadId: 'elsewhere',
      catId: 'codex61-sol',
      content: 'FYI',
      timestamp: String(index + 200),
    });
    write.zadd('msg:user:owner', index + 200, id);
  }
  await write.exec();
  await redis.del(
    'msg:user-requests:latest:owner',
    'msg:user-requests:pending:owner',
    'msg:user-requests:version:owner',
  );
  assert.deepEqual(
    (await messages.listUserMentionRequests('owner')).map((m) => m.id),
    [first.id],
  );
  assert.equal(await redis.get('msg:user-requests:version:owner'), '1');
});

test('history retains only outstanding explicit requests, newest first, across a mailbox page boundary', async () => {
  const old = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'oldest', timestamp: 1 }));
  for (let index = 0; index < 24; index++)
    await messages.append(canonicalTestMessageInput({ ...request, threadId: `old-${index}`, timestamp: index + 2 }));
  await messages.append(canonicalTestMessageInput({ ...request, threadId: 'answered', timestamp: 1 }));
  await messages.append(
    canonicalTestMessageInput({ ...request, catId: null, threadId: 'answered', mentionsUser: false, timestamp: 2 }),
  );
  await messages.append(canonicalTestMessageInput({ ...request, threadId: 'private', visibility: 'whisper' }));
  const newest = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'newest', timestamp: 1_000 }));
  await redis.del(
    'msg:user-requests:latest:owner',
    'msg:user-requests:pending:owner',
    'msg:user-requests:version:owner',
  );
  const rows = await messages.listUserMentionRequests('owner');
  assert.equal(rows.length, 26);
  assert.equal(rows[0]?.id, newest.id);
  assert.equal(rows.slice(20).at(-1)?.id, old.id);
});

test('canceling a newer queued request restores its predecessor without resurrecting answered or handled requests', async () => {
  const first = await messages.append(canonicalTestMessageInput(request));
  const queued = await messages.append(
    canonicalTestMessageInput({ ...request, timestamp: 101, deliveryStatus: 'queued' }),
  );
  await messages.markCanceled(queued.id);
  assert.equal((await messages.listUserMentionRequests('owner'))[0]?.id, first.id);
  assert.equal(await messages.resolveUserMentionRequest('owner', 'f320', first.id), true);
  const second = await messages.append(
    canonicalTestMessageInput({ ...request, timestamp: 102, deliveryStatus: 'queued' }),
  );
  await messages.markCanceled(second.id);
  assert.deepEqual(await new RedisMessageStore(redis).listUserMentionRequests('owner'), []);
});

test('soft deletion and restoration reindex the source without undoing its durable acknowledgement', async () => {
  const msg = await messages.append(canonicalTestMessageInput(request));
  await messages.softDelete(msg.id, 'owner');
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
  await messages.restore(msg.id);
  assert.equal((await messages.listUserMentionRequests('owner'))[0]?.id, msg.id);
  await messages.resolveUserMentionRequest('owner', 'f320', msg.id);
  await messages.softDelete(msg.id, 'owner');
  await messages.restore(msg.id);
  assert.deepEqual(await messages.listUserMentionRequests('owner'), []);
});

test('a late-delivered human reply fences older requests when the newer queued mention is canceled', async () => {
  await messages.append(canonicalTestMessageInput(request));
  const reply = await messages.append(
    canonicalTestMessageInput({
      ...request,
      catId: null,
      mentionsUser: false,
      timestamp: 101,
      deliveryStatus: 'queued',
    }),
  );
  const newer = await messages.append(
    canonicalTestMessageInput({ ...request, timestamp: 102, deliveryStatus: 'queued' }),
  );
  await messages.markDelivered(reply.id, 103);
  assert.equal((await messages.listUserMentionRequests('owner'))[0]?.id, newer.id);
  await messages.markCanceled(newer.id);
  assert.deepEqual(await new RedisMessageStore(redis).listUserMentionRequests('owner'), []);
});

test('cutover is persistent, legacy marks remain visible, and bulk undo survives reload without reopening replied requests', async () => {
  await messages.initializeUserMentionInbox(200);
  const old = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'old' }));
  await messages.resolveUserMentionRequest('owner', 'old', old.id);
  const a = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'a', timestamp: 201 }));
  const b = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'b', timestamp: 202 }));
  const result = await messages.handleUserMentionRequests('owner', [
    { threadId: 'a', messageId: a.id },
    { threadId: 'b', messageId: b.id },
  ]);
  assert.ok(result);
  assert.equal(result.handled, 2);
  const fresh = new RedisMessageStore(redis);
  assert.equal(await fresh.initializeUserMentionInbox(999), 200);
  assert.equal(await redis.ttl('msg:user-requests:cutover'), -1);
  assert.equal((await fresh.listHandledUserMentions('owner')).length, 3);
  await fresh.append(
    canonicalTestMessageInput({ ...request, threadId: 'a', catId: null, mentionsUser: false, timestamp: 203 }),
  );
  assert.equal((await fresh.listHandledUserMentions('owner')).length, 3);
  assert.equal(await fresh.undoUserMentionHandling('other', result.undoId), null);
  assert.deepEqual(await fresh.undoUserMentionHandling('owner', result.undoId), { restored: 1 });
  assert.deepEqual(
    (await fresh.listUserMentionRequests('owner')).map((m) => m.id),
    [b.id],
  );
  assert.equal(await fresh.undoUserMentionHandling('owner', result.undoId), null);
});

test('legacy v1 closed cat source is retained; stale bulk snapshot and invalid signal types perform zero writes', async () => {
  const one = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'one' }));
  const two = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'two' }));
  await messages.resolveUserMentionRequest('owner', 'one', one.id);
  await redis.del('msg:user-requests:handled:owner');
  assert.ok((await messages.listHandledUserMentions('owner')).some((m) => m.id === one.id));
  await redis.hdel('msg:user-requests:closed:owner', 'one');
  await redis.hdel('msg:user-requests:handled-through:owner', 'one');
  await redis.zadd('msg:user-requests:pending:owner', 0, 'one');
  await redis.zadd('msg:user-request-signals:owner:one', 0, one.id);
  const next = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'two', timestamp: 101 }));
  assert.equal(
    await messages.handleUserMentionRequests('owner', [
      { threadId: 'one', messageId: one.id },
      { threadId: 'two', messageId: two.id },
    ]),
    null,
  );
  assert.equal((await messages.listUserMentionRequests('owner')).length, 2);
  await redis.del('msg:user-request-signals:owner:two');
  await redis.set('msg:user-request-signals:owner:two', 'invalid');
  await assert.rejects(
    () =>
      messages.handleUserMentionRequests('owner', [
        { threadId: 'one', messageId: one.id },
        { threadId: 'two', messageId: next.id },
      ]),
    /USER_MENTION_INDEX_INVALID/,
  );
  assert.equal(await redis.hget('msg:user-requests:closed:owner', 'one'), null);
});

test('upgrade saves pre-existing v1 handled references before a human reply changes the close boundary', async () => {
  const original = await messages.append(canonicalTestMessageInput(request));
  await messages.resolveUserMentionRequest('owner', 'f320', original.id);
  await redis.del('msg:user-requests:handled:owner');
  await messages.initializeUserMentionInbox(200);
  await messages.append(canonicalTestMessageInput({ ...request, catId: null, mentionsUser: false, timestamp: 201 }));
  const fresh = new RedisMessageStore(redis);
  assert.deepEqual(
    (await fresh.listHandledUserMentions('owner')).map((m) => m.id),
    [original.id],
  );
  assert.equal((await redis.hget('msg:user-requests:closed:owner', 'f320')) === original.id, false);
  assert.equal(await redis.ttl('msg:user-requests:handled:owner'), -1);
});

registerMentionRestorationTests(() => new RedisMessageStore(redis));

test('invalid restored/revision/handled-through keys and revision values are rejected before canonical append writes', async () => {
  for (const kind of ['restored', 'revision', 'handled-through']) {
    await cleanupClientKeyspace(redis);
    await redis.set(`msg:user-requests:${kind}:owner`, 'invalid');
    await assert.rejects(() => messages.append(canonicalTestMessageInput(request)), /USER_MENTION_INDEX_INVALID/);
    assert.equal(await redis.zcard('msg:user:owner'), 0);
  }
  await cleanupClientKeyspace(redis);
  await redis.set('msg:user-requests:handled-meta:owner', 'invalid');
  await assert.rejects(() => messages.append(canonicalTestMessageInput(request)), /USER_MENTION_INDEX_INVALID/);
  assert.equal(await redis.zcard('msg:user:owner'), 0);
  for (const raw of ['invalid', '1e1', '01', '+1', '']) {
    await cleanupClientKeyspace(redis);
    await redis.hset('msg:user-requests:revision:owner', 'f320', raw);
    await assert.rejects(() => messages.append(canonicalTestMessageInput(request)), /USER_MENTION_REVISION_INVALID/);
    assert.equal(await redis.zcard('msg:user:owner'), 0);
  }
});

test('corrupt second-thread revision cannot partially handle or partially undo a batch', async () => {
  const a = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'a' }));
  const b = await messages.append(canonicalTestMessageInput({ ...request, threadId: 'b' }));
  const refs = [a, b].map((m) => ({ threadId: m.threadId, messageId: m.id }));
  const original = await redis.hget('msg:user-requests:revision:owner', 'b');
  await redis.hset('msg:user-requests:revision:owner', 'b', 'invalid');
  await assert.rejects(() => messages.handleUserMentionRequests('owner', refs), /USER_MENTION_REVISION_INVALID/);
  assert.equal(await redis.hget('msg:user-requests:closed:owner', 'a'), null);
  assert.equal(await messages.getLastUserMentionHandling('owner'), null);
  assert.ok(original);
  await redis.hset('msg:user-requests:revision:owner', 'b', original);
  const action = await messages.handleUserMentionRequests('owner', refs);
  assert.ok(action);
  const handledRevision = await redis.hget('msg:user-requests:revision:owner', 'b');
  await redis.hset('msg:user-requests:revision:owner', 'b', 'invalid');
  await assert.rejects(() => messages.undoUserMentionHandling('owner', action.undoId), /USER_MENTION_REVISION_INVALID/);
  assert.equal(await redis.hget('msg:user-requests:closed:owner', 'a'), a.id);
  await assert.rejects(() => messages.getLastUserMentionHandling('owner'), /USER_MENTION_REVISION_INVALID/);
  assert.equal(await redis.exists(`msg:user-requests:undo:owner:${action.undoId}`), 1);
  assert.ok(handledRevision);
  await redis.hset('msg:user-requests:revision:owner', 'b', handledRevision);
  assert.deepEqual(await messages.undoUserMentionHandling('owner', action.undoId), { restored: 2 });
});

test('restore stays removed from handled history after another store activation and all new state is persistent', async () => {
  const row = await messages.append(canonicalTestMessageInput(request));
  await messages.resolveUserMentionRequest('owner', row.threadId, row.id);
  const revision = (await messages.getUserMentionStateRevisions('owner'))[row.threadId];
  assert.equal(await messages.restoreUserMentionRequest('owner', row.threadId, row.id, revision), true);
  const reloaded = new RedisMessageStore(redis);
  await reloaded.initializeUserMentionInbox(0);
  assert.deepEqual(await reloaded.listHandledUserMentions('owner'), []);
  assert.deepEqual(
    (await reloaded.listUserMentionRequests('owner')).map((m) => m.id),
    [row.id],
  );
  for (const key of [
    'msg:user-requests:revision:owner',
    'msg:user-requests:restored:owner',
    'msg:user-requests:handled-migrated',
  ]) {
    assert.equal(await redis.ttl(key), -1);
  }
});
