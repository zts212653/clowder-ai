import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_WORK_MS } from '../src/domains/plugin/diagnostics/observation-work.js';
import { StaticMetadataQueue } from '../src/domains/plugin/external-runtime/static-metadata-queue.js';

for (const delay of ['before-grant', 'after-grant']) {
  test(`a 24s queue wait identifies ${delay} without changing FIFO or the IO result`, async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const queue = new StaticMetadataQueue();
    const blocker = queue.begin('other');
    const observer = queue.begin('observer');
    let releaseFirst;
    let releaseOthers;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const others = new Promise((resolve) => {
      releaseOthers = resolve;
    });
    const started = [];
    const runs = [
      queue.run(blocker, 'readdir', () => {
        started.push('first');
        return first;
      }),
      ...Array.from({ length: 3 }, (_, index) =>
        queue.run(blocker, 'lstat', () => {
          started.push(index);
          return others;
        }),
      ),
    ];
    const waiting = queue.run(observer, 'lstat', async () => {
      started.push('observer');
      return 'original observation metadata';
    });
    try {
      assert.deepEqual(started, ['first', 0, 1, 2], 'all four slots are really occupied');
      if (delay === 'before-grant') now = 24_000;
      else {
        // This reaction runs after the first IO releases its slot, before the
        // queued await continuation resumes. No real sleep or CPU load is used.
        first.then(() => {
          now = 24_000;
        });
      }
      releaseFirst();
      assert.equal(await waiting, 'original observation metadata');
      assert.deepEqual(started, ['first', 0, 1, 2, 'observer']);
      let summary;
      queue.finish(observer, {
        caller: 'observer',
        record: (value) => {
          summary = value;
        },
      });
      assert.equal(summary.maxQueueWaitMs, 24_000, 'the old aggregate cannot distinguish these cases');
      assert.equal(summary.ioAwaitMs, 0, 'the observer operation itself has no injected IO cost');
      assert.deepEqual(summary.longestQueueWait, {
        queueWaitMs: 24_000,
        slotWaitMs: delay === 'before-grant' ? 24_000 : 0,
        resumeDelayMs: delay === 'after-grant' ? 24_000 : 0,
        waitingAhead: 0,
        releasedBy: {
          caller: 'other',
          operation: 'readdir',
          ioAwaitMs: delay === 'before-grant' ? 24_000 : 0,
          capped: false,
        },
      });
    } finally {
      releaseFirst();
      releaseOthers();
      await Promise.allSettled([...runs, waiting]);
      queue.finish(observer);
      queue.finish(blocker);
    }
  });
}

for (const mode of ['clock-unavailable-at-grant', 'releasing-io-over-cap']) {
  test(`${mode} preserves the original queued error and all four reusable slots`, async (t) => {
    let now = 0;
    let failGrant = false;
    let completedSample = false;
    t.mock.method(performance, 'now', () => {
      if (failGrant) {
        if (!completedSample) completedSample = true;
        else {
          failGrant = false;
          throw new Error('grant diagnostic sample unavailable');
        }
      }
      return now;
    });
    const queue = new StaticMetadataQueue();
    const blocker = queue.begin('other');
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 4 }, () => queue.run(blocker, 'lstat', () => held));
    if (mode === 'releasing-io-over-cap') now = MAX_WORK_MS + 17;
    const observer = queue.begin('observer');
    const fault = Object.assign(new Error('original queued IO rejection'), { code: 'EIO' });
    let effects = 0;
    const waiting = queue.run(observer, 'readdir', async () => {
      effects++;
      throw fault;
    });
    try {
      if (mode === 'clock-unavailable-at-grant') failGrant = true;
      else now++;
      release();
      await assert.rejects(waiting, (error) => error === fault);
      assert.equal(effects, 1);
      await Promise.all(pending);
      let summary;
      queue.finish(observer, { caller: 'observer', record: (value) => (summary = value) });
      if (mode === 'clock-unavailable-at-grant') assert.equal(summary, undefined);
      else {
        assert.equal(summary.capped, true);
        assert.equal(summary.longestQueueWait.slotWaitMs, 1);
        assert.equal(summary.longestQueueWait.releasedBy.ioAwaitMs, MAX_WORK_MS);
        assert.equal(summary.longestQueueWait.releasedBy.capped, true);
      }
    } finally {
      release();
      await Promise.allSettled([...pending, waiting]);
      queue.finish(observer);
      queue.finish(blocker);
    }
    t.mock.restoreAll();
    const next = queue.begin('presence');
    let releaseNext;
    const heldNext = new Promise((resolve) => {
      releaseNext = resolve;
    });
    let started = 0;
    const runs = Array.from({ length: 4 }, () =>
      queue.run(next, 'lstat', () => {
        started++;
        return heldNext;
      }),
    );
    try {
      assert.equal(started, 4);
    } finally {
      releaseNext();
      await Promise.allSettled(runs);
      queue.finish(next);
    }
  });
}
