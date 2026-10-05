import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { getRichBlockBuffer } from '../dist/domains/cats/services/agents/invocation/RichBlockBuffer.js';

describe('RichBlockBuffer', () => {
  beforeEach(() => {
    getRichBlockBuffer().destroy();
  });

  after(() => {
    getRichBlockBuffer().destroy();
  });

  it('add + consume round trip', () => {
    const buf = getRichBlockBuffer();
    const block = { id: 'b1', kind: 'card', v: 1, title: 'Test' };
    buf.add('t1', 'opus', block);
    const result = buf.consume('t1', 'opus');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'b1');
  });

  it('consume clears buffer', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'Test' });
    buf.consume('t1', 'opus');
    const second = buf.consume('t1', 'opus');
    assert.equal(second.length, 0);
  });

  it('accumulates multiple blocks for same key', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' });
    buf.add('t1', 'opus', { id: 'b2', kind: 'diff', v: 1, filePath: 'a.ts', diff: '+x' });
    const result = buf.consume('t1', 'opus');
    assert.equal(result.length, 2);
  });

  it('checks only rich block kind for the exact in-flight invocation', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'codex-sol', { id: 'html-1', kind: 'html_widget', v: 1, html: '<p>ELI5</p>' }, 'inv-1');
    assert.equal(buf.hasKind('t1', 'codex-sol', 'inv-1', 'html_widget'), true);
    assert.equal(buf.hasKind('t1', 'codex-sol', 'inv-other', 'html_widget'), false);
    assert.equal(buf.hasKind('t1', 'codex-sol', 'inv-1', 'card'), false);
  });

  it('isolates different thread/cat keys', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' });
    buf.add('t1', 'codex', { id: 'b2', kind: 'card', v: 1, title: 'B' });
    buf.add('t2', 'opus', { id: 'b3', kind: 'card', v: 1, title: 'C' });
    assert.equal(buf.consume('t1', 'opus').length, 1);
    assert.equal(buf.consume('t1', 'codex').length, 1);
    assert.equal(buf.consume('t2', 'opus').length, 1);
  });

  it('consume returns empty for non-existent key', () => {
    const buf = getRichBlockBuffer();
    const result = buf.consume('nonexistent', 'opus');
    assert.deepEqual(result, []);
  });

  it('destroy clears all entries', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' });
    buf.destroy();
    assert.equal(buf.size, 0);
  });

  // P1-2: consume with invocationId rejects mismatched entries
  it('consume rejects blocks from a different invocationId', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'Old' }, 'inv-old');
    // Consuming with a different invocationId should return empty
    const result = buf.consume('t1', 'opus', 'inv-new');
    assert.equal(result.length, 0);
  });

  it('consume returns blocks matching invocationId', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    const result = buf.consume('t1', 'opus', 'inv-1');
    assert.equal(result.length, 1);
  });

  // R2 P1-1 regression: preemption scenario — old invocation must NOT consume new invocation's blocks
  it('preemption: each invocation only gets its own blocks', () => {
    const buf = getRichBlockBuffer();
    // Invocation A adds a block
    buf.add('t1', 'opus', { id: 'a1', kind: 'card', v: 1, title: 'A-block' }, 'inv-A');
    // Invocation B starts (preempts A) — add() with new invocationId replaces A's blocks
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'B-block' }, 'inv-B');
    // Old invocation A tries consume with its OWN id (correct fix) — gets nothing
    const resultA = buf.consume('t1', 'opus', 'inv-A');
    assert.equal(resultA.length, 0, 'Old invocation A must not get blocks');
    // Cloud Codex P1: mismatched consume must NOT delete B's blocks
    // B consumes with its own id — gets its block (no re-add needed)
    const resultB = buf.consume('t1', 'opus', 'inv-B');
    assert.equal(resultB.length, 1, 'New invocation B must get its own blocks');
    assert.equal(resultB[0].id, 'b1');
  });

  // Cloud Codex P1 regression: mismatched consume must preserve newer entry
  it('mismatched consume preserves newer invocation blocks', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'B-block' }, 'inv-B');
    // A consumes with wrong (own) id — should return empty WITHOUT deleting B's entry
    assert.equal(buf.consume('t1', 'opus', 'inv-A').length, 0);
    // B's blocks must still be intact
    const resultB = buf.consume('t1', 'opus', 'inv-B');
    assert.equal(resultB.length, 1, 'B blocks preserved after mismatched consume');
    assert.equal(resultB[0].id, 'b1');
  });

  // P2-1: deduplication by block.id
  it('deduplicates blocks with same id', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    buf.add('t1', 'opus', { id: 'b2', kind: 'card', v: 1, title: 'B' }, 'inv-1');
    const result = buf.consume('t1', 'opus', 'inv-1');
    assert.equal(result.length, 2); // b1 only once + b2
  });

  // R6 P2: add() distinguishes accepted blocks and retries
  it('add returns added for new block, duplicate for retry', () => {
    const buf = getRichBlockBuffer();
    assert.equal(buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1'), 'added');
    assert.equal(buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1'), 'duplicate');
    assert.equal(buf.add('t1', 'opus', { id: 'b2', kind: 'card', v: 1, title: 'B' }, 'inv-1'), 'added');
  });

  // Cloud Codex R6 P1: late callbacks after consume must be rejected
  it('rejects add after consume for same invocation (post-completion)', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    const blocks = buf.consume('t1', 'opus', 'inv-1');
    assert.equal(blocks.length, 1);
    // Late callback arrives after consume — must be rejected
    assert.equal(buf.add('t1', 'opus', { id: 'b2', kind: 'card', v: 1, title: 'Late' }, 'inv-1'), 'rejected');
    // But a NEW invocation for the same key should work fine
    assert.equal(buf.add('t1', 'opus', { id: 'b3', kind: 'card', v: 1, title: 'New' }, 'inv-2'), 'added');
  });

  it('keeps an interim invocation open, deduplicates across posts, and closes even with no pending blocks', () => {
    const buf = getRichBlockBuffer();
    const blockA = { id: 'a', kind: 'card', v: 1, title: 'A' };
    const blockB = { id: 'b', kind: 'card', v: 1, title: 'B' };
    assert.equal(buf.add('t1', 'opus', blockA, 'inv-open'), 'added');
    assert.deepEqual(buf.consume('t1', 'opus', 'inv-open', { final: false }), [blockA]);
    assert.equal(buf.add('t1', 'opus', blockA, 'inv-open'), 'duplicate');
    assert.equal(buf.add('t1', 'opus', blockB, 'inv-open'), 'added');
    assert.deepEqual(buf.consume('t1', 'opus', 'inv-open', { final: false }), [blockB]);
    assert.deepEqual(buf.consume('t1', 'opus', 'inv-open'), []);
    assert.equal(buf.add('t1', 'opus', { id: 'late', kind: 'card', v: 1, title: 'Late' }, 'inv-open'), 'rejected');
  });
});
