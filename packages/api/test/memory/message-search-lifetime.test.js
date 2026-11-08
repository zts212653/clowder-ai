import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBeforeSearchCutoff } from '../../dist/domains/memory/message-search-lifetime.js';

test('a fully completed read survives a soft work cutoff when still inside the hard publication deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const result = await readBeforeSearchCutoff(
    async () => {
      t.mock.timers.tick(20); // Synchronous completion could not yield to the soft timer.
      return 'whole canonical row';
    },
    1010,
    { deadlineAt: 1100 },
  );
  assert.deepEqual(result, { completed: true, value: 'whole canonical row' });
});

test('once early-stop wins, a late asynchronous read cannot change the published partial result', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let finish;
  const pending = readBeforeSearchCutoff(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    1010,
    { deadlineAt: 1100 },
  );
  await Promise.resolve();
  t.mock.timers.tick(10);
  const stopped = await pending;
  finish('late source');
  await Promise.resolve();
  assert.deepEqual(stopped, { completed: false });
});

for (const stop of ['cutoff', 'abort', 'complete'])
  test(`an owned read lifetime ends before its waiter returns on ${stop}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const parent = new AbortController();
    let child;
    let finish;
    let disposed = false;
    const pending = readBeforeSearchCutoff(
      (lifetime) => {
        child = lifetime;
        lifetime.signal.addEventListener(
          'abort',
          () => {
            disposed = true;
          },
          { once: true },
        );
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      1010,
      { signal: parent.signal, deadlineAt: 1100 },
    );
    await Promise.resolve();
    assert.equal(child.deadlineAt, 1010);
    assert.notEqual(child.signal, parent.signal);
    if (stop === 'cutoff') t.mock.timers.tick(10);
    else if (stop === 'abort') parent.abort(new DOMException('User cancelled', 'AbortError'));
    else finish('safe');
    if (stop === 'abort') await assert.rejects(pending, { name: 'AbortError' });
    else
      assert.deepEqual(await pending, stop === 'complete' ? { completed: true, value: 'safe' } : { completed: false });
    assert.equal(disposed, true);
    assert.equal(child.signal.aborted, true);
    assert.equal(parent.signal.aborted, stop === 'abort', 'disposing a child never cancels its caller');
    finish('late');
  });
