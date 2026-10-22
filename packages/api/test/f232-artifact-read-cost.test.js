import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import Redis from 'ioredis';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
const { MessageKeys } = await import('../dist/domains/cats/services/stores/redis-keys/message-keys.js');

test(
  'complete artifact catalogues omit named top-level message fields and visit historical rows once',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'ArtifactReadCost');
    const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `artifact-cost-${process.pid}:` });
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const app = Fastify();
    const count = 1200;
    const timestamp = Date.now() - 60_000;
    const payload = 'unused conversation '.repeat(2400);
    try {
      // One publication-time group exercises the old cursor's repeated prefix scans.
      for (let start = 0; start < count; start += 100) {
        const seed = redis.pipeline();
        for (let index = start; index < start + 100; index++) {
          const id = `message-${String(index).padStart(4, '0')}`;
          seed.hset(MessageKeys.detail(id), {
            id,
            threadId: 'T',
            userId: index >= 1000 ? 'bob' : 'alice',
            catId: 'codex61-sol',
            timestamp: String(timestamp),
            deliveryStatus: 'delivered',
            ...(index === 998 ? { deletedAt: String(timestamp + 1) } : {}),
            ...(index === 997 ? { visibility: 'whisper', whisperTo: JSON.stringify(['other-cat']) } : {}),
            content: payload,
            thinking: payload,
            metadata: JSON.stringify({ unused: payload }),
            toolEvents: JSON.stringify([{ input: payload }]),
            extra: JSON.stringify({
              rich: { v: 1, blocks: [{ kind: 'file', v: 1, id, url: `/uploads/${id}.pdf`, fileName: `${id}.pdf` }] },
            }),
          });
          seed.zadd(MessageKeys.thread('T'), timestamp, id);
        }
        await seed.exec();
      }
      const thread = { id: 'T', title: 'Private history', createdBy: 'alice' };
      const stages = {};
      const timed =
        (stage, fn) =>
        async (...args) => {
          const start = performance.now();
          try {
            return await fn(...args);
          } finally {
            stages[stage] = (stages[stage] ?? 0) + performance.now() - start;
          }
        };
      for (const name of ['getByThread', 'getByThreadBefore'])
        messages[name] = timed('messages', messages[name].bind(messages));
      await app.register(threadsRoutes, {
        threadStore: {
          get: async () => thread,
          list: async () => [thread],
          getThreadMemory: timed('memory', async () => null),
        },
        messageStore: messages,
        taskStore: { listByThread: timed('tasks', async () => []) },
        artifactWorkLineage: {
          current: { resolve: timed('lineage', async ({ artifacts }) => artifacts.map(() => undefined)) },
        },
      });
      const send = redis.sendCommand.bind(redis);
      let fullHashes = 0;
      let projectedHashes = 0;
      let rangeRows = 0;
      redis.sendCommand = (command, ...args) => {
        if (command.name === 'hgetall') fullHashes++;
        if (command.name === 'hmget') {
          projectedHashes++;
          assert.ok(
            !command.args.some((field) => ['content', 'thinking', 'toolEvents', 'metadata'].includes(String(field))),
          );
        }
        const pending = send(command, ...args);
        if (command.name === 'eval' && String(command.args[0]).includes('-- artifact cursor range'))
          pending.then((rows) => {
            rangeRows += rows.length / 2;
          });
        if (command.name === 'zrevrange' || command.name === 'zrevrangebyscore')
          pending.then((rows) => {
            rangeRows += rows.length / (command.args.some((arg) => String(arg).toUpperCase() === 'WITHSCORES') ? 2 : 1);
          });
        return pending;
      };
      app.get('/api/ready', async () => ({ ready: true }));
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      let expected;
      for (const url of ['/api/threads/T/artifacts', '/api/artifacts']) {
        fullHashes = 0;
        projectedHashes = 0;
        rangeRows = 0;
        const start = performance.now();
        const pending = fetch(address + url, { headers: { 'x-cat-cafe-user': 'alice' } });
        const readinessStarted = performance.now();
        const ready = await fetch(`${address}/api/ready`);
        assert.equal(ready.status, 200);
        await ready.json();
        const readyMs = performance.now() - readinessStarted;
        const response = await pending;
        assert.equal(response.status, 200);
        const artifacts = (await response.json()).artifacts;
        // Privacy and complete history must pass before the physical read budget.
        assert.equal(artifacts.length, 999);
        assert.ok(artifacts.some((item) => item.sourceMessageId === 'message-0000'));
        assert.ok(artifacts.some((item) => item.sourceMessageId === 'message-0999'));
        assert.ok(
          !artifacts.some((item) => item.sourceMessageId >= 'message-1000' || item.sourceMessageId === 'message-0998'),
        );
        const coordinates = artifacts.map(({ sourceMessageId, publicationItem, name }) => ({
          sourceMessageId,
          publicationItem,
          name,
        }));
        if (expected) assert.deepEqual(coordinates, expected);
        else expected = coordinates;
        t.diagnostic(
          JSON.stringify({
            url,
            elapsedMs: performance.now() - start,
            readyMs,
            fullHashes,
            projectedHashes,
            rangeRows,
            stages,
          }),
        );
        assert.equal(fullHashes, 0, 'catalogue must avoid full hashes; only named top-level fields are excluded');
        assert.equal(projectedHashes, count, 'every raw source row is visited once, including invisible rows');
        assert.equal(rangeRows, count, 'publication-time ties must not rescan all newer prefixes per page');
      }
      const beforeDenied = fullHashes + projectedHashes;
      const denied = await fetch(`${address}/api/threads/T/artifacts`, { headers: { 'x-cat-cafe-user': 'bob' } });
      assert.equal(denied.status, 403);
      await denied.json();
      assert.equal(fullHashes + projectedHashes, beforeDenied, 'denied request reads no messages');
      // Projected reads share the raw reader's publication ordering, including a vanished cursor.
      const selectors = (rows) =>
        rows.map(({ id, userId, deliveryStatus, deliveredAt, extra }) => ({
          id,
          userId,
          deliveryStatus,
          deliveredAt,
          extra,
        }));
      const options = { includeQueuedCatMessages: true };
      const projectedOptions = { ...options, artifactProjection: true };
      const raw = await messages.getByThread('T', 3, 'alice', options);
      assert.deepEqual(selectors(await messages.getByThread('T', 3, 'alice', projectedOptions)), selectors(raw));
      const boundary = raw[0];
      await redis.zrem(MessageKeys.thread('T'), boundary.id);
      assert.deepEqual(
        selectors(await messages.getByThreadBefore('T', boundary.timestamp, 3, boundary.id, 'alice', projectedOptions)),
        selectors(await messages.getByThreadBefore('T', boundary.timestamp, 3, boundary.id, 'alice', options)),
      );
      await redis.hset(MessageKeys.detail(boundary.id), 'deliveredAt', String(timestamp + 2000));
      await redis.zadd(MessageKeys.thread('T'), timestamp + 2000, boundary.id);
      assert.deepEqual(
        selectors(await messages.getByThreadBefore('T', boundary.timestamp, 3, boundary.id, 'alice', projectedOptions)),
        selectors(await messages.getByThreadBefore('T', boundary.timestamp, 3, boundary.id, 'alice', options)),
        're-scoring the cursor cannot admit newer publications into an older page',
      );
      await redis.hset(MessageKeys.detail('message-0000'), {
        deliveryStatus: 'queued',
        deliveredAt: String(timestamp + 1000),
      });
      await redis.zadd(MessageKeys.thread('T'), timestamp + 1000, 'message-0000');
      assert.deepEqual(
        selectors(await messages.getByThread('T', 3, 'alice', projectedOptions)),
        selectors(await messages.getByThread('T', 3, 'alice', options)),
        'a fresh read sees the newly published queued cat and preserves delivery-time ordering',
      );
    } finally {
      await app.close();
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
