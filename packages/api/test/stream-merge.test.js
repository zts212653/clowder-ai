import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { mergeStreams } = await import('../dist/domains/cats/services/agents/invocation/stream-merge.js');

/** Create an async iterable that yields values with optional delays */
async function* delayed(values, delayMs = 0) {
  for (const v of values) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield v;
  }
}

/** Create an async iterable that yields then throws */
async function* failAfter(values, error) {
  for (const v of values) yield v;
  throw error;
}

/** Collect all values from an async iterable */
async function collect(iterable) {
  const results = [];
  for await (const v of iterable) results.push(v);
  return results;
}

describe('mergeStreams', () => {
  it('batch abort finishes even when every child next() is permanently pending', async () => {
    let returnCalls = 0;
    const stuck = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return new Promise(() => {});
      },
      async return() {
        returnCalls++;
        return { done: true, value: undefined };
      },
    };
    const controller = new AbortController();
    const iterator = mergeStreams([stuck], undefined, { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort('cancel_all');
    const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))]);

    assert.notEqual(result, 'timeout', 'batch abort must not wait for a stuck child next()');
    assert.equal(result.done, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(returnCalls, 1, 'aborted child iterator must be closed exactly once');
  });

  it('per-stream abort drops only the stuck child and preserves the healthy sibling', async () => {
    let stuckReturnCalls = 0;
    const stuck = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return new Promise(() => {});
      },
      async return() {
        stuckReturnCalls++;
        return { done: true, value: undefined };
      },
    };
    const stuckController = new AbortController();
    const healthyController = new AbortController();
    const iterator = mergeStreams([stuck, delayed(['healthy'])], undefined, {
      signalForIndex: (index) => (index === 0 ? stuckController.signal : healthyController.signal),
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    assert.deepEqual(first, { done: false, value: 'healthy' });
    stuckController.abort('user_cancel');
    const terminal = await Promise.race([
      iterator.next(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    assert.notEqual(terminal, 'timeout', 'per-stream abort must remove the stuck child from the pool');
    assert.equal(terminal.done, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stuckReturnCalls, 1);
    assert.equal(healthyController.signal.aborted, false, 'healthy sibling remains untouched');
  });

  it('per-stream abort can emit a terminal value before a healthy sibling finishes', async () => {
    const stuck = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return new Promise(() => {});
      },
      async return() {
        return { done: true, value: undefined };
      },
    };
    const aborted = new AbortController();
    const healthy = new AbortController();
    const iterator = mergeStreams([stuck, stuck], undefined, {
      signalForIndex: (index) => (index === 0 ? aborted.signal : healthy.signal),
      valueForAbort: (index) => `aborted-${index}`,
    })[Symbol.asyncIterator]();
    const next = iterator.next();

    aborted.abort('user_cancel');
    const terminal = await Promise.race([next, new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))]);

    assert.deepEqual(terminal, { done: false, value: 'aborted-0' });
    assert.equal(healthy.signal.aborted, false, 'healthy sibling must still be running when terminal is emitted');
    healthy.abort('test_cleanup');
    assert.deepEqual(await iterator.next(), { done: false, value: 'aborted-1' });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });

  it('iterator close rejection is reported without blocking terminal completion', async () => {
    const closeError = new Error('close failed');
    const stuck = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return new Promise(() => {});
      },
      async return() {
        throw closeError;
      },
    };
    const errors = [];
    const controller = new AbortController();
    const pending = mergeStreams([stuck], (index, error) => errors.push({ index, error }), {
      signal: controller.signal,
    })
      [Symbol.asyncIterator]()
      .next();

    controller.abort('cancel_all');
    const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))]);
    assert.notEqual(result, 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(errors, [{ index: 0, error: closeError }]);
  });

  it('merges two streams', async () => {
    const a = delayed([1, 2, 3]);
    const b = delayed([4, 5, 6]);
    const result = await collect(mergeStreams([a, b]));
    assert.equal(result.length, 6);
    // All values present
    assert.deepEqual(result.sort(), [1, 2, 3, 4, 5, 6]);
  });

  it('handles one stream finishing before another', async () => {
    const short = delayed([1]);
    const long = delayed([2, 3, 4]);
    const result = await collect(mergeStreams([short, long]));
    assert.equal(result.length, 4);
    assert.deepEqual(result.sort(), [1, 2, 3, 4]);
  });

  it('one stream errors, other continues', async () => {
    const good = delayed([1, 2, 3]);
    const bad = failAfter([4], new Error('boom'));
    const errors = [];
    const result = await collect(mergeStreams([good, bad], (idx, err) => errors.push({ idx, err })));
    // Good stream's values present
    assert.ok(result.includes(1));
    assert.ok(result.includes(2));
    assert.ok(result.includes(3));
    // Bad stream yielded 4 before error
    assert.ok(result.includes(4));
    // Error was reported
    assert.equal(errors.length, 1);
    assert.equal(errors[0].idx, 1);
  });

  it('handles empty streams array', async () => {
    const result = await collect(mergeStreams([]));
    assert.deepEqual(result, []);
  });

  it('handles single stream', async () => {
    const result = await collect(mergeStreams([delayed([1, 2, 3])]));
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('handles all streams erroring', async () => {
    const a = failAfter([], new Error('a'));
    const b = failAfter([], new Error('b'));
    const errors = [];
    const result = await collect(mergeStreams([a, b], (idx, err) => errors.push({ idx, err })));
    assert.deepEqual(result, []);
    assert.equal(errors.length, 2);
  });

  it('handles many values', async () => {
    const a = delayed(Array.from({ length: 100 }, (_, i) => `a${i}`));
    const b = delayed(Array.from({ length: 100 }, (_, i) => `b${i}`));
    const result = await collect(mergeStreams([a, b]));
    assert.equal(result.length, 200);
  });

  it('three streams merge correctly', async () => {
    const a = delayed([1, 2]);
    const b = delayed([3, 4]);
    const c = delayed([5, 6]);
    const result = await collect(mergeStreams([a, b, c]));
    assert.equal(result.length, 6);
    assert.deepEqual(result.sort(), [1, 2, 3, 4, 5, 6]);
  });
});
