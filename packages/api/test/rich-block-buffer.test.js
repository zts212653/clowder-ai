import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import {
  getRichBlockBuffer,
  RichBlockBuffer,
} from '../dist/domains/cats/services/agents/invocation/RichBlockBuffer.js';

describe('RichBlockBuffer', () => {
  beforeEach(() => {
    getRichBlockBuffer().destroy();
  });

  after(() => {
    getRichBlockBuffer().destroy();
  });

  it('add + consume round trip', async () => {
    const buf = getRichBlockBuffer();
    const block = { id: 'b1', kind: 'card', v: 1, title: 'Test' };
    buf.add('t1', 'opus', block);
    const result = await buf.consume('t1', 'opus');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'b1');
  });

  it('consume clears buffer', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'Test' });
    await buf.consume('t1', 'opus');
    const second = await buf.consume('t1', 'opus');
    assert.equal(second.length, 0);
  });

  it('accumulates multiple blocks for same key', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' });
    buf.add('t1', 'opus', { id: 'b2', kind: 'diff', v: 1, filePath: 'a.ts', diff: '+x' });
    const result = await buf.consume('t1', 'opus');
    assert.equal(result.length, 2);
  });

  it('checks only rich block kind for the exact in-flight invocation', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'codex-sol', { id: 'html-1', kind: 'html_widget', v: 1, html: '<p>ELI5</p>' }, 'inv-1');
    assert.equal(buf.hasKind('t1', 'codex-sol', 'inv-1', 'html_widget'), true);
    assert.equal(buf.hasKind('t1', 'codex-sol', 'inv-other', 'html_widget'), false);
    assert.equal(buf.hasKind('t1', 'codex-sol', 'inv-1', 'card'), false);
  });

  it('isolates different thread/cat keys', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' });
    buf.add('t1', 'codex', { id: 'b2', kind: 'card', v: 1, title: 'B' });
    buf.add('t2', 'opus', { id: 'b3', kind: 'card', v: 1, title: 'C' });
    assert.equal((await buf.consume('t1', 'opus')).length, 1);
    assert.equal((await buf.consume('t1', 'codex')).length, 1);
    assert.equal((await buf.consume('t2', 'opus')).length, 1);
  });

  it('consume returns empty for non-existent key', async () => {
    const buf = getRichBlockBuffer();
    const result = await buf.consume('nonexistent', 'opus');
    assert.deepEqual(result, []);
  });

  it('destroy clears all entries', () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' });
    buf.destroy();
    assert.equal(buf.size, 0);
  });

  // P1-2: consume with invocationId rejects mismatched entries
  it('consume rejects blocks from a different invocationId', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'Old' }, 'inv-old');
    // Consuming with a different invocationId should return empty
    const result = await buf.consume('t1', 'opus', 'inv-new');
    assert.equal(result.length, 0);
  });

  it('consume returns blocks matching invocationId', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    const result = await buf.consume('t1', 'opus', 'inv-1');
    assert.equal(result.length, 1);
  });

  // R2 P1-1 regression: preemption scenario — old invocation must NOT consume new invocation's blocks
  it('preemption: each invocation only gets its own blocks', async () => {
    const buf = getRichBlockBuffer();
    // Invocation A adds a block
    buf.add('t1', 'opus', { id: 'a1', kind: 'card', v: 1, title: 'A-block' }, 'inv-A');
    // Invocation B starts (preempts A) — add() with new invocationId replaces A's blocks
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'B-block' }, 'inv-B');
    // Old invocation A tries consume with its OWN id (correct fix) — gets nothing
    const resultA = await buf.consume('t1', 'opus', 'inv-A');
    assert.equal(resultA.length, 0, 'Old invocation A must not get blocks');
    // Cloud Codex P1: mismatched consume must NOT delete B's blocks
    // B consumes with its own id — gets its block (no re-add needed)
    const resultB = await buf.consume('t1', 'opus', 'inv-B');
    assert.equal(resultB.length, 1, 'New invocation B must get its own blocks');
    assert.equal(resultB[0].id, 'b1');
  });

  // Cloud Codex P1 regression: mismatched consume must preserve newer entry
  it('mismatched consume preserves newer invocation blocks', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'B-block' }, 'inv-B');
    // A consumes with wrong (own) id — should return empty WITHOUT deleting B's entry
    assert.equal((await buf.consume('t1', 'opus', 'inv-A')).length, 0);
    // B's blocks must still be intact
    const resultB = await buf.consume('t1', 'opus', 'inv-B');
    assert.equal(resultB.length, 1, 'B blocks preserved after mismatched consume');
    assert.equal(resultB[0].id, 'b1');
  });

  // P2-1: deduplication by block.id
  it('deduplicates blocks with same id', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    buf.add('t1', 'opus', { id: 'b2', kind: 'card', v: 1, title: 'B' }, 'inv-1');
    const result = await buf.consume('t1', 'opus', 'inv-1');
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
  it('rejects add after consume for same invocation (post-completion)', async () => {
    const buf = getRichBlockBuffer();
    buf.add('t1', 'opus', { id: 'b1', kind: 'card', v: 1, title: 'A' }, 'inv-1');
    const blocks = await buf.consume('t1', 'opus', 'inv-1');
    assert.equal(blocks.length, 1);
    // Late callback arrives after consume — must be rejected
    assert.equal(buf.add('t1', 'opus', { id: 'b2', kind: 'card', v: 1, title: 'Late' }, 'inv-1'), 'rejected');
    // But a NEW invocation for the same key should work fine
    assert.equal(buf.add('t1', 'opus', { id: 'b3', kind: 'card', v: 1, title: 'New' }, 'inv-2'), 'added');
  });

  it('keeps an interim invocation open, deduplicates across posts, and closes even with no pending blocks', async () => {
    const buf = getRichBlockBuffer();
    const blockA = { id: 'a', kind: 'card', v: 1, title: 'A' };
    const blockB = { id: 'b', kind: 'card', v: 1, title: 'B' };
    assert.equal(buf.add('t1', 'opus', blockA, 'inv-open'), 'added');
    assert.deepEqual(await buf.consume('t1', 'opus', 'inv-open', { final: false }), [blockA]);
    assert.equal(buf.add('t1', 'opus', blockA, 'inv-open'), 'duplicate');
    assert.equal(buf.add('t1', 'opus', blockB, 'inv-open'), 'added');
    assert.deepEqual(await buf.consume('t1', 'opus', 'inv-open', { final: false }), [blockB]);
    assert.deepEqual(await buf.consume('t1', 'opus', 'inv-open'), []);
    assert.equal(buf.add('t1', 'opus', { id: 'late', kind: 'card', v: 1, title: 'Late' }, 'inv-open'), 'rejected');
  });
  it('replaces a pending same-id revision in place and still deduplicates retries', async () => {
    const buf = getRichBlockBuffer();
    const draft = { id: 'widget', kind: 'html_widget', v: 1, html: '<button onclick="go()">Go</button>' };
    const corrected = { ...draft, html: '<button id="go">Go</button><script>bind()</script>' };
    const other = { id: 'other', kind: 'card', v: 1, title: 'Keep order' };
    assert.equal(buf.add('t1', 'opus', draft, 'inv-edit'), 'added');
    buf.add('t1', 'opus', other, 'inv-edit');
    assert.equal(buf.add('t1', 'opus', corrected, 'inv-edit'), 'updated');
    assert.equal(buf.add('t1', 'opus', { ...corrected }, 'inv-edit'), 'duplicate');
    assert.deepEqual(await buf.consume('t1', 'opus', 'inv-edit'), [corrected, other]);
  });

  it('rejects changed revisions already attached to an interim post instead of claiming success', async () => {
    const buf = getRichBlockBuffer();
    const block = { id: 'widget', kind: 'html_widget', v: 1, html: '<p>Published</p>' };
    buf.add('t1', 'opus', block, 'inv-post');
    await buf.consume('t1', 'opus', 'inv-post', { final: false });
    assert.equal(buf.add('t1', 'opus', { ...block }, 'inv-post'), 'duplicate');
    assert.equal(buf.add('t1', 'opus', { ...block, html: '<p>Changed</p>' }, 'inv-post'), 'published');
    assert.deepEqual(await buf.consume('t1', 'opus', 'inv-post'), []);
  });
  it('only a matching publication receipt owns reserved blocks, even when an older receipt has identical bytes', async () => {
    const buf = getRichBlockBuffer();
    const draft = { id: 'stage', kind: 'html_widget', v: 1, html: '<p>Draft</p>' };
    const corrected = { ...draft, html: '<p>Corrected</p>' };
    buf.add('t1', 'opus', draft, 'inv-reserve');
    const held = buf.reserve('t1', 'opus', 'inv-reserve');
    assert.deepEqual(held.blocks, [draft]);
    assert.equal(buf.add('t1', 'opus', corrected, 'inv-reserve'), 'busy');
    assert.equal(buf.reserve('t1', 'opus', 'inv-reserve'), 'busy');
    held.commit({ publicationId: 'different-prior-publication', blocks: [draft] });
    held.release();
    assert.equal(buf.add('t1', 'opus', corrected, 'inv-reserve'), 'updated');
    const posted = buf.reserve('t1', 'opus', 'inv-reserve');
    assert.notEqual(posted.publicationId, held.publicationId, 'later reservations have independent ownership');
    posted.commit({ publicationId: posted.publicationId, blocks: [corrected] });
    posted.release();
    assert.equal(buf.add('t1', 'opus', draft, 'inv-reserve'), 'published');
    assert.deepEqual(await buf.consume('t1', 'opus', 'inv-reserve'), []);
  });
  it('successors cannot settle live writers, and confirmed outcomes leave each invocation with only its own blocks', async () => {
    const { setImmediate } = await import('node:timers/promises');
    const buf = getRichBlockBuffer();
    const first = { id: 'first', kind: 'card', v: 1, title: 'Old invocation' };
    const next = { ...first, id: 'next', title: 'New invocation' };
    for (const published of [false, true]) {
      const oldId = `inv-wait-old-${published}`;
      const nextId = `inv-wait-new-${published}`;
      buf.add('t1', 'opus', first, oldId);
      const oldPost = buf.reserve('t1', 'opus', oldId);
      let settled = false;
      const oldFinal = buf.consume('t1', 'opus', oldId).then((blocks) => {
        settled = true;
        return blocks;
      });
      assert.equal(buf.reserve('t1', 'opus', oldId), 'rejected');
      buf.add('t1', 'opus', next, nextId);
      await setImmediate();
      assert.equal(settled, false, 'only the actual writer may settle its reservation');
      if (published) oldPost.commit({ publicationId: oldPost.publicationId, blocks: [first] });
      oldPost.release();
      assert.deepEqual(await oldFinal, published ? [] : [first]);
      assert.deepEqual(await buf.consume('t1', 'opus', nextId), [next]);
    }
  });

  it('idle cleanup preserves active revision history and final fences, and restarts idle age on release', async (t) => {
    const buf = new RichBlockBuffer({ ttlMs: 10 });
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const block = { id: 'stage', kind: 'card', v: 1, title: 'Latest' };
    try {
      buf.add('t1', 'opus', block, 'inv-clock', { requestId: 'B', issuedAt: 2 });
      now += 11;
      const lease = buf.reserve('t1', 'opus', 'inv-clock');
      assert.equal(buf.hasBlock('t1', 'stage'), true);
      assert.equal(
        buf.add('t1', 'opus', { ...block, title: 'Old' }, 'inv-clock', { requestId: 'A', issuedAt: 1 }),
        'duplicate',
      );
      lease.release(); // No write was attempted, so failure/held can return ownership safely.
      assert.equal(buf.hasBlock('t1', 'stage'), true, 'release starts a fresh idle interval');
      const writing = buf.reserve('t1', 'opus', 'inv-clock');
      const final = buf.consume('t1', 'opus', 'inv-clock');
      now += 11;
      assert.equal(buf.hasBlock('t1', 'stage'), true);
      assert.equal(buf.add('t1', 'opus', block, 'inv-clock'), 'rejected', 'a live terminal fence must not expire');
      writing.release();
      assert.deepEqual(await final, [block]);
      buf.add('t1', 'opus', block, 'inv-idle');
      now += 11;
      assert.equal(buf.hasBlock('t1', 'stage'), false, 'idle orphan cleanup remains bounded');
    } finally {
      buf.destroy();
    }
  });

  it('shutdown releases terminal waiters without transferring any successor blocks', async () => {
    const buf = getRichBlockBuffer();
    const first = { id: 'first', kind: 'card', v: 1, title: 'Shutdown' };
    buf.add('t1', 'opus', first, 'inv-wait-shutdown');
    const shutdownPost = buf.reserve('t1', 'opus', 'inv-wait-shutdown');
    const shutdownFinal = buf.consume('t1', 'opus', 'inv-wait-shutdown');
    buf.destroy();
    assert.deepEqual(await shutdownFinal, []);
    shutdownPost.release();
  });
});
