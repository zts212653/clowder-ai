import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { RedisSessionChainStore } from '../../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { RedisThreadStore } from '../../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { DailyContextReflectionProducer } from '../../dist/domains/memory/DailyContextReflectionProducer.js';

const NOW = Date.parse('2026-07-26T11:15:00.000Z');

function reflectionProducerThatMustNotRun() {
  return {
    reflectSessions: async () => {
      throw new Error('aborted production scan must not reach reflection');
    },
  };
}

test('F271 aborts a production Redis thread-list read and releases the daily run promptly', async () => {
  class TrackedRedisThreadStore extends RedisThreadStore {
    activeReads = 0;

    async list(userId, options) {
      this.activeReads += 1;
      try {
        return await super.list(userId, options);
      } finally {
        this.activeReads -= 1;
      }
    }
  }

  const redis = {
    options: { keyPrefix: '' },
    zrevrange: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(['thread-a', 'thread-b']), 1_000);
      }),
    hgetall: async (key) => ({
      id: String(key).replace(/^thread:/, ''),
      projectPath: 'default',
      title: '',
      createdBy: 'owner-1',
      lastActiveAt: '1',
      createdAt: '1',
    }),
    smembers: async () => [],
  };
  const threadStore = new TrackedRedisThreadStore(redis);
  const producer = new DailyContextReflectionProducer({
    ownerUserId: 'owner-1',
    threadStore,
    sessionChainStore: {
      getChainByThread: async () => {
        throw new Error('aborted thread list must not start session scans');
      },
    },
    reflectionProducer: reflectionProducerThatMustNotRun(),
    now: () => NOW,
    getHouseholdTimeZone: () => 'America/Los_Angeles',
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = producer.run({ signal: controller.signal });
  setTimeout(() => controller.abort(new Error('daily thread scan deadline exceeded')), 20);

  await assert.rejects(pending, /daily thread scan deadline exceeded/);
  assert.ok(Date.now() - startedAt < 500, 'abort must beat the 1s backing read even under full-suite load');
  assert.equal(threadStore.activeReads, 0);
});

test('F271 aborts a production Redis session-chain scan stream before starting another thread', async () => {
  class TrackedRedisSessionChainStore extends RedisSessionChainStore {
    activeReads = 0;

    async getChainByThread(threadId, options) {
      this.activeReads += 1;
      try {
        return await super.getChainByThread(threadId, options);
      } finally {
        this.activeReads -= 1;
      }
    }
  }

  let streamActive = 0;
  let streamDestroyed = false;
  let scanStarts = 0;
  const redis = {
    options: { keyPrefix: '' },
    scanStream: () => {
      scanStarts += 1;
      const stream = new EventEmitter();
      streamActive += 1;
      const timer = setTimeout(
        () => {
          streamActive -= 1;
          stream.emit('end');
        },
        scanStarts === 1 ? 1_000 : 20,
      );
      stream.destroy = () => {
        if (streamDestroyed) return;
        streamDestroyed = true;
        clearTimeout(timer);
        streamActive -= 1;
      };
      return stream;
    },
    smembers: async () => [],
  };
  const sessionChainStore = new TrackedRedisSessionChainStore(redis);
  const startedThreads = [];
  const producer = new DailyContextReflectionProducer({
    ownerUserId: 'owner-1',
    threadStore: {
      list: async () => [{ id: 'thread-a' }, { id: 'thread-b' }],
    },
    sessionChainStore: {
      getChainByThread(threadId, options) {
        startedThreads.push(threadId);
        return sessionChainStore.getChainByThread(threadId, options);
      },
    },
    reflectionProducer: reflectionProducerThatMustNotRun(),
    now: () => NOW,
    getHouseholdTimeZone: () => 'America/Los_Angeles',
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = producer.run({ signal: controller.signal });
  setTimeout(() => controller.abort(new Error('daily session scan deadline exceeded')), 20);

  await assert.rejects(pending, /daily session scan deadline exceeded/);
  assert.ok(Date.now() - startedAt < 500, 'abort must beat the 1s Redis stream even under full-suite load');
  assert.equal(sessionChainStore.activeReads, 0);
  assert.equal(streamActive, 0);
  assert.equal(streamDestroyed, true);
  assert.deepEqual(startedThreads, ['thread-a']);

  const retry = await sessionChainStore.getChainByThread('thread-retry');
  assert.deepEqual(retry, []);
  assert.equal(scanStarts, 2, 'an aborted legacy backfill must retry instead of trusting a partial index');
});
