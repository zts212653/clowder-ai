import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWithMessageVectorBudget } from '../../dist/domains/memory/message-vector-budget.js';

const result = (effectiveMode = 'lexical') => ({
  passages: [{ messageId: 'current-source' }],
  meta: { effectiveMode, degraded: false, semanticCandidatesLimited: false },
});
const options = (extra = {}) => ({ mode: 'hybrid', visibleThreadIds: ['visible'], ...extra });
const untilAbort = (signal) =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

test('the vector budget starts after lexical work and returns only the new lexical read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const original = new AbortController();
  const reads = [];
  let start, vectorSignal;
  const lexical = result();
  const read = readWithMessageVectorBudget(
    options({ signal: original.signal, deadlineAt: 16000 }),
    async (mode, signal, started) => {
      reads.push(mode);
      if (mode === 'lexical') {
        assert.equal(signal, original.signal);
        return lexical;
      }
      start = started;
      vectorSignal = signal;
      return untilAbort(signal);
    },
  );
  t.mock.timers.tick(6000);
  assert.equal(vectorSignal.aborted, false, 'lexical work has no vector timer');
  start();
  t.mock.timers.tick(3999);
  assert.equal(vectorSignal.aborted, false);
  t.mock.timers.tick(1);
  const actual = await read;
  assert.deepEqual(reads, ['hybrid', 'lexical']);
  assert.equal(actual.passages, lexical.passages);
  assert.equal(actual.meta.degradeReason, 'passage_vector_budget_exhausted');
  assert.equal(actual.meta.degraded, true);
  assert.equal(actual.meta.semanticCandidatesLimited, true);
  assert.equal(original.signal.aborted, false);
});

for (const mode of ['lexical', 'semantic']) {
  test(`explicit ${mode} retains its mode, signal and result without a vector budget`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = new AbortController();
    const value = result(mode);
    const actual = await readWithMessageVectorBudget(
      options({ mode, signal: original.signal }),
      async (selected, signal, start) => {
        assert.equal(selected, mode);
        assert.equal(signal, original.signal);
        assert.equal(start, undefined);
        t.mock.timers.tick(5000);
        return value;
      },
    );
    assert.equal(actual, value);
  });
}

test('client cancellation and an expired overall deadline never start a lexical retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const cause of ['client', 'deadline']) {
    const controller = new AbortController();
    let calls = 0;
    const failure = new DOMException('Client disconnected', 'AbortError');
    const reading = readWithMessageVectorBudget(
      options({ signal: controller.signal, deadlineAt: Date.now() + 1000 }),
      (_mode, signal, start) => {
        calls++;
        start();
        return untilAbort(signal);
      },
    );
    const rejected = assert.rejects(
      reading,
      cause === 'client' ? (error) => error === failure : { name: 'TimeoutError' },
    );
    if (cause === 'client') controller.abort(failure);
    else t.mock.timers.tick(4000);
    await rejected;
    assert.equal(calls, 1);
  }
});

test('a three-second hybrid read returns its vectors, clears the timer and preserves unrelated failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const value = result('hybrid');
  assert.equal(
    await readWithMessageVectorBudget(options(), async (mode, current, start) => {
      if (mode === 'lexical') return result();
      signal = current;
      start();
      t.mock.timers.tick(3000);
      current.throwIfAborted();
      return value;
    }),
    value,
  );
  t.mock.timers.tick(5000);
  assert.equal(signal.aborted, false);
  const failure = new Error('read failed before the vector deadline');
  let calls = 0;
  await assert.rejects(
    readWithMessageVectorBudget(options(), async (_mode, _signal, start) => {
      calls++;
      start();
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test('completed vector work does not cancel a later lexical refresh or final admission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const value = result();
  const actual = await readWithMessageVectorBudget(options(), async (_mode, signal, start, finished) => {
    start();
    t.mock.timers.tick(1000);
    finished();
    t.mock.timers.tick(5000);
    assert.equal(signal.aborted, false);
    return value;
  });
  assert.equal(actual, value);
});
