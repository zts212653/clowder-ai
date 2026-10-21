import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { RedisTaskStore } from '../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import { TaskKeys } from '../src/domains/cats/services/stores/redis-keys/task-keys.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const mode of ['memory', 'redis'])
  for (const operation of ['updateEntrustedWork', 'closeEntrustedWork'] as const) {
    test(
      `${mode}: ${operation} checks thread condition inside its atomic mutation`,
      { skip: mode === 'redis' && redisIsolationSkipReason(process.env.REDIS_URL) },
      async (t) => {
        if (mode === 'redis') assertRedisIsolationOrThrow(process.env.REDIS_URL, 'task-thread-condition');
        const redis =
          mode === 'redis'
            ? new Redis(process.env.REDIS_URL!, { keyPrefix: `task-condition:${randomUUID()}:` })
            : undefined;
        if (redis) t.after(() => redis.quit());
        const store = redis ? new RedisTaskStore(redis) : new TaskStore();
        const { task } = await store.admitEntrustedWork({
          subjectKey: `entrusted:${randomUUID()}`,
          task: {
            userId: 'owner',
            threadId: 'thread',
            ownerCatId: 'codex',
            createdBy: 'user',
            title: 'Report',
            why: 'Report',
          },
          entrustedWork: {
            revision: 1,
            admission: {
              basis: 'authorized_source',
              sourceRefs: ['message:source'],
              authorityRef: 'message:admission',
              idempotencyKey: 'admission',
              receiptRef: 'receipt:admission',
              admittedAt: 1,
            },
            intendedOutcome: 'Report',
            time: {},
            artifactRefs: [],
            closure: { state: 'open', condition: 'accepted', expectedSignal: 'accepted', evidenceRefs: [] },
          },
        });
        const input = {
          expectedRevision: 1,
          expectedThreadId: 'other',
          artifactRefs: ['/uploads/report.md'],
          closure: {
            state: 'satisfied',
            condition: 'accepted',
            expectedSignal: 'accepted',
            evidenceRefs: ['artifact:report'],
          },
        };
        const before = structuredClone(await store.get(task.id));
        assert.equal((await store[operation](task.id, input as never)).kind, 'thread_conflict');
        assert.deepEqual(await store.get(task.id), before);
        if (!redis) return;
        const original = redis.eval.bind(redis);
        let raced = false;
        redis.eval = (async (...args: Parameters<typeof redis.eval>) => {
          if (!raced && /F310_(?:UPDATE|CLOSE)_ENTRUSTED_WORK/.test(String(args[0]))) {
            raced = true;
            await redis.hset(TaskKeys.detail(task.id), 'threadId', 'moved');
          }
          return original(...args);
        }) as typeof redis.eval;
        const result = await store[operation](task.id, { ...input, expectedThreadId: 'thread' } as never);
        assert.ok(raced);
        assert.equal(result.kind, 'thread_conflict');
        const after = await store.get(task.id);
        assert.equal(after?.entrustedWork?.revision, 1);
        assert.equal(after?.status, before?.status);
        assert.equal(after?.threadId, 'moved');
      },
    );
  }
