/**
 * F297 AC-D4 — timeline visibility is not automatically durable human-read evidence.
 *
 * The same scenario runs against Memory and Redis so F5/reconnect cannot change
 * whether an in-flight stream is considered read.
 */

import assert from 'node:assert/strict';
import { after, describe } from 'node:test';
import { cleanupHarness, dualStoreTest } from './helpers/dual-store-harness.js';

after(cleanupHarness);

describe('F297 durable read evidence parity', () => {
  dualStoreTest('queued mutable stream is read-eligible only after final delivery', async (ctx) => {
    const earlier = await ctx.appendDirect({
      catId: 'opus',
      content: 'earlier durable speech',
      timestamp: ctx.ts(100),
    });
    const stream = await ctx.appendQueued({
      catId: 'codex-sol',
      content: 'partial stream',
      timestamp: ctx.ts(200),
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-d4', turnInvocationId: 'turn-d4' } },
    });

    const timelineBeforeFinal = await ctx.store.getLatestVisibleCursor(ctx.threadId);
    assert.equal(
      timelineBeforeFinal?.messageId,
      stream.id,
      'mutable stream remains published timeline evidence for non-read consumers',
    );
    const beforeFinal = await ctx.store.getLatestVisibleCursor(ctx.threadId, {
      evidence: 'durable_owner_read',
    });
    assert.equal(beforeFinal?.messageId, earlier.id, 'partial stream must not become durable read evidence');

    await ctx.deliver(stream, ctx.ts(300));
    const afterFinal = await ctx.store.getLatestVisibleCursor(ctx.threadId, { evidence: 'durable_owner_read' });
    assert.equal(afterFinal?.messageId, stream.id, 'final delivery makes the same bubble read-eligible');
  });

  dualStoreTest('queued non-stream cat speech remains read-eligible while published', async (ctx) => {
    const callback = await ctx.appendQueued({
      catId: 'codex-sol',
      content: 'complete callback speech',
      timestamp: ctx.ts(100),
      origin: 'callback',
    });

    const latest = await ctx.store.getLatestVisibleCursor(ctx.threadId, { evidence: 'durable_owner_read' });
    assert.equal(latest?.messageId, callback.id, 'AC-D4 must not hide complete queued speech');
  });
});
