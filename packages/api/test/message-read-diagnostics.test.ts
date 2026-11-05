import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { RedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { createMessageStore } from '../src/domains/cats/services/stores/factories/MessageStoreFactory.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import {
  createMessageReadDiagnostics,
  type MessageReadDiagnosticEvent,
  measureMessageReadParser,
} from '../src/infrastructure/message-read-diagnostics.js';
import { registerMessageReadDiagnostics } from '../src/infrastructure/message-read-diagnostics-plugin.js';

test('await CPU and another async request are excluded from this batch synchronous CPU and parser work', async () => {
  let wall = 0,
    cpu = 0;
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = createMessageReadDiagnostics({
    onEvent: (e) => events.push(e),
    clock: () => wall,
    threadCpu: () => ({ user: cpu, system: 0 }),
    minBatchMs: 0,
    minRequestMs: 0,
  });
  try {
    await observer.runRequest('request-a', 'GET /threads/:id', async (endRequest) => {
      const span = observer.beginBatch(2);
      assert.ok(span);
      wall += 200;
      cpu += 500_000; // unrelated work while the pipeline is pending
      await observer.runRequest('request-b', 'GET /other', async (endOtherRequest) => {
        const other = observer.beginBatch(1);
        assert.ok(other);
        other.decodeStarted();
        measureMessageReadParser(other, 'toolEvents', 1000, () => {
          wall += 30;
          cpu += 30_000;
        });
        other.end(1, 'ok');
        endOtherRequest();
      });
      await setImmediate();
      span.decodeStarted();
      assert.equal(
        measureMessageReadParser(span, 'toolEvents', 50, () => {
          wall += 5;
          cpu += 5_000;
          return 'private-result-canary';
        }),
        'private-result-canary',
      );
      span.end(2, 'ok');
      endRequest();
    });
    const batch = events.find((e) => e.kind === 'message_read_batch' && e.requestId === 'request-a');
    assert.ok(batch && batch.kind === 'message_read_batch');
    assert.equal(batch.awaitMs, 230);
    assert.equal(batch.decodeWallMs, 5);
    assert.equal(batch.decodeThreadCpuMs, 5);
    assert.deepEqual(batch.parsers.toolEvents, { nonemptyCalls: 1, inputCodeUnits: 50, wallMs: 5 });
    assert.equal(batch.batchOrdinal, 1);
    assert.ok(!JSON.stringify(events).includes('private-result-canary'));
  } finally {
    observer.stop();
  }
});

test('report limits retain cumulative work and emit an explicit coverage end with dropped counts', () => {
  let wall = 0;
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = createMessageReadDiagnostics({
    onEvent: (e) => events.push(e),
    clock: () => wall,
    threadCpu: () => null,
    windowMs: 100,
    minBatchMs: 0,
    minRequestMs: 0,
    maxBatchReports: 1,
    maxRequestReports: 1,
  });
  for (let request = 0; request < 2; request++)
    observer.runRequest(`r-${request}`, 'GET /safe', (endRequest) => {
      for (let page = 0; page < 3; page++) {
        const span = observer.beginBatch(1);
        assert.ok(span);
        span.decodeStarted();
        measureMessageReadParser(span, 'extraHydration', 400, () => {
          wall += 10;
        });
        span.end(1, 'ok');
      }
      endRequest();
    });
  wall = 101;
  assert.equal(observer.beginBatch(1), undefined);
  observer.stop(); // no duplicate terminal
  const terminal = events.filter((e) => e.kind === 'message_read_coverage_end');
  assert.equal(terminal.length, 1);
  assert.deepEqual(events.filter((e) => e.kind === 'message_read_batch').length, 1);
  const coverage = terminal[0];
  assert.ok(coverage.kind === 'message_read_coverage_end');
  assert.equal(coverage.reason, 'window');
  assert.equal(coverage.observedBatches, 6);
  assert.equal(coverage.completedBatches, 6);
  assert.equal(coverage.decodeWallMs, 60);
  assert.equal(coverage.decodeThreadCpuMs, null);
  assert.equal(coverage.parsers.extraHydration.inputCodeUnits, 2400);
  assert.equal(coverage.droppedBatchReports, 5);
  assert.equal(coverage.droppedRequestReports, 1);
  assert.equal(coverage.incompleteRequests, 0);
});

test('concurrency admission does not borrow another request identity', async () => {
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = createMessageReadDiagnostics({
    onEvent: (e) => events.push(e),
    maxActiveRequests: 1,
    minBatchMs: 0,
    minRequestMs: 0,
  });
  await observer.runRequest('admitted', 'GET /safe', async (endRequest) => {
    await observer.runRequest('not-admitted', 'GET /other', async (endOtherRequest) => {
      await setImmediate();
      const span = observer.beginBatch(1);
      assert.ok(span);
      span.decodeStarted();
      span.end(1, 'ok');
      endOtherRequest();
    });
    endRequest();
  });
  observer.stop();
  const batch = events.find((e) => e.kind === 'message_read_batch');
  assert.ok(batch && batch.kind === 'message_read_batch');
  assert.equal(batch.requestId, null);
  assert.equal(batch.operation, 'unobserved-request');
  const end = events.find((e) => e.kind === 'message_read_coverage_end');
  assert.ok(end && end.kind === 'message_read_coverage_end');
  assert.equal(end.unobservedRequests, 1);
  assert.equal(end.incompleteRequests, 0);
});

test('in-flight batch admission is bounded and reports coverage gaps rather than zero work', () => {
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = createMessageReadDiagnostics({
    onEvent: (e) => events.push(e),
    maxActiveBatches: 1,
    minBatchMs: 0,
    minRequestMs: 0,
  });
  observer.runRequest('r', 'GET /safe', (endRequest) => {
    const admitted = observer.beginBatch(1);
    assert.ok(admitted);
    assert.equal(observer.beginBatch(1), undefined);
    admitted.decodeStarted();
    admitted.end(1, 'ok');
    endRequest();
  });
  observer.stop();
  const request = events.find((e) => e.kind === 'message_read_request');
  assert.ok(request && request.kind === 'message_read_request');
  assert.equal(request.batches, 1);
  assert.equal(request.incompleteBatches, 0);
  const end = events.find((e) => e.kind === 'message_read_coverage_end');
  assert.ok(end && end.kind === 'message_read_coverage_end');
  assert.equal(end.unobservedBatches, 1);
  assert.equal(end.observedBatches, 1);
  assert.equal(end.incompleteBatches, 0);
});

function fakeRedis(exec?: () => Promise<unknown>) {
  const row = {
    id: 'private-id-canary',
    threadId: 'private-thread-canary',
    userId: 'owner',
    catId: 'sonnet',
    timestamp: '123',
    content: 'private-body-canary',
    toolEvents: JSON.stringify([{ detail: 'private-tool-canary' }]),
    extra: JSON.stringify({ stream: { invocationId: 'private-extra-canary' } }),
  };
  return {
    options: {},
    async zrevrange() {
      return [row.id];
    },
    multi() {
      return {
        hgetall() {
          return this;
        },
        async exec() {
          await setImmediate();
          return exec ? exec() : [[null, row]];
        },
      };
    },
  } as unknown as RedisClient;
}

test('real Fastify request context reaches the reader and factory; only route templates and metadata are emitted', async () => {
  const app = Fastify();
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = registerMessageReadDiagnostics(app, {
    onEvent: (e) => events.push(e),
    minBatchMs: 0,
    minRequestMs: 0,
  });
  const store = createMessageStore(fakeRedis(), { readDiagnostics: observer });
  app.get('/threads/:threadId', async () => {
    await setImmediate();
    return store.getByThread('private-thread-canary', 1, 'owner');
  });
  try {
    const results = await Promise.all(
      ['param-a-canary', 'param-b-canary'].map((id) => app.inject(`/threads/${id}?secret=query-canary`)),
    );
    assert.ok(results.every((r) => r.statusCode === 200 && r.json().length === 1));
    const batches = events.filter((e) => e.kind === 'message_read_batch');
    assert.equal(batches.length, 2);
    assert.equal(new Set(batches.map((e) => e.requestId)).size, 2);
    assert.ok(batches.every((e) => e.operation === 'GET /threads/:threadId' && e.requestId !== null));
    assert.equal(events.filter((e) => e.kind === 'message_read_request').length, 2);
    const serialized = JSON.stringify(events);
    for (const canary of [
      'private-id-canary',
      'private-thread-canary',
      'private-body-canary',
      'private-tool-canary',
      'private-extra-canary',
      'param-a-canary',
      'param-b-canary',
      'query-canary',
    ])
      assert.ok(!serialized.includes(canary));
  } finally {
    await app.close();
  }
});

test('diagnostic sink failure cannot replace native results or pipeline rejections', async () => {
  const observer = createMessageReadDiagnostics({
    onEvent() {
      throw new Error('sink down');
    },
    minBatchMs: 0,
  });
  try {
    assert.equal(
      (await new RedisMessageStore(fakeRedis(), { readDiagnostics: observer }).getByThread('thread', 1, 'owner'))
        .length,
      1,
    );
    const original = new Error('original pipeline failure');
    await assert.rejects(
      new RedisMessageStore(
        fakeRedis(async () => {
          throw original;
        }),
        { readDiagnostics: observer },
      ).getByThread('thread', 1, 'owner'),
      (error) => error === original,
    );
  } finally {
    observer.stop();
  }
});

test('a failing injected hook never changes a native parse value', async () => {
  const baseline = await new RedisMessageStore(fakeRedis()).getByThread('thread', 1, 'owner');
  for (const failedHook of ['begin', 'decode', 'parserStart', 'parserEnd', 'end']) {
    const fail = (hook: string) => {
      if (hook === failedHook) throw new Error('observer failed');
    };
    const readDiagnostics = {
      beginBatch() {
        fail('begin');
        return {
          decodeStarted() {
            fail('decode');
          },
          parserStarted() {
            fail('parserStart');
            return 0;
          },
          parserFinished() {
            fail('parserEnd');
          },
          end() {
            fail('end');
          },
        };
      },
    };
    assert.deepEqual(
      await new RedisMessageStore(fakeRedis(), { readDiagnostics }).getByThread('thread', 1, 'owner'),
      baseline,
    );
  }
});

test('a rejected pipeline remains an error and is never called synchronous decode', async () => {
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = createMessageReadDiagnostics({ onEvent: (e) => events.push(e), minBatchMs: 0 });
  try {
    await assert.rejects(
      new RedisMessageStore(
        fakeRedis(async () => {
          throw new Error('rejected');
        }),
        { readDiagnostics: observer },
      ).getByThread('thread', 1),
      /rejected/,
    );
    const failed = events.filter((e) => e.kind === 'message_read_batch');
    assert.equal(failed.length, 1);
    assert.ok(failed.every((e) => e.status === 'failed'));
    assert.equal(failed[0].decodeWallMs, 0);
    assert.equal(failed[0].decodeThreadCpuMs, null);
  } finally {
    observer.stop();
  }
});
