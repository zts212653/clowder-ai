import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';

test('the full message reader observes await and decode without changing parsed messages', async () => {
  const steps: string[] = [];
  const fields = {
    id: 'synthetic-message',
    threadId: 'synthetic-thread',
    userId: 'owner',
    catId: 'sonnet',
    timestamp: '123',
    content: 'private-body-canary',
    toolEvents: JSON.stringify([{ type: 'tool_result', detail: 'private-tool-canary' }]),
    contentBlocks: JSON.stringify([{ type: 'text', text: 'private-block-canary' }]),
    extra: JSON.stringify({ stream: { invocationId: 'private-extra-canary' } }),
  };
  const redis = {
    options: {},
    async zrevrange() {
      return [fields.id];
    },
    multi() {
      return {
        hgetall() {
          return this;
        },
        async exec() {
          steps.push('await');
          return [[null, fields]];
        },
      };
    },
  } as unknown as RedisClient;
  const readDiagnostics = {
    beginBatch(rows: number) {
      steps.push(`begin:${rows}`);
      return {
        decodeStarted() {
          steps.push('decode');
        },
        parserStarted(group: string, codeUnits: number) {
          steps.push(`${group}:${codeUnits}`);
          return 0;
        },
        parserFinished() {},
        end(rows: number, status: string) {
          steps.push(`end:${rows}:${status}`);
        },
      };
    },
  };
  const store = new RedisMessageStore(redis, { ttlSeconds: 0, readDiagnostics });
  const observed = await store.getByThread('synthetic-thread', 1, 'owner');
  const baseline = await new RedisMessageStore(redis, { ttlSeconds: 0 }).getByThread('synthetic-thread', 1, 'owner');
  assert.deepEqual(observed, baseline);
  assert.deepEqual(steps.slice(0, 3), ['begin:1', 'await', 'decode']);
  assert.ok(steps.includes(`toolEvents:${fields.toolEvents.length}`));
  assert.ok(steps.includes(`contentBlocks:${fields.contentBlocks.length}`));
  assert.ok(steps.includes(`extraHydration:${fields.extra.length}`));
  assert.ok(steps.includes('end:1:ok'));
});
