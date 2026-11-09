import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../src/domains/memory/KnowledgeResolver.js';
import type { DiscoveryReadRequest } from '../../src/domains/memory/knowledge-discovery.js';

function heldSource() {
  let request: DiscoveryReadRequest | undefined;
  let enter!: () => void;
  let complete!: (value: { candidates: string[] }) => void;
  let canceled = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<{ candidates: string[] }>((resolve) => {
    complete = resolve;
  });
  return {
    entered,
    finish: () => complete({ candidates: ['late'] }),
    request: () => request,
    canceled: () => canceled,
    source: {
      id: 'held',
      read: (input: DiscoveryReadRequest) => {
        request = input;
        input.signal?.addEventListener(
          'abort',
          () => {
            canceled = true;
          },
          { once: true },
        );
        enter();
        return held; // Intentionally noncooperative: cancellation must not await this promise.
      },
      project: async (row: string) => row,
      key: (row: string) => row,
    },
  };
}

test('a discovery deadline cancels its owned read without canceling the external caller or waiting for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const parent = new AbortController();
  const read = heldSource();
  t.after(read.finish);
  const pending = KnowledgeResolver.discover('neutral', {
    limit: 1,
    signal: parent.signal,
    deadlineAt: 1100,
    sources: [read.source],
  });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await read.entered;
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(read.canceled(), true, 'the source resource must be canceled before discovery returns');
  assert.equal(parent.signal.aborted, false);
  assert.equal(read.request()?.deadlineAt, 1100);
  read.finish();
});

test('an early timer wake does not expire a read before its absolute deadline', async (t) => {
  // Node's timer wake and Date.now() need not cross the same millisecond together.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let wallTime = 1000;
  t.mock.method(Date, 'now', () => wallTime);
  const read = heldSource();
  t.after(read.finish);
  const pending = KnowledgeResolver.discover('neutral', {
    limit: 1,
    deadlineAt: 1100,
    sources: [read.source],
  });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await read.entered;
  wallTime = 1099;
  t.mock.timers.tick(100);
  assert.equal(read.canceled(), false, 'a timer notification is not proof that the absolute deadline passed');
  wallTime = 1100;
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(read.canceled(), true, 'the original deadline must still cancel the pending source');
});

test('one source failure cancels its active siblings without changing the failure or its shared parent', async (t) => {
  const parent = new AbortController();
  const read = heldSource();
  t.after(read.finish);
  const failure = new Error('source failed');
  const failed = {
    ...read.source,
    id: 'fails',
    read: async () => {
      await read.entered;
      throw failure;
    },
  };
  await assert.rejects(
    KnowledgeResolver.discover('neutral', { limit: 1, signal: parent.signal, sources: [read.source, failed] }),
    (error) => error === failure,
  );
  assert.equal(read.canceled(), true, 'native sibling cannot keep running after discovery has failed');
  assert.equal(parent.signal.aborted, false);
  read.finish();
});

test('caller cancellation propagates its exact reason to the owned read and ignores late successful data', async (t) => {
  const parent = new AbortController();
  const read = heldSource();
  t.after(read.finish);
  const pending = KnowledgeResolver.discover('neutral', { limit: 1, signal: parent.signal, sources: [read.source] });
  const reason = new DOMException('caller disconnected', 'AbortError');
  const rejected = assert.rejects(pending, (error) => error === reason);
  await read.entered;
  parent.abort(reason);
  await rejected;
  assert.equal(read.canceled(), true);
  assert.equal(read.request()?.signal?.reason, reason);
  read.finish();
});

test('a completed call does not cancel another discovery using the same caller signal', async (t) => {
  const parent = new AbortController();
  const read = heldSource();
  t.after(read.finish);
  const pending = KnowledgeResolver.discover('neutral', { limit: 1, signal: parent.signal, sources: [read.source] });
  await read.entered;
  const done = await KnowledgeResolver.discover('neutral', {
    limit: 1,
    signal: parent.signal,
    sources: [{ ...read.source, read: async () => ({ candidates: ['ready'] }) }],
  });
  assert.deepEqual(done.items, ['ready']);
  assert.equal(parent.signal.aborted, false);
  assert.equal(read.canceled(), false);
  read.finish();
  assert.deepEqual((await pending).items, ['late']);
});
