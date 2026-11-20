import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { createRedisClient, type RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from '../src/domains/concierge/concierge-keys.js';
import {
  type CompanionSceneAddress,
  type ICompanionSceneStore,
  MemoryCompanionSceneStore,
  RedisCompanionSceneStore,
} from '../src/domains/concierge/scene/companion-scene-store.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

// F336 Phase C U1: the living cat's scene archive. Both stores must agree on every rule.
const here: CompanionSceneAddress = { userId: 'owner', catId: 'opus', sceneId: 'desktop' };
const key = ConciergeKeys.companionScene(here.userId, here.catId, here.sceneId);
const first = {
  schemaVersion: 1 as const,
  pose: { name: 'loaf', x: 120.5, y: -3 },
  ball: { trail: [], at: { x: 1, y: 2 } },
  hat: {},
  paper: { strokes: [[{ x: 1, y: 2 }], []], frame: 14 },
};
const second = {
  schemaVersion: 1 as const,
  pose: { name: 'groom', x: 4, y: 5 },
  activity: { kind: 'groom', frame: 21 },
};

interface Raw {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

function sceneStoreContract(name: string, open: () => Promise<{ store: ICompanionSceneStore; raw: Raw }>) {
  describe(name, () => {
    test('absent scene reads as not_found, never as an error', async () => {
      const { store } = await open();
      assert.deepEqual(await store.get(here), { status: 'not_found' });
    });

    test('create, then compare-and-swap advances the revision by one', async () => {
      const { store, raw } = await open();
      assert.deepEqual(await store.put(here, { baseRevision: 0, snapshot: first }), { status: 'ok', revision: 1 });
      assert.deepEqual(await store.get(here), { status: 'found', revision: 1, updatedAt: 1000, snapshot: first });
      assert.deepEqual(JSON.parse((await raw.get(key)) ?? 'null'), { revision: 1, updatedAt: 1000, snapshot: first });
      assert.deepEqual(await store.put(here, { baseRevision: 1, snapshot: second }), { status: 'ok', revision: 2 });
      assert.deepEqual(await store.get(here), { status: 'found', revision: 2, updatedAt: 1000, snapshot: second });
    });

    test('a stale or missing base is a conflict that returns the current state and writes nothing', async () => {
      const { store, raw } = await open();
      assert.deepEqual(await store.put(here, { baseRevision: 3, snapshot: first }), {
        status: 'conflict',
        current: { status: 'not_found' },
      });
      assert.equal(await raw.get(key), null);
      await store.put(here, { baseRevision: 0, snapshot: first });
      await store.put(here, { baseRevision: 1, snapshot: second });
      const before = await raw.get(key);
      const current = { status: 'found', revision: 2, updatedAt: 1000, snapshot: second };
      assert.deepEqual(await store.put(here, { baseRevision: 1, snapshot: first }), { status: 'conflict', current });
      assert.deepEqual(await store.put(here, { baseRevision: 0, snapshot: first }), { status: 'conflict', current });
      assert.deepEqual(await store.put(here, { baseRevision: 7, snapshot: first }), { status: 'conflict', current });
      assert.equal(await raw.get(key), before);
    });

    test('two writers racing on one base: exactly one wins, the other sees the winner', async () => {
      const { store } = await open();
      await store.put(here, { baseRevision: 0, snapshot: first });
      const results = await Promise.all([
        store.put(here, { baseRevision: 1, snapshot: second }),
        store.put(here, { baseRevision: 1, snapshot: first }),
      ]);
      const winner = results.findIndex((result) => result.status === 'ok');
      assert.notEqual(winner, -1);
      assert.deepEqual(results[winner], { status: 'ok', revision: 2 });
      assert.deepEqual(results[1 - winner], {
        status: 'conflict',
        current: { status: 'found', revision: 2, updatedAt: 1000, snapshot: winner === 0 ? second : first },
      });
    });

    test('scenes are isolated by user, cat and scene', async () => {
      const { store } = await open();
      await store.put(here, { baseRevision: 0, snapshot: first });
      const neighbours = [
        { ...here, userId: 'someone-else' },
        { ...here, catId: 'codex' },
        { ...here, sceneId: 'other-scene' },
      ];
      for (const address of neighbours) assert.deepEqual(await store.get(address), { status: 'not_found' });
      assert.deepEqual(await store.put(neighbours[1], { baseRevision: 0, snapshot: second }), {
        status: 'ok',
        revision: 1,
      });
      assert.deepEqual(await store.get(here), { status: 'found', revision: 1, updatedAt: 1000, snapshot: first });
      assert.deepEqual(await store.get(neighbours[0]), { status: 'not_found' });
    });

    test('a damaged value reads as corrupt and survives every later write unchanged', async () => {
      const { store, raw } = await open();
      const damaged = [
        '{"revision":2,"updatedAt":',
        'null',
        '[1,2]',
        JSON.stringify({ revision: 2, updatedAt: 5, snapshot: { schemaVersion: 2 } }),
        JSON.stringify({ revision: 2, updatedAt: 5, snapshot: { schemaVersion: 1, surprise: true } }),
        JSON.stringify({ revision: 0, updatedAt: 5, snapshot: first }),
        JSON.stringify({ revision: '2', updatedAt: 5, snapshot: first }),
        JSON.stringify({ revision: 2, snapshot: first }),
      ];
      for (const value of damaged) {
        await raw.set(key, value);
        assert.deepEqual(await store.get(here), { status: 'error', reason: 'corrupt' }, value);
        // Revision 2 is what a damaged value claims; even that base must not overwrite it.
        for (const baseRevision of [0, 1, 2]) {
          assert.deepEqual(
            await store.put(here, { baseRevision, snapshot: first }),
            { status: 'conflict', current: { status: 'error', reason: 'corrupt' } },
            `${value} @ ${baseRevision}`,
          );
        }
        assert.equal(await raw.get(key), value);
      }
    });
  });
}

sceneStoreContract('MemoryCompanionSceneStore', async () => {
  const entries = new Map<string, string>();
  return {
    store: new MemoryCompanionSceneStore({ entries, now: () => 1000 }),
    raw: {
      set: async (name, value) => void entries.set(name, value),
      get: async (name) => entries.get(name) ?? null,
    },
  };
});

const redisUrl = process.env.REDIS_URL;
describe('RedisCompanionSceneStore', { skip: redisIsolationSkipReason(redisUrl) }, () => {
  const clients: RedisClient[] = [];
  const open = async () => {
    assertRedisIsolationOrThrow(redisUrl, 'RedisCompanionSceneStore');
    const redis = createRedisClient({ url: redisUrl, keyPrefix: `companion-scene-test:${randomUUID()}:` });
    clients.push(redis);
    return {
      redis,
      store: new RedisCompanionSceneStore(redis, { now: () => 1000 }),
      raw: {
        set: async (name: string, value: string) => void (await redis.set(name, value)),
        get: (name: string) => redis.get(name),
      },
    };
  };
  sceneStoreContract('contract', open);

  test('the scene key never carries a TTL, on create or on update', async () => {
    const { redis, store } = await open();
    await store.put(here, { baseRevision: 0, snapshot: first });
    assert.equal(await redis.ttl(key), -1);
    await store.put(here, { baseRevision: 1, snapshot: second });
    assert.equal(await redis.ttl(key), -1);
  });

  after(async () => {
    for (const redis of clients) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });
});

test('an unreachable Redis is an error, distinct from not_found and from a conflict', async () => {
  const down = {
    get: async () => {
      throw new Error('connection lost');
    },
    eval: async () => {
      throw new Error('connection lost');
    },
  } as unknown as RedisClient;
  const store = new RedisCompanionSceneStore(down);
  assert.deepEqual(await store.get(here), { status: 'error', reason: 'unavailable' });
  assert.deepEqual(await store.put(here, { baseRevision: 0, snapshot: first }), {
    status: 'error',
    reason: 'unavailable',
  });
});
