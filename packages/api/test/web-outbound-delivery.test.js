import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { cleanupStreamingOnFailure, deliverOutboundFromWeb } from '../dist/routes/messages.js';

function noopLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog() };
}

function makeOpts(overrides = {}) {
  return {
    registry: {},
    messageStore: {},
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
    router: {},
    ...overrides,
  };
}

describe('deliverOutboundFromWeb (F088 ISSUE-15)', () => {
  let deliverCalls;
  let streamCalls;
  let mockOutboundHook;
  let mockStreamingHook;

  beforeEach(() => {
    deliverCalls = [];
    streamCalls = { start: [], chunk: [], end: [], cleanup: [] };

    mockOutboundHook = {
      async deliver(threadId, content, catId, richBlocks, threadMeta) {
        deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
      },
    };

    mockStreamingHook = {
      async onStreamStart(threadId, catId, invocationId) {
        streamCalls.start.push({ threadId, catId, invocationId });
      },
      async onStreamChunk(threadId, text, invocationId) {
        streamCalls.chunk.push({ threadId, text, invocationId });
      },
      async onStreamEnd(threadId, text, invocationId) {
        streamCalls.end.push({ threadId, text, invocationId });
      },
      async cleanupPlaceholders(threadId, invocationId) {
        streamCalls.cleanup.push({ threadId, invocationId });
      },
    };
  });

  it('delivers single-turn text to outbound hook', async () => {
    const opts = makeOpts({ outboundHook: mockOutboundHook });
    const turns = [{ catId: 'opus', textParts: ['Hello ', 'world'] }];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['Hello ', 'world'], turns, ctx, undefined, opts, noopLog());

    assert.equal(deliverCalls.length, 1);
    assert.equal(deliverCalls[0].threadId, 't-1');
    assert.equal(deliverCalls[0].content, 'Hello world');
    assert.equal(deliverCalls[0].catId, 'opus');
  });

  it('delivers multi-turn text per-cat', async () => {
    const opts = makeOpts({ outboundHook: mockOutboundHook });
    const turns = [
      { catId: 'opus', textParts: ['First cat'] },
      { catId: 'codex', textParts: ['Second cat'] },
    ];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb(
      't-1',
      'opus',
      'inv-1',
      ['First cat', 'Second cat'],
      turns,
      ctx,
      undefined,
      opts,
      noopLog(),
    );

    assert.equal(deliverCalls.length, 2);
    assert.equal(deliverCalls[0].content, 'First cat');
    assert.equal(deliverCalls[0].catId, 'opus');
    assert.equal(deliverCalls[1].content, 'Second cat');
    assert.equal(deliverCalls[1].catId, 'codex');
  });

  it('uses turn-based aggregate for stream end when a later turn was replace-mode rewritten', async () => {
    const opts = makeOpts({
      outboundHook: mockOutboundHook,
      streamingHook: mockStreamingHook,
    });
    const turns = [
      { catId: 'opus', textParts: ['First cat. '] },
      { catId: 'antigravity', textParts: ['Second cat rewritten.'] },
    ];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb(
      't-1',
      'opus',
      'inv-1',
      ['Second cat rewritten.'],
      turns,
      ctx,
      undefined,
      opts,
      noopLog(),
    );

    assert.equal(streamCalls.end.length, 1);
    assert.equal(streamCalls.end[0].text, 'First cat. Second cat rewritten.');
  });

  it('does not call deliver when outboundHook is absent', async () => {
    const opts = makeOpts();
    const turns = [{ catId: 'opus', textParts: ['test'] }];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['test'], turns, ctx, undefined, opts, noopLog());
    assert.equal(deliverCalls.length, 0);
  });

  it('does not call deliver when no content collected', async () => {
    const opts = makeOpts({ outboundHook: mockOutboundHook });
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', [], [], ctx, undefined, opts, noopLog());
    assert.equal(deliverCalls.length, 0);
  });

  it('includes richBlocks in delivery', async () => {
    const opts = makeOpts({ outboundHook: mockOutboundHook });
    const blocks = [{ id: 'rb1', kind: 'card' }];
    const turns = [{ catId: 'opus', textParts: ['msg'], richBlocks: blocks }];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['msg'], turns, ctx, undefined, opts, noopLog());

    assert.equal(deliverCalls.length, 1);
    assert.deepEqual(deliverCalls[0].richBlocks, blocks);
  });

  it('calls streaming lifecycle: start → end → cleanup', async () => {
    const opts = makeOpts({
      outboundHook: mockOutboundHook,
      streamingHook: mockStreamingHook,
    });
    const turns = [{ catId: 'opus', textParts: ['hi'] }];
    const ctx = { failed: false, errors: [] };
    const startPromise = mockStreamingHook.onStreamStart('t-1', 'opus', 'inv-1');

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['hi'], turns, ctx, startPromise, opts, noopLog());

    assert.equal(streamCalls.end.length, 1);
    assert.equal(streamCalls.end[0].text, 'hi');
    assert.equal(streamCalls.cleanup.length, 1);
    assert.equal(streamCalls.cleanup[0].threadId, 't-1');
  });

  it('cleans up placeholders even when no outbound hook (stream-only)', async () => {
    const opts = makeOpts({ streamingHook: mockStreamingHook });
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb(
      't-1',
      'opus',
      'inv-1',
      ['text'],
      [{ catId: 'opus', textParts: ['text'] }],
      ctx,
      undefined,
      opts,
      noopLog(),
    );

    assert.equal(streamCalls.end.length, 1);
    assert.equal(streamCalls.cleanup.length, 1);
  });

  it('does not throw when outbound deliver fails', async () => {
    const failHook = {
      async deliver() {
        throw new Error('network error');
      },
    };
    const opts = makeOpts({ outboundHook: failHook });
    const turns = [{ catId: 'opus', textParts: ['test'] }];
    const ctx = { failed: false, errors: [] };

    await assert.doesNotReject(
      deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['test'], turns, ctx, undefined, opts, noopLog()),
    );
  });

  it('does not throw when streaming hook fails', async () => {
    const failStreamHook = {
      async onStreamStart() {
        throw new Error('boom');
      },
      async onStreamChunk() {
        throw new Error('boom');
      },
      async onStreamEnd() {
        throw new Error('boom');
      },
      async cleanupPlaceholders() {
        throw new Error('boom');
      },
    };
    const opts = makeOpts({
      outboundHook: mockOutboundHook,
      streamingHook: failStreamHook,
    });
    const turns = [{ catId: 'opus', textParts: ['msg'] }];
    const ctx = { failed: false, errors: [] };
    const failedStart = failStreamHook.onStreamStart('t-1', 'opus', 'inv-1').catch(() => {});

    await assert.doesNotReject(
      deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['msg'], turns, ctx, failedStart, opts, noopLog()),
    );
  });

  it('resolves threadMeta from threadStore when available', async () => {
    const mockThreadStore = {
      get(id) {
        return Promise.resolve({ id, title: 'Test Thread' });
      },
    };
    const opts = makeOpts({
      outboundHook: mockOutboundHook,
      threadStore: mockThreadStore,
    });
    const turns = [{ catId: 'opus', textParts: ['hello'] }];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['hello'], turns, ctx, undefined, opts, noopLog());

    assert.equal(deliverCalls.length, 1);
    assert.ok(deliverCalls[0].threadMeta);
    assert.equal(deliverCalls[0].threadMeta.threadTitle, 'Test Thread');
    assert.match(deliverCalls[0].threadMeta.deepLinkUrl, /\/thread\/t-1$/);
    assert.ok(!deliverCalls[0].threadMeta.deepLinkUrl.includes('/threads/'));
  });
});

describe('cleanupStreamingOnFailure (P1 regression)', () => {
  it('calls onStreamEnd + cleanupPlaceholders on failure path', async () => {
    const calls = { end: [], cleanup: [] };
    const hook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd(threadId, text, invocationId) {
        calls.end.push({ threadId, text, invocationId });
      },
      async cleanupPlaceholders(threadId, invocationId) {
        calls.cleanup.push({ threadId, invocationId });
      },
    };
    const opts = makeOpts({ streamingHook: hook });

    await cleanupStreamingOnFailure('t-1', 'inv-1', undefined, opts, noopLog());

    assert.equal(calls.end.length, 1);
    assert.equal(calls.end[0].text, '');
    assert.equal(calls.cleanup.length, 1);
    assert.equal(calls.cleanup[0].threadId, 't-1');
  });

  it('waits for streamStartPromise before ending', async () => {
    let startResolved = false;
    const calls = { end: [] };
    const hook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd(threadId, text, invocationId) {
        calls.end.push({ startResolved });
      },
      async cleanupPlaceholders() {},
    };
    const opts = makeOpts({ streamingHook: hook });
    const startPromise = new Promise((resolve) => {
      setTimeout(() => {
        startResolved = true;
        resolve();
      }, 10);
    });

    await cleanupStreamingOnFailure('t-1', 'inv-1', startPromise, opts, noopLog());

    assert.equal(calls.end.length, 1);
    assert.equal(calls.end[0].startResolved, true);
  });

  it('is a no-op when streamingHook is absent', async () => {
    const opts = makeOpts();
    await assert.doesNotReject(cleanupStreamingOnFailure('t-1', 'inv-1', undefined, opts, noopLog()));
  });

  it('does not throw when streaming hooks fail', async () => {
    const hook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd() {
        throw new Error('boom');
      },
      async cleanupPlaceholders() {
        throw new Error('boom');
      },
    };
    const opts = makeOpts({ streamingHook: hook });

    await assert.doesNotReject(cleanupStreamingOnFailure('t-1', 'inv-1', undefined, opts, noopLog()));
  });
});

describe('deliverOutboundFromWeb fire-and-forget safety (P2 regression)', () => {
  it('handles internal errors gracefully when called fire-and-forget', async () => {
    const failHook = {
      async deliver() {
        throw new Error('connector down');
      },
    };
    const opts = makeOpts({ outboundHook: failHook });
    const turns = [{ catId: 'opus', textParts: ['msg'] }];
    const ctx = { failed: false, errors: [] };

    const promise = deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['msg'], turns, ctx, undefined, opts, noopLog());
    await assert.doesNotReject(promise);
  });

  it('completes without awaiting slow thread lookup', async () => {
    let delivered = false;
    const hook = {
      async deliver() {
        delivered = true;
      },
    };
    const slowThreadStore = {
      get() {
        return new Promise((resolve) => setTimeout(() => resolve({ id: 't-1', title: 'slow' }), 50));
      },
    };
    const opts = makeOpts({ outboundHook: hook, threadStore: slowThreadStore });
    const turns = [{ catId: 'opus', textParts: ['msg'] }];
    const ctx = { failed: false, errors: [] };

    await deliverOutboundFromWeb('t-1', 'opus', 'inv-1', ['msg'], turns, ctx, undefined, opts, noopLog());
    assert.equal(delivered, true);
  });
});

describe('cleanupStreamingOnFailure timeout alignment (P1-B regression)', () => {
  it('waits up to 5s for slow streamStartPromise before cleaning up', async () => {
    const calls = { end: [] };
    const hook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd(threadId, text, invocationId) {
        calls.end.push({ threadId, text, invocationId });
      },
      async cleanupPlaceholders() {},
    };
    const opts = makeOpts({ streamingHook: hook });

    let resolveStart;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });

    const cleanupPromise = cleanupStreamingOnFailure('t-1', 'inv-1', startPromise, opts, noopLog());

    // Resolve after 50ms (well within 5s timeout) — should be awaited
    setTimeout(() => resolveStart(), 50);
    await cleanupPromise;

    assert.equal(calls.end.length, 1, 'onStreamEnd should be called after startPromise resolves');
  });

  it('times out and still cleans up if streamStartPromise never resolves', { timeout: 10_000 }, async () => {
    const calls = { end: [], cleanup: [] };
    const hook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd(threadId, text, invocationId) {
        calls.end.push({ threadId, text, invocationId });
      },
      async cleanupPlaceholders(threadId, invocationId) {
        calls.cleanup.push({ threadId, invocationId });
      },
    };
    const opts = makeOpts({ streamingHook: hook });

    // A promise that never resolves — cleanup should still proceed after timeout
    const neverResolves = new Promise(() => {});
    await cleanupStreamingOnFailure('t-1', 'inv-1', neverResolves, opts, noopLog());

    assert.equal(calls.end.length, 1, 'onStreamEnd should be called after timeout');
    assert.equal(calls.cleanup.length, 1, 'cleanupPlaceholders should be called after timeout');
  });
});
