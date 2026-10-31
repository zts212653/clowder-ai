import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../src/domains/cats/services/stores/redis-keys/message-keys.js';
import { createMessageReadDiagnostics } from '../src/infrastructure/message-read-diagnostics.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';

function returnedCodeUnits(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, child: unknown) => sum + returnedCodeUnits(child), 0);
  if (value && typeof value === 'object')
    return Object.values(value).reduce((sum: number, child: unknown) => sum + returnedCodeUnits(child), 0);
  return 0;
}

async function fixture() {
  const url = process.env.REDIS_URL;
  assert(url, 'Run with the isolated Redis runner');
  assertRedisIsolationOrThrow(url, 'custody source window');
  const redis = new Redis(url, { keyPrefix: `custody-window-${randomUUID()}:` });
  const keys = new Set<string>();
  const events: Parameters<Parameters<typeof createMessageReadDiagnostics>[0]['onEvent']>[0][] = [];
  const diagnostics = createMessageReadDiagnostics({ onEvent: (event) => events.push(event), minBatchMs: 0 });
  const store = new RedisMessageStore(redis, { ttlSeconds: 0, readDiagnostics: diagnostics });
  async function add(id: string, score: number, overrides: Record<string, string> = {}) {
    const detail = MessageKeys.detail(id);
    const index = MessageKeys.user('owner');
    keys.add(detail);
    keys.add(index);
    await redis.hset(detail, {
      id,
      userId: 'owner',
      threadId: 'thread',
      catId: '',
      content: 'source',
      timestamp: String(score),
      ...overrides,
    });
    await redis.zadd(index, score, id);
  }
  return {
    redis,
    store,
    events,
    add,
    async close() {
      diagnostics.stop();
      await redis.del(...keys);
      await redis.quit();
    },
  };
}

test('human source window preserves native human rows while avoiding cat payload transfer and decoding', async (t) => {
  const f = await fixture();
  try {
    await f.add('a-human', 1, {
      contentBlocks: JSON.stringify([{ type: 'text', text: 'Human source' }]),
      toolEvents: '[]',
      extra: '{"human":"retained"}',
    });
    const heavy = JSON.stringify([{ detail: 'cat-only-payload'.repeat(100_000) }]);
    await f.add('b-cat', 2, {
      catId: 'codex61-sol',
      toolEvents: heavy,
      extra: JSON.stringify({ rich: { payload: heavy } }),
    });
    let transferred = 0;
    const nativeMulti = f.redis.multi.bind(f.redis);
    t.mock.method(f.redis, 'multi', () => {
      const pipeline = nativeMulti();
      const nativeExec = pipeline.exec.bind(pipeline);
      t.mock.method(pipeline, 'exec', async () => {
        const result = await nativeExec();
        transferred += returnedCodeUnits(result);
        return result;
      });
      return pipeline;
    });
    const legacy = await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 5000);
    assert(transferred > 1_000_000);
    transferred = 0;
    const baseline = f.events.findLast((event) => event.kind === 'message_read_batch');
    assert(baseline && baseline.kind === 'message_read_batch');
    assert(baseline.parsers.toolEvents.inputCodeUnits > 1_000_000);
    f.events.length = 0;
    const narrowed = await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 5000, { humanOnly: true });
    assert.deepEqual(
      narrowed.messages.map((message) => message.id),
      ['a-human'],
    );
    assert.deepEqual(narrowed, { ...legacy, messages: legacy.messages.filter((message) => message.catId === null) });
    const witness = f.events.findLast((event) => event.kind === 'message_read_batch');
    assert(witness && witness.kind === 'message_read_batch');
    assert.equal(witness.parsers.toolEvents.inputCodeUnits, 2, 'excluded cat payload must never reach the parser');
    assert.equal(witness.parsers.extraHydration.inputCodeUnits, '{"human":"retained"}'.length);
    assert(transferred < 1000, 'native Redis reply must omit excluded cat body/tool/extra strings');
  } finally {
    await f.close();
  }
});

test('human filter is after the original raw candidate cap and preserves owner, deleted, queued and tied ordering', async () => {
  const f = await fixture();
  try {
    await f.add('a-cat', 10, { catId: 'sonnet' });
    await f.add('b-foreign', 10, { userId: 'foreign' });
    await f.add('c-deleted', 10, { deletedAt: '1' });
    await f.add('d-queued', 10, { deliveryStatus: 'queued' });
    await f.add('e-human', 10, { content: 'first eligible' });
    await f.add('f-human', 10, { content: 'outside raw cap' });
    for (const limit of [1, 4, 5, 6, 5000]) {
      const original = await f.store.listOwnerMessageWindowSlice('owner', 10, 10, limit);
      const narrowed = await f.store.listOwnerMessageWindowSlice('owner', 10, 10, limit, { humanOnly: true });
      assert.deepEqual(narrowed, {
        ...original,
        messages: original.messages.filter((message) => message.catId === null),
      });
    }
    const capped = await f.store.listOwnerMessageWindowSlice('owner', 10, 10, 4, { humanOnly: true });
    assert.equal(capped.hasMore, true);
    assert.deepEqual(capped.messages, []);
    await assert.rejects(
      f.store.listOwnerMessageWindowSlice('owner', 0, 10, 5001, { humanOnly: true }),
      /Invalid message window limit/,
    );
  } finally {
    await f.close();
  }
});

test('human filtering preserves canonical tolerant lifecycle decoding and deleted-row exclusion', async () => {
  const f = await fixture();
  try {
    await f.add('broken-cat', 1, { catId: 'sonnet', lifecycle: '{broken' });
    const malformed = await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 100);
    assert.equal(malformed.messages.length, 1);
    assert.equal(malformed.messages[0].lifecycle, undefined);
    assert.deepEqual(await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 100, { humanOnly: true }), {
      messages: [],
      hasMore: malformed.hasMore,
    });
    await f.redis.hdel(MessageKeys.detail('broken-cat'), 'lifecycle');
    const original = await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 100);
    assert.deepEqual(await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 100, { humanOnly: true }), {
      messages: [],
      hasMore: original.hasMore,
    });
    await f.redis.hset(MessageKeys.detail('broken-cat'), 'deletedAt', '1');
    assert.deepEqual(await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 100, { humanOnly: true }), {
      messages: [],
      hasMore: false,
    });
  } finally {
    await f.close();
  }
});

test('memory adapter preserves its existing cap and excludes only cat rows when requested', () => {
  const store = new MessageStore();
  store.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'agent', catId: 'sonnet' },
    content: 'cat',
    timestamp: 1,
  });
  store.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'user', userId: 'owner' },
    content: 'human',
    timestamp: 2,
  });
  const original = store.listOwnerMessageWindowSlice('owner', 0, 10, 1);
  assert.deepEqual(store.listOwnerMessageWindowSlice('owner', 0, 10, 1, { humanOnly: true }), {
    ...original,
    messages: [],
  });
});

test('unbounded human-source window keeps every eligible human and omits cat payloads', async () => {
  const f = await fixture();
  try {
    await f.add('a-human', 1, { toolEvents: '[]' });
    await f.add('b-cat', 2, { catId: 'sonnet', toolEvents: JSON.stringify([{ detail: 'cat'.repeat(400_000) }]) });
    const full = await f.store.listOwnerMessagesInWindow('owner', 0, 10);
    f.events.length = 0;
    const sources = await f.store.listOwnerMessagesInWindow('owner', 0, 10, { humanOnly: true });
    assert.deepEqual(
      sources.map((source) => source.id),
      ['a-human'],
    );
    assert.deepEqual(
      sources,
      full.filter((source) => source.catId === null),
    );
    const witness = f.events.findLast((event) => event.kind === 'message_read_batch');
    assert(witness && witness.kind === 'message_read_batch');
    assert.equal(witness.parsers.toolEvents.inputCodeUnits, 2);
    await f.redis.hset(MessageKeys.detail('b-cat'), 'lifecycle', '{broken');
    const malformedFull = await f.store.listOwnerMessagesInWindow('owner', 0, 10);
    assert.equal(malformedFull.find((message) => message.id === 'b-cat')?.lifecycle, undefined);
    assert.deepEqual(
      await f.store.listOwnerMessagesInWindow('owner', 0, 10, { humanOnly: true }),
      malformedFull.filter((message) => message.from.kind === 'user'),
    );
  } finally {
    await f.close();
  }
});

test('canonical from overrides legacy catId in the optimized Redis human window', async () => {
  const f = await fixture();
  try {
    await f.add('a-agent', 1, {
      from: JSON.stringify({ kind: 'agent', catId: 'sonnet' }),
      catId: '',
      toolEvents: 'x'.repeat(100000),
    });
    await f.add('b-system', 2, { from: JSON.stringify({ kind: 'system', service: 'scheduler' }), catId: '' });
    await f.add('c-human', 3, { from: JSON.stringify({ kind: 'user', userId: 'owner' }), catId: 'legacy-stale' });
    const page = await f.store.listOwnerMessageWindowSlice('owner', 0, 10, 2, { humanOnly: true });
    assert.deepEqual(page, { messages: [], hasMore: true });
    const all = await f.store.listOwnerMessagesInWindow('owner', 0, 10, { humanOnly: true });
    assert.deepEqual(
      all.map((message) => message.id),
      ['c-human'],
    );
  } finally {
    await f.close();
  }
});
