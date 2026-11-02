import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_WORK_COUNT } from '../src/domains/plugin/diagnostics/observation-work.js';
import { StaticMetadataQueue } from '../src/domains/plugin/external-runtime/static-metadata-queue.js';

function occupyAllSlots(queue, blocker, firstKind = 'readdir') {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const runs = Array.from({ length: 4 }, (_, index) =>
    queue.run(blocker, index === 0 ? firstKind : 'lstat', () => held),
  );
  return { release, runs };
}

test('longestQueueWait keeps the longest positive wait when a shorter positive wait is granted later', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const queue = new StaticMetadataQueue();
  const blocker = queue.begin('other');
  const observer = queue.begin('observer');
  const { release, runs } = occupyAllSlots(queue, blocker);
  // A waits 10s. B arrives 7s later and is granted after A, but only waits 3s.
  const a = queue.run(observer, 'lstat', async () => 'A');
  now = 7_000;
  const b = queue.run(observer, 'readdir', async () => 'B');
  now = 10_000;
  release();
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  await Promise.all(runs);
  let summary;
  queue.finish(observer, { caller: 'observer', record: (value) => (summary = value) });
  queue.finish(blocker);
  assert.equal(summary.maxQueueWaitMs, 10_000);
  assert.equal(summary.longestQueueWait.queueWaitMs, 10_000, 'the later 3s wait must not replace the 10s wait');
  assert.equal(summary.longestQueueWait.slotWaitMs, 10_000);
  assert.equal(summary.longestQueueWait.waitingAhead, 0, 'A was first; the shorter wait had one request ahead');
  assert.equal(summary.longestQueueWait.releasedBy.operation, 'readdir');
});

test('the requests-ahead count and its cap flag are bounded by MAX_WORK_COUNT', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const queue = new StaticMetadataQueue();
  const blocker = queue.begin('other');
  const crowd = queue.begin('presence');
  const observer = queue.begin('observer');
  const { release, runs } = occupyAllSlots(queue, blocker);
  const queued = Array.from({ length: MAX_WORK_COUNT + 5 }, () => queue.run(crowd, 'lstat', async () => {}));
  const waiting = queue.run(observer, 'lstat', async () => 'done');
  now = 1;
  release();
  assert.equal(await waiting, 'done');
  await Promise.all([...runs, ...queued]);
  let summary;
  queue.finish(observer, { caller: 'observer', record: (value) => (summary = value) });
  queue.finish(crowd);
  queue.finish(blocker);
  assert.equal(summary.longestQueueWait.waitingAhead, MAX_WORK_COUNT, 'requests ahead must stop at the count cap');
  assert.equal(summary.capped, true, 'exceeding the count cap must mark the evidence as capped');
});
