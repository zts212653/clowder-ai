import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { withBallCustodyTaskEvents } from '../src/domains/ball-custody/BallCustodyTaskStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import { MessageKeys } from '../src/domains/cats/services/stores/redis-keys/message-keys.js';
import { TaskKeys } from '../src/domains/cats/services/stores/redis-keys/task-keys.js';
import { threadsRoutes } from '../src/routes/threads.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

test(
  'paged Works on Redis bounds raw rows, preserves timestamp ties/gallery items/tasks and omits top-level toolEvents',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'WorksPages');
    const redis = new Redis(process.env.REDIS_URL!, { keyPrefix: `works-pages-${process.pid}:` });
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const tasks = new RedisTaskStore(redis, { ttlSeconds: 0 });
    let custodyEvents = 0;
    const app = Fastify();
    const owner = 'works-owner';
    const now = Date.now() - 60_000;
    try {
      // Seed the original on-disk representation, including expensive fields a catalogue never needs.
      const pipeline = redis.pipeline();
      for (let index = 0; index < 700; index++) {
        const id = `m-${String(index).padStart(4, '0')}`;
        pipeline.hset(MessageKeys.detail(id), {
          id,
          threadId: 'T',
          userId: index < 50 ? 'foreign-owner' : owner,
          catId: index >= 650 ? '' : 'codex61-sol',
          timestamp: String(now),
          deliveryStatus: index >= 650 ? 'queued' : 'delivered',
          ...(index >= 600 && index < 650 ? { deletedAt: String(now + 1) } : {}),
          content: 'private conversation text '.repeat(1000),
          toolEvents: JSON.stringify([{ toolName: 'unused', input: 'unused tool trace '.repeat(1000) }]),
          thinking: 'private reasoning '.repeat(1000),
          extra: JSON.stringify({
            rich: { v: 1, blocks: [{ kind: 'file', v: 1, id, fileName: `${id}.pdf`, url: `/uploads/${id}.pdf` }] },
          }),
        });
        pipeline.zadd(MessageKeys.thread('T'), now, id);
      }
      const galleryId = 'n-gallery';
      pipeline.hset(MessageKeys.detail(galleryId), {
        id: galleryId,
        threadId: 'T',
        userId: owner,
        catId: 'codex61-sol',
        timestamp: String(now + 1),
        extra: JSON.stringify({
          rich: {
            v: 1,
            blocks: [
              {
                kind: 'media_gallery',
                v: 1,
                id: 'gallery',
                items: Array.from({ length: 1300 }, (_, index) => ({ url: `/uploads/gallery-${index}.png` })),
              },
            ],
          },
        }),
      });
      pipeline.zadd(MessageKeys.thread('T'), now + 1, galleryId);
      for (let index = 0; index < 140; index++) {
        const id = `task-${String(index).padStart(4, '0')}`;
        pipeline.hset(TaskKeys.detail(id), {
          id,
          threadId: 'T',
          userId: owner,
          kind: 'pr_tracking',
          subjectKey: `pr:org/repo#${index + 1}`,
          title: 'PR',
          ownerCatId: 'codex61-sol',
          status: 'doing',
          createdAt: String(now),
          updatedAt: String(now),
        });
        pipeline.zadd(TaskKeys.thread('T'), now, id);
      }
      await pipeline.exec();
      const originalPage = await messages.getByThreadBeforeBounded(
        'T',
        Number.MAX_SAFE_INTEGER,
        2,
        undefined,
        owner,
        2,
        { includeQueuedCatMessages: true, artifactProjection: true },
      );
      assert.equal(originalPage.messages.length, 1, JSON.stringify(originalPage));
      let rawReads = 0;
      const hydrate = messages['hydrateMessages'].bind(messages);
      messages['hydrateMessages'] = async (ids, options) => {
        rawReads += ids.length;
        assert.equal(options?.artifactOnly, true);
        const result = await hydrate(ids, options);
        assert.ok(result.every((message) => !message.content && !message.toolEvents && !message.thinking));
        return result;
      };
      await app.register(threadsRoutes, {
        threadStore: { list: async () => [{ id: 'T', title: 'Long thread', createdBy: owner }] },
        messageStore: messages,
        taskStore: withBallCustodyTaskEvents(tasks, {
          record: async () => {
            custodyEvents += 1;
          },
        }),
        artifactWorkLineage: { current: { resolve: async ({ artifacts }) => artifacts.map(() => undefined) } },
      });
      const coordinates = new Set<string>();
      let cursor: string | undefined;
      let firstCursor: string | undefined;
      let requests = 0;
      const started = performance.now();
      do {
        const before = rawReads;
        const response = await app.inject({
          method: 'GET',
          headers: { 'x-cat-cafe-user': owner },
          url: `/api/artifacts?view=works&read=pages${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        assert.ok(rawReads - before <= 128);
        assert.ok(body.artifacts.length <= 512);
        for (const row of body.artifacts) {
          const key = JSON.stringify([row.sourceMessageId, row.publicationItem, row.ref]);
          assert.ok(!coordinates.has(key), `duplicate ${key}`);
          coordinates.add(key);
        }
        cursor = body.nextCursor;
        if (!requests) firstCursor = cursor;
        requests++;
        assert.ok(requests < 30);
        if (!cursor) assert.equal(body.complete, true);
      } while (cursor);
      t.diagnostic(
        JSON.stringify({ requests, rawReads, total: coordinates.size, durationMs: performance.now() - started }),
      );
      assert.equal(coordinates.size, 550 + 1300 + 140);
      assert.equal(custodyEvents, 0, 'paged read must preserve custody mutation boundaries');
      const foreign = await app.inject({
        method: 'GET',
        headers: { 'x-cat-cafe-user': 'foreign-owner' },
        url: `/api/artifacts?view=works&read=pages&cursor=${encodeURIComponent(firstCursor!)}`,
      });
      assert.equal(foreign.statusCode, 400, 'cursor cannot carry another owner authority');
    } finally {
      await app.close();
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
