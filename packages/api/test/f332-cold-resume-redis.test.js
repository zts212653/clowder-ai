// @ts-check
/**
 * F332 / #1087 review P2: the stop-point scan must read the thread's own index
 * with the narrow artifact projection — never HGETALL every scanned message.
 * Runs only against an isolated Redis (scripts/run-isolated-redis-tests.mjs).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Redis from 'ioredis';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
const { resolveResumeStopPoint } = await import('../dist/domains/cats/services/agents/routing/resume-stop-point.js');

const HEAVY = ['content', 'thinking', 'toolEvents', 'metadata'];

test(
  'stop point scan stays thread-scoped and never hydrates full message payloads',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F332ColdResumeRedis');
    const redis = new Redis(/** @type {string} */ (process.env.REDIS_URL), {
      keyPrefix: `f332-resume-${process.pid}:`,
    });
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const payload = 'unused conversation '.repeat(2500);
    try {
      const request = await store.append({
        threadId: 'T',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        content: `@opus 帮我整理冷恢复需求 ${payload}`,
        mentions: ['opus'],
        timestamp: 1_000,
      });
      const reply = await store.append({
        threadId: 'T',
        userId: 'owner',
        from: { kind: 'agent', catId: 'opus' },
        content: `REPLY ${payload}`,
        mentions: [],
        origin: 'stream',
        timestamp: 1_001,
        lifecycle: {
          kind: 'response',
          orderKey: '1001:inv-redis',
          invocationId: 'inv-redis',
          targetId: 'opus',
          inputEntryIds: ['entry-redis'],
          inputMessageIds: [request.id],
          status: 'completed',
          startedAt: 1_001,
          completedAt: 1_001,
        },
      });
      // Heavy unrelated speech after the reply in the same thread, and a busy neighbour thread.
      for (let i = 0; i < 20; i++) {
        await store.append({
          threadId: 'T',
          userId: 'owner',
          from: { kind: 'agent', catId: 'codex' },
          content: `chatter ${i} ${payload}`,
          mentions: [],
          timestamp: 2_000 + i,
        });
      }
      for (let i = 0; i < 150; i++) {
        await store.append({
          threadId: 'NEIGHBOUR',
          userId: 'owner',
          from: { kind: 'user', userId: 'owner' },
          content: `neighbour ${i}`,
          mentions: [],
          timestamp: 3_000 + i,
        });
      }

      const send = redis.sendCommand.bind(redis);
      let fullHashes = 0;
      let projectedHashes = 0;
      redis.sendCommand = (command, ...args) => {
        if (command.name === 'hgetall') fullHashes++;
        if (command.name === 'hmget') {
          projectedHashes++;
          assert.ok(
            !command.args.some((field) => HEAVY.includes(String(field))),
            'projection omits heavy payload fields',
          );
        }
        return send(command, ...args);
      };

      const result = await resolveResumeStopPoint({
        messageStore: store,
        threadId: 'T',
        userId: 'owner',
        catId: 'opus',
        viewer: { type: 'cat', catId: /** @type {any} */ ('opus') },
      });
      redis.sendCommand = send;

      assert.equal(result.kind, 'found');
      assert.equal(result.stopPoint.responseMessageId, reply.id);
      assert.deepEqual(result.stopPoint.sourceMessageIds, [request.id]);
      assert.ok(projectedHashes >= 21, `scan used projected reads (${projectedHashes})`);
      assert.ok(
        fullHashes <= 1,
        `only the single source check may hydrate a full message; scanned rows must not (${fullHashes} full reads)`,
      );
    } finally {
      await cleanupClientKeyspace(redis);
      redis.disconnect();
    }
  },
);
