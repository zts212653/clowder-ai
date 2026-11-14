import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextSourceWorkBudget } from '../../dist/domains/memory/cue/ContextSourceWorkBudget.js';

test('a synchronous late completion cannot beat the I/O budget timer', async () => {
  await assert.rejects(
    new ContextSourceWorkBudget(20).run(async () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      return 'late';
    }),
    /context_source_timeout/,
  );
});

test('caller cancellation aborts owned I/O even when the operation ignores it', async () => {
  const caller = new AbortController();
  let owned;
  const pending = new ContextSourceWorkBudget(200).run(
    (signal) => {
      owned = signal;
      return new Promise(() => {});
    },
    0,
    caller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(owned.aborted, true);
});
