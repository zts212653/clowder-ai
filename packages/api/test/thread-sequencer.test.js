/**
 * F183 Phase C — ThreadSequencer unit tests.
 *
 * KD-9 thread-scoped monotonic sequence number. Pure utility class with no
 * external dependencies — verify monotonicity / per-thread isolation / reset.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThreadSequencer } from '../dist/infrastructure/websocket/ThreadSequencer.js';

describe('ThreadSequencer (F183 Phase C — KD-9 thread-scoped monotonic)', () => {
  it('next() returns 1 on first call for a thread', () => {
    const seq = new ThreadSequencer();
    assert.equal(seq.next('thread-A'), 1);
  });

  it('next() increments monotonically per thread', () => {
    const seq = new ThreadSequencer();
    assert.equal(seq.next('thread-A'), 1);
    assert.equal(seq.next('thread-A'), 2);
    assert.equal(seq.next('thread-A'), 3);
    assert.equal(seq.next('thread-A'), 4);
  });

  it('next() is independent per thread — thread A and B both start at 1', () => {
    const seq = new ThreadSequencer();
    assert.equal(seq.next('thread-A'), 1);
    assert.equal(seq.next('thread-B'), 1);
    assert.equal(seq.next('thread-A'), 2);
    assert.equal(seq.next('thread-B'), 2);
    assert.equal(seq.next('thread-A'), 3);
  });

  it('peek() returns 0 for unseen thread', () => {
    const seq = new ThreadSequencer();
    assert.equal(seq.peek('thread-X'), 0);
  });

  it('peek() does not increment counter', () => {
    const seq = new ThreadSequencer();
    seq.next('thread-A'); // 1
    assert.equal(seq.peek('thread-A'), 1);
    assert.equal(seq.peek('thread-A'), 1);
    assert.equal(seq.peek('thread-A'), 1);
    assert.equal(seq.next('thread-A'), 2); // peek didn't bump
  });

  it('peek() returns current value after multiple next() calls', () => {
    const seq = new ThreadSequencer();
    for (let i = 0; i < 100; i++) seq.next('thread-A');
    assert.equal(seq.peek('thread-A'), 100);
  });

  it('reset(threadId) clears single thread but preserves others', () => {
    const seq = new ThreadSequencer();
    seq.next('thread-A'); // 1
    seq.next('thread-A'); // 2
    seq.next('thread-B'); // 1
    seq.reset('thread-A');
    assert.equal(seq.peek('thread-A'), 0);
    assert.equal(seq.peek('thread-B'), 1);
    // After reset, next call starts fresh at 1
    assert.equal(seq.next('thread-A'), 1);
  });

  it('resetAll() clears every thread state', () => {
    const seq = new ThreadSequencer();
    seq.next('thread-A');
    seq.next('thread-B');
    seq.next('thread-C');
    seq.resetAll();
    assert.equal(seq.peek('thread-A'), 0);
    assert.equal(seq.peek('thread-B'), 0);
    assert.equal(seq.peek('thread-C'), 0);
  });

  it('handles arbitrary thread id strings (UUIDs, special chars)', () => {
    const seq = new ThreadSequencer();
    const ids = [
      'thread_moli9ev12ihcz7fi',
      '01HXYZ123456ABCDEF',
      'thread:with:colons',
      'thread-with-dashes-and-numbers-12345',
    ];
    for (const id of ids) {
      assert.equal(seq.next(id), 1);
      assert.equal(seq.next(id), 2);
    }
    for (const id of ids) {
      assert.equal(seq.peek(id), 2);
    }
  });

  it('high-frequency calls preserve monotonicity', () => {
    const seq = new ThreadSequencer();
    const N = 10000;
    let last = 0;
    for (let i = 0; i < N; i++) {
      const cur = seq.next('thread-A');
      assert.ok(cur > last, `seq must be monotonic: ${cur} > ${last}`);
      last = cur;
    }
    assert.equal(seq.peek('thread-A'), N);
  });

  it('parallel threads do not interfere', () => {
    const seq = new ThreadSequencer();
    // Interleave calls across many threads
    const threads = ['t1', 't2', 't3', 't4', 't5'];
    const expected = {};
    for (const t of threads) expected[t] = 0;
    for (let i = 0; i < 1000; i++) {
      const t = threads[i % threads.length];
      expected[t]++;
      assert.equal(seq.next(t), expected[t]);
    }
    for (const t of threads) {
      assert.equal(seq.peek(t), expected[t]);
    }
  });

  describe('bumpTo (cloud R3 P2: override monotonicity)', () => {
    it('bumpTo advances counter to seq when seq > current', () => {
      const seq = new ThreadSequencer();
      seq.next('thread-A'); // 1
      seq.bumpTo('thread-A', 100);
      assert.equal(seq.peek('thread-A'), 100);
      // Subsequent next() preserves monotonicity
      assert.equal(seq.next('thread-A'), 101);
    });

    it('bumpTo is no-op when seq <= current (idempotent / preserves monotonicity)', () => {
      const seq = new ThreadSequencer();
      seq.next('thread-A'); // 1
      seq.next('thread-A'); // 2
      seq.next('thread-A'); // 3
      seq.bumpTo('thread-A', 2); // 2 < 3, should be no-op
      assert.equal(seq.peek('thread-A'), 3);
      seq.bumpTo('thread-A', 3); // 3 == 3, no-op
      assert.equal(seq.peek('thread-A'), 3);
      assert.equal(seq.next('thread-A'), 4);
    });

    it('bumpTo seeds unseen thread (seq > 0)', () => {
      const seq = new ThreadSequencer();
      assert.equal(seq.peek('thread-A'), 0);
      seq.bumpTo('thread-A', 50);
      assert.equal(seq.peek('thread-A'), 50);
      assert.equal(seq.next('thread-A'), 51);
    });

    it('bumpTo defensive: ignores non-number / 0 / negative seq', () => {
      const seq = new ThreadSequencer();
      seq.next('thread-A'); // 1
      seq.bumpTo('thread-A', 0); // ignored
      seq.bumpTo('thread-A', -5); // ignored
      seq.bumpTo('thread-A', /** @type {any} */ (null)); // ignored
      seq.bumpTo('thread-A', /** @type {any} */ (undefined)); // ignored
      assert.equal(seq.peek('thread-A'), 1);
    });

    it('bumpTo per-thread isolation', () => {
      const seq = new ThreadSequencer();
      seq.bumpTo('thread-A', 100);
      seq.bumpTo('thread-B', 50);
      assert.equal(seq.peek('thread-A'), 100);
      assert.equal(seq.peek('thread-B'), 50);
    });
  });

  describe('epoch (砚砚 R1 P1: server restart detection)', () => {
    it('epoch is generated at construction and stable for instance lifetime', () => {
      const seq = new ThreadSequencer();
      const epoch1 = seq.epoch;
      assert.ok(epoch1 && typeof epoch1 === 'string', 'epoch is non-empty string');
      assert.equal(seq.epoch, epoch1, 'epoch is stable');
      seq.next('thread-A');
      seq.next('thread-A');
      assert.equal(seq.epoch, epoch1, 'epoch unchanged after next() calls');
      seq.reset('thread-A');
      assert.equal(seq.epoch, epoch1, 'epoch unchanged after reset()');
    });

    it('different ThreadSequencer instances have different epochs (server restart simulation)', () => {
      const seq1 = new ThreadSequencer();
      const seq2 = new ThreadSequencer();
      assert.notEqual(seq1.epoch, seq2.epoch, 'two instances have distinct epochs');
    });

    it('epoch override accepted (for test determinism)', () => {
      const seq = new ThreadSequencer('test-epoch-fixed');
      assert.equal(seq.epoch, 'test-epoch-fixed');
    });

    it('epoch is UUID-shaped by default (RFC 4122)', () => {
      const seq = new ThreadSequencer();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert.match(seq.epoch, uuidPattern);
    });
  });
});
