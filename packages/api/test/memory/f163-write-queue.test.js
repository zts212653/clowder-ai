/**
 * F163: EvidenceWriteQueue — single-writer scheduler
 * Design Gate contract 3: ALL evidence.sqlite mutations serialized
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvidenceWriteQueue } from '../../dist/domains/memory/evidence-write-queue.js';

describe('F163 EvidenceWriteQueue', () => {
  it('serializes concurrent writes in FIFO order', async () => {
    const queue = new EvidenceWriteQueue();
    const order = [];

    await Promise.all([
      queue.enqueue(() => {
        order.push(1);
      }),
      queue.enqueue(() => {
        order.push(2);
      }),
      queue.enqueue(() => {
        order.push(3);
      }),
    ]);

    assert.deepEqual(order, [1, 2, 3]);
  });

  it('returns the value from the enqueued function', async () => {
    const queue = new EvidenceWriteQueue();
    const result = await queue.enqueue(() => 42);
    assert.equal(result, 42);
  });

  it('propagates errors from enqueued function', async () => {
    const queue = new EvidenceWriteQueue();
    await assert.rejects(
      () =>
        queue.enqueue(() => {
          throw new Error('write failed');
        }),
      { message: 'write failed' },
    );
  });

  it('continues processing after an error', async () => {
    const queue = new EvidenceWriteQueue();

    // First write fails
    await assert.rejects(() =>
      queue.enqueue(() => {
        throw new Error('boom');
      }),
    );

    // Second write should still work
    const result = await queue.enqueue(() => 'ok');
    assert.equal(result, 'ok');
  });

  it('handles async functions', async () => {
    const queue = new EvidenceWriteQueue();
    const result = await queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'async-result';
    });
    assert.equal(result, 'async-result');
  });

  it('serializes async functions (no interleaving)', async () => {
    const queue = new EvidenceWriteQueue();
    const log = [];

    await Promise.all([
      queue.enqueue(async () => {
        log.push('a-start');
        await new Promise((r) => setTimeout(r, 10));
        log.push('a-end');
      }),
      queue.enqueue(async () => {
        log.push('b-start');
        await new Promise((r) => setTimeout(r, 5));
        log.push('b-end');
      }),
    ]);

    assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
  });
});
