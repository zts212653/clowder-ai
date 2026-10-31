import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { StaticMetadataQueue } from '../src/domains/plugin/external-runtime/static-metadata-queue.js';

test('four FIFO slots distinguish queued time from IO await with exact counts and maxima', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const queue = new StaticMetadataQueue();
  const scan = queue.begin('observer');
  const started = [];
  const release = [];
  const kinds = ['lstat', 'readdir', 'lstat', 'lstat', 'readdir', 'lstat'];
  const runs = kinds.map((kind, index) =>
    queue.run(scan, kind, () => {
      started.push(index);
      return new Promise((resolve) => {
        release[index] = resolve;
      });
    }),
  );
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const [time, indexes, dispatched] of [
    [10, [0], [0, 1, 2, 3, 4]],
    [15, [1], [0, 1, 2, 3, 4, 5]],
    [20, [2, 3], [0, 1, 2, 3, 4, 5]],
    [30, [4], [0, 1, 2, 3, 4, 5]],
    [45, [5], [0, 1, 2, 3, 4, 5]],
  ]) {
    now = time;
    for (const index of indexes) release[index]();
    await turn();
    assert.deepEqual(started, dispatched);
  }
  await Promise.all(runs);
  let summary;
  queue.finish(scan, {
    caller: 'observer',
    record: (value) => {
      summary = value;
    },
  });
  assert.deepEqual(summary, {
    caller: 'observer',
    callers: ['observer'],
    consumerPeak: 1,
    ioPeak: 4,
    lstatCalls: 4,
    readdirCalls: 2,
    queueWaitMs: 25,
    maxQueueWaitMs: 15,
    longestQueueWait: {
      queueWaitMs: 15,
      slotWaitMs: 15,
      resumeDelayMs: 0,
      waitingAhead: 1,
      releasedBy: { caller: 'observer', operation: 'readdir', ioAwaitMs: 15, capped: false },
    },
    ioAwaitMs: 115,
    maxIoAwaitMs: 30,
    capped: false,
  });
});

test('operation counts saturate with an explicit cap', async (t) => {
  t.mock.method(performance, 'now', () => 0);
  const queue = new StaticMetadataQueue();
  const scan = queue.begin('observer');
  for (let index = 0; index < 65_537; index++) await queue.run(scan, 'lstat', async () => {});
  let summary;
  queue.finish(scan, {
    caller: 'observer',
    record: (value) => {
      summary = value;
    },
  });
  assert.equal(summary.lstatCalls, 65_535);
  assert.equal(summary.readdirCalls, 0);
  assert.equal(summary.capped, true);
});

test('synchronous and asynchronous rejections return all four slots to later operations', async () => {
  const queue = new StaticMetadataQueue();
  const scan = queue.begin('observer');
  for (const synchronous of [false, false, true]) {
    const fault = new Error('original operation rejection');
    await assert.rejects(
      queue.run(scan, 'lstat', () => {
        if (synchronous) throw fault;
        return Promise.reject(fault);
      }),
      (error) => error === fault,
    );
  }
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const runs = Array.from({ length: 4 }, () =>
    queue.run(scan, 'lstat', () => {
      started++;
      return gate;
    }),
  );
  try {
    assert.equal(started, 4, 'rejections must not reduce the next four-slot dispatch');
  } finally {
    release();
    await Promise.allSettled(runs);
    queue.finish(scan);
  }
});

test('non-finite samples preserve IO results and omit incomplete summaries', async (t) => {
  let bad = Number.NaN;
  t.mock.method(performance, 'now', () => bad);
  for (const sample of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    bad = sample;
    const queue = new StaticMetadataQueue();
    const scan = queue.begin('observer');
    assert.equal(await queue.run(scan, 'lstat', async () => 'original IO result'), 'original IO result');
    let reported = false;
    queue.finish(scan, {
      caller: 'observer',
      record: () => {
        reported = true;
      },
    });
    assert.equal(reported, false, `${sample} is missing evidence, not a zero or capped duration`);
  }
});

for (const failurePoint of [0, 1, 2]) {
  test(`clock failure at sample ${failurePoint} preserves effects, first cause and reusable slots`, async (t) => {
    let samples = 0;
    t.mock.method(performance, 'now', () => {
      if (samples++ % 3 === failurePoint) throw new Error('diagnostic clock unavailable');
      return 0;
    });
    const queue = new StaticMetadataQueue();
    const scan = queue.begin('observer');
    let effects = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        queue.run(scan, 'lstat', async () => {
          effects++;
          await turn();
          return 'original result';
        }),
      ),
    );
    assert.deepEqual(
      results,
      Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: 'original result' })),
    );
    assert.equal(effects, 4);
    const fault = Object.assign(new Error('original IO failure'), { code: 'EIO' });
    await assert.rejects(
      queue.run(scan, 'lstat', async () => {
        throw fault;
      }),
      (error) => error === fault,
    );
    let reported = false;
    queue.finish(scan, {
      caller: 'observer',
      record: () => {
        reported = true;
      },
    });
    assert.equal(reported, false, 'omit incomplete evidence rather than present missing samples as zero');
    t.mock.restoreAll();
    const next = queue.begin('presence');
    assert.equal(await queue.run(next, 'readdir', async () => 'next read'), 'next read');
    let summary;
    queue.finish(next, {
      caller: 'presence',
      record: (value) => {
        summary = value;
      },
    });
    assert.deepEqual(summary.callers, ['presence']);
    assert.equal(summary.consumerPeak, 1);
  });
}
