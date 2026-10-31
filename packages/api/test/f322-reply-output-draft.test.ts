import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { MessageOutputLayoutV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { type DraftRecord, DraftStore } from '../src/domains/cats/services/stores/ports/DraftStore.js';
import { RedisDraftStore } from '../src/domains/cats/services/stores/redis/RedisDraftStore.js';

// Hash/set wire operations only. No network or Redis server is involved.
class HashRedis {
  hashes = new Map<string, Record<string, string>>();
  sets = new Map<string, Set<string>>();
  expirations: number[] = [];
  persistentKeys = new Set<string>();

  async hget(key: string, field: string) {
    return this.hashes.get(key)?.[field] ?? null;
  }
  async hgetall(key: string) {
    return { ...this.hashes.get(key) };
  }
  async hset(key: string, fields: Record<string, string>) {
    this.hashes.set(key, { ...this.hashes.get(key), ...fields });
    return 1;
  }
  async hsetnx(key: string, field: string, value: string) {
    if (this.hashes.get(key)?.[field] !== undefined) return 0;
    return this.hset(key, { [field]: value });
  }
  async hdel(key: string, field: string) {
    const record = this.hashes.get(key);
    if (record) delete record[field];
    return 1;
  }
  async sadd(key: string, value: string) {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(value);
    this.sets.set(key, set);
    return 1;
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  async expire(_key: string, seconds: number) {
    this.expirations.push(seconds);
    return 1;
  }
  async persist(key: string) {
    this.persistentKeys.add(key);
    return 1;
  }
  multi() {
    const operations: Array<() => Promise<unknown>> = [];
    const pipeline = {
      hgetall: (key: string) => {
        operations.push(() => this.hgetall(key));
        return pipeline;
      },
      hset: (key: string, fields: Record<string, string>) => {
        operations.push(() => this.hset(key, fields));
        return pipeline;
      },
      hsetnx: (key: string, field: string, value: string) => {
        operations.push(() => this.hsetnx(key, field, value));
        return pipeline;
      },
      hdel: (key: string, field: string) => {
        operations.push(() => this.hdel(key, field));
        return pipeline;
      },
      sadd: (key: string, value: string) => {
        operations.push(() => this.sadd(key, value));
        return pipeline;
      },
      persist: (key: string) => {
        operations.push(() => this.persist(key));
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        operations.push(() => this.expire(key, seconds));
        return pipeline;
      },
      exec: async () => Promise.all(operations.map(async (operation) => [null, await operation()])),
    };
    return pipeline;
  }
}

const content = '过程。\n\n回答。';
const outputLayout: MessageOutputLayoutV1 = {
  v: 1,
  owner: { threadId: 'thread-one', catId: 'codex61-sol', turnInvocationId: 'child-turn' },
  contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
  status: 'available',
  runs: [
    {
      id: 'process',
      identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'process' },
      channel: 'commentary',
      complete: true,
      start: 0,
      end: 3,
      gluePrefixLength: 0,
    },
    {
      id: 'answer',
      identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'answer' },
      channel: 'final',
      complete: true,
      start: 3,
      end: 8,
      gluePrefixLength: 2,
    },
  ],
  order: [
    { kind: 'run', runId: 'process' },
    { kind: 'tool', toolEventId: 'tool-event-one', executionRef: 'child-turn' },
    { kind: 'run', runId: 'answer' },
  ],
};
const draft: DraftRecord & { extra: { outputLayout: MessageOutputLayoutV1 } } = {
  userId: 'user-one',
  threadId: 'thread-one',
  invocationId: 'child-turn',
  catId: 'codex61-sol' as DraftRecord['catId'],
  content,
  toolEvents: [{ id: 'tool-event-one', type: 'tool_use', label: 'Read', timestamp: 1 }],
  extra: { outputLayout },
  updatedAt: Date.now(),
};

test('the Redis draft wire preserves ordered output ranges across a fresh reader, like memory drafts', async () => {
  const memory = new DraftStore();
  memory.upsert(draft);
  const inMemory = memory.getByThread('user-one', 'thread-one')[0] as typeof draft;
  assert.deepEqual(inMemory.extra?.outputLayout, outputLayout);

  const redis = new HashRedis();
  await new RedisDraftStore(redis as unknown as RedisClient).upsert(draft);
  const restored = (
    await new RedisDraftStore(redis as unknown as RedisClient).getByThread('user-one', 'thread-one')
  )[0] as typeof draft;
  assert.equal(restored.content, content, 'the complete body stays the only stored body');
  assert.deepEqual(restored.toolEvents, draft.toolEvents);
  assert.deepEqual(restored.extra?.outputLayout, outputLayout);
  assert.deepEqual(redis.expirations, [], 'user-visible drafts have no automatic expiration');
  assert.equal(redis.persistentKeys.size, 2, 'both the owned draft and its thread index remain persistent');
});

test('unknown/legacy draft content remains whole and owner-scoped', async () => {
  const redis = new HashRedis();
  const store = new RedisDraftStore(redis as unknown as RedisClient);
  const { extra: _extra, ...legacy } = draft;
  await store.upsert(legacy);
  const restored = (await store.getByThread('user-one', 'thread-one'))[0] as typeof draft;
  assert.equal(restored.content, content);
  assert.equal(restored.extra?.outputLayout, undefined);
  assert.deepEqual(await store.getByThread('other-user', 'thread-one'), []);
});

test('a subsequent legacy snapshot clears stale layout on the existing draft hash', async () => {
  const redis = new HashRedis();
  const store = new RedisDraftStore(redis as unknown as RedisClient);
  await store.upsert(draft);
  const { extra: _extra, ...legacy } = draft;
  await store.upsert({ ...legacy, content: 'new whole body' });
  const restored = (await store.getByThread('user-one', 'thread-one'))[0];
  assert.equal(restored.content, 'new whole body');
  assert.equal(restored.extra?.outputLayout, undefined);
});
