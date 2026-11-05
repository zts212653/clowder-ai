import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLastUserMentions } from '../dist/domains/cats/services/agents/routing/last-user-mentions.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('routing-mention-boundary');
test('recipient projection preserves sender, visibility and cursor authority while default reads retain bodies', async () => {
  const redis = owned.client('routing-boundary:');
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const time = Date.now() - 60_000;
  const source = {
    connector: 'hold-ball',
    label: 'Hold Ball',
    icon: 'clock',
    meta: { managedHold: true, taskId: 'task', threadId: 'T', catId: 'opus' },
  };
  const rows = [
    { id: 'human', from: { kind: 'user', userId: 'owner' }, mentions: ['codex'] },
    { id: 'queued-human', deliveryStatus: 'queued', mentions: ['gemini'] },
    { id: 'queued-agent', catId: 'opus', deliveryStatus: 'queued' },
    { id: 'queued-briefing', catId: 'opus', deliveryStatus: 'queued', origin: 'briefing' },
    { id: 'external', from: { kind: 'external', connectorId: 'feed' }, catId: 'opus' },
    { id: 'legacy-external', source: { connector: 'feed', label: 'Feed', icon: 'message' } },
    { id: 'invalid-source', source: '{invalid' },
    { id: 'legacy-plugin', lifecycle: { from: { kind: 'plugin', instanceId: 'pi-test' } } },
    { id: 'system', userId: 'system' },
    { id: 'hold-owner', from: { kind: 'system', service: 'hold-ball' }, source, extra: { scheduler: {} } },
    {
      id: 'hold-hidden',
      from: { kind: 'system', service: 'hold-ball' },
      source,
      extra: { scheduler: { hiddenTrigger: true } },
    },
    { id: 'hold-foreign', userId: 'other', from: { kind: 'system', service: 'hold-ball' }, source },
    {
      id: 'receipt',
      extra: {
        collectiveOwnerAdmissionV1: {
          v: 1,
          sourceRef: 'message:source',
          catId: 'codex',
          ownerAuthProvenance: 'strict',
        },
      },
    },
    { id: 'invalid-receipt', extra: { collectiveOwnerAdmissionV1: null } },
    {
      id: 'extra-body',
      extra: { rich: { v: 1, blocks: [{ kind: 'card', v: 1, id: 'card', title: 'extra payload '.repeat(4096) }] } },
    },
    { id: 'whisper', visibility: 'whisper', whisperTo: ['opus'] },
    {
      id: 'recalled',
      deliveryStatus: 'canceled',
      _tombstone: '1',
      recall: { version: 1, exposure: 'seen', recalledAt: time },
    },
    { id: 'deleted', deletedAt: String(time) },
    { id: 'foreign', userId: 'other' },
  ];
  for (const row of rows) {
    const raw = {
      id: row.id,
      threadId: 'T',
      userId: 'owner',
      catId: '',
      mentions: ['opus'],
      timestamp: String(time),
      deliveryStatus: 'delivered',
      content: 'full-body-canary',
      contentBlocks: [{ type: 'text', text: 'block-canary' }],
      ...row,
    };
    await redis.hset(
      `msg:${row.id}`,
      Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
      ),
    );
    await redis.zadd('msg:thread:T', time, row.id);
  }
  const fields = [
    'id',
    'from',
    'userId',
    'catId',
    'mentions',
    'timestamp',
    'deliveredAt',
    'timelineOrderAt',
    'deliveryStatus',
    'origin',
    'source',
    'sourceParseFailure',
    'lifecycle',
    'extra',
    'recall',
    '_tombstone',
    'visibility',
    'whisperTo',
  ];
  const authority = (page) => page.map((message) => Object.fromEntries(fields.map((field) => [field, message[field]])));
  for (const viewer of [undefined, 'owner', 'other']) {
    const options = {
      includeQueuedUserMessages: true,
      includeQueuedCatMessages: true,
      includeRecalledUserMessages: true,
    };
    const projected = { ...options, recipientProjection: true };
    const raw = await messages.getByThread('T', 100, viewer, options);
    const page = await messages.getByThread('T', 100, viewer, projected);
    assert.deepEqual(authority(page), authority(raw));
    assert.ok(raw.every((message) => message.content === 'full-body-canary' && message.contentBlocks?.length === 1));
    assert.ok(page.every((message) => message.content === '' && message.contentBlocks === undefined));
    if (viewer === 'owner') {
      assert.ok(page.some((message) => message.id === 'hold-owner'));
      assert.ok(!page.some((message) => ['hold-hidden', 'hold-foreign', 'foreign', 'deleted'].includes(message.id)));
      assert.equal(
        page.find((message) => message.id === 'receipt').extra.collectiveOwnerAdmissionV1.sourceRef,
        'message:source',
      );
      assert.equal(page.find((message) => message.id === 'invalid-receipt').extra.collectiveAuthorizationInvalid, true);
    }
    for (const state of ['present', 'deleted', 'rescored']) {
      if (state === 'deleted') await redis.zrem('msg:thread:T', 'legacy-plugin');
      if (state === 'rescored') await redis.zadd('msg:thread:T', time + 1000, 'legacy-plugin');
      assert.deepEqual(
        authority(await messages.getByThreadBefore('T', time, 5, 'legacy-plugin', viewer, projected)),
        authority(await messages.getByThreadBefore('T', time, 5, 'legacy-plugin', viewer, options)),
        `exclusive cursor remains equivalent when ${state}`,
      );
    }
    await redis.zadd('msg:thread:T', time, 'legacy-plugin');
  }
});

test('recipient history rejects failed, missing or malformed Redis projection replies instead of choosing an older cat', async () => {
  const redis = owned.client('routing-failure:');
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  await redis.hset('msg:human', { id: 'human', threadId: 'T', userId: 'owner', timestamp: '1', mentions: '["codex"]' });
  await redis.zadd('msg:thread:T', 1, 'human');
  const multi = redis.multi.bind(redis);
  try {
    for (const corrupt of [
      () => null,
      () => [],
      () => [[new Error('read unavailable'), null]],
      () => [[null, []]],
      (results) => [[null, results[0][1].map((value, index) => (index === 0 ? 123 : value))]],
    ]) {
      redis.multi = (...args) => {
        const transaction = multi(...args);
        const exec = transaction.exec.bind(transaction);
        transaction.exec = async () => {
          return corrupt(await exec());
        };
        return transaction;
      };
      await assert.rejects(findLastUserMentions(messages, 'T'), /hydration/);
    }
  } finally {
    redis.multi = multi;
  }
  assert.deepEqual(
    await findLastUserMentions(messages, 'T'),
    ['codex'],
    'a subsequent read is fresh, without a cached fallback',
  );
});
