import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

test(
  'rotation notices persist without TTL and deduplicate across producer and API restarts',
  {
    timeout: 15000,
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'secret-notice-persistence');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `secret-notice:${process.pid}:` });
    const registry = new InvocationRegistry();
    const auth = await registry.create('notice-owner', 'codex', 'notice-thread');
    const producer = new URL('../../mcp-server/dist/secret-tool-guard.js', import.meta.url).href;
    let app;
    try {
      let firstId;
      for (let restart = 0; restart < 2; restart++) {
        const store = new RedisMessageStore(redis);
        app = Fastify();
        await app.register(callbacksRoutes, {
          registry,
          messageStore: store,
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        });
        const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        await promisify(execFile)(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import {recordSecretExposure} from ${JSON.stringify(producer)};
        await recordSecretExposure({state:'exposed_or_suspected',callId:'mcp:fixture:call-1',rules:['github-token']});
      `,
          ],
          {
            env: {
              PATH: process.env.PATH,
              CAT_CAFE_API_URL: apiUrl,
              CAT_CAFE_INVOCATION_ID: auth.invocationId,
              CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
            },
            timeout: 10000,
          },
        );
        const history = await store.getByThread('notice-thread', 10, 'notice-owner');
        assert.equal(history.length, 1);
        assert.match(history[0].content, /轮转提醒/);
        assert.equal(await redis.ttl(MessageKeys.detail(history[0].id)), -1);
        if (firstId) assert.equal(history[0].id, firstId);
        firstId = history[0].id;
        await app.close();
        app = undefined;
      }
    } finally {
      await app?.close();
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
