import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForRendererDocument } from './renderer-document.mjs';

const origin = 'http://localhost:35671';
const ready = { origin, readyState: 'complete', hasBody: true };
function fixture(read) {
  let elapsed = 0;
  return {
    read,
    origin,
    now: () => elapsed,
    pause: async (milliseconds) => {
      elapsed += milliseconds;
    },
    timeoutMs: 500,
  };
}

test('waits through the actual about:blank/loading/interactive lifecycle before consumer operations', async () => {
  const states = [
    { origin: 'null', readyState: 'complete', hasBody: true },
    { origin, readyState: 'loading', hasBody: false },
    { origin, readyState: 'loading', hasBody: true },
    { origin, readyState: 'interactive', hasBody: true },
    ready,
  ];
  let reads = 0;
  const result = await waitForRendererDocument(fixture(async () => states[reads++]));
  assert.equal(reads, states.length);
  assert.equal(result, ready);
});

test('recovers only readiness reads when navigation destroys an execution context', async () => {
  let reads = 0;
  const result = await waitForRendererDocument(
    fixture(async () => {
      if (++reads === 1) throw new Error('Execution context was destroyed');
      return ready;
    }),
  );
  assert.equal(reads, 2);
  assert.equal(result, ready);
});

test('rejects an indefinitely complete document at the wrong origin', async () => {
  await assert.rejects(
    waitForRendererDocument(fixture(async () => ({ ...ready, origin: 'null' }))),
    /did not become ready at the expected origin/,
  );
});

test('rejects a missing body and unreadable contexts without admitting consumer operations', async () => {
  for (const read of [
    async () => ({ ...ready, hasBody: false }),
    async () => undefined,
    async () => {
      throw new Error('Execution context was destroyed');
    },
  ]) {
    await assert.rejects(waitForRendererDocument(fixture(read)), /did not become ready at the expected origin/);
  }
});
