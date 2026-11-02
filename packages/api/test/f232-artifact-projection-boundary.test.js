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
  'artifact field selection omits named top-level fields but retains complete contentBlocks and extra',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'ArtifactProjectionBoundary');
    const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `artifact-boundary-${process.pid}:` });
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const app = Fastify();
    const text = 'retained-block-prose-canary-'.repeat(3000).slice(0, 73_728);
    const contentBlocks = [
      { type: 'text', text },
      { type: 'code', code: 'retained-code-canary', language: 'text' },
      { type: 'file', url: '/uploads/result.pdf', fileName: 'result.pdf', mimeType: 'application/pdf', fileSize: 10 },
      { type: 'tool_call', toolName: 'tool', toolId: 'call', input: { text: 'retained-tool-input-canary' } },
      { type: 'tool_result', toolId: 'call', result: 'retained-tool-result-canary' },
    ];
    const extra = { rich: { v: 1, blocks: [{ kind: 'card', v: 1, id: 'card', title: 'retained-extra-canary' }] } };
    const timestamp = Date.now();
    try {
      await redis.hset(MessageKeys.detail('m'), {
        id: 'm',
        threadId: 'T',
        userId: 'alice',
        catId: 'codex61-sol',
        timestamp: String(timestamp),
        deliveryStatus: 'delivered',
        content: 'excluded-top-level-canary',
        thinking: 'excluded-top-level-canary',
        toolEvents: JSON.stringify([{ input: 'excluded-top-level-canary' }]),
        metadata: JSON.stringify({ unused: 'excluded-top-level-canary' }),
        contentBlocks: JSON.stringify(contentBlocks),
        extra: JSON.stringify(extra),
      });
      await redis.zadd(MessageKeys.thread('T'), timestamp, 'm');
      const selectedFields = [];
      const send = redis.sendCommand.bind(redis);
      redis.sendCommand = (command, ...args) => {
        assert.notEqual(command.name, 'hgetall', 'this read selects fields, not the complete message hash');
        if (command.name === 'hmget') selectedFields.push(command.args.slice(1).map(String));
        return send(command, ...args);
      };
      const page = await messages.getByThreadBeforeBounded('T', timestamp + 1, 10, undefined, 'alice', 10, {
        includeQueuedCatMessages: true,
        artifactProjection: true,
      });
      assert.equal(page.messages.length, 1);
      const message = page.messages[0];
      assert.deepEqual(message.contentBlocks, contentBlocks, 'field selection is not block-level physical trimming');
      assert.deepEqual(message.extra, extra, 'extra is retained as an entire serialized field too');
      assert.equal(message.content, '');
      for (const field of ['thinking', 'toolEvents', 'metadata']) assert.equal(message[field], undefined);
      await app.register(threadsRoutes, {
        threadStore: { get: async () => ({ id: 'T', createdBy: 'alice' }), getThreadMemory: async () => null },
        messageStore: messages,
        taskStore: { listByThread: async () => [] },
      });
      const response = await app.inject({ url: '/api/threads/T/artifacts', headers: { 'x-cat-cafe-user': 'alice' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().artifacts, [
        {
          catId: 'codex61-sol',
          createdAt: timestamp,
          sourceMessageId: 'm',
          type: 'file',
          name: 'result.pdf',
          url: '/uploads/result.pdf',
          publicationItem: { kind: 'content-block', index: 2 },
        },
      ]);
      assert.ok(!response.body.includes('canary'), 'retained block payloads are not returned in artifact DTOs');
      assert.ok(selectedFields.length >= 2);
      for (const fields of selectedFields) {
        assert.ok(fields.includes('contentBlocks') && fields.includes('extra'));
        assert.ok(!fields.some((field) => ['content', 'thinking', 'toolEvents', 'metadata'].includes(field)));
      }
      t.diagnostic(
        JSON.stringify({ retainedTextCodeUnits: text.length, retainedBlockTypes: contentBlocks.map((b) => b.type) }),
      );
    } finally {
      await app.close();
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
