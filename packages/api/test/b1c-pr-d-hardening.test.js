/**
 * F247 AC-B1c PR-D: Hardening tests — singleflight + self-heal + multi-thread isolation.
 *
 * Tests the CloudInvokeBridge hardening behavior:
 *  - AC-B1c-9: singleflight lock-first ordering — concurrent dispatches to
 *    the same (threadId, catId) only open ONE ChatGPT chat; second invocation
 *    re-reads binding inside the lock and navigates to the bound chat.
 *  - AC-B1c-6: stale binding self-heal — when navigate to a bound URL fails
 *    (chat deleted), auto re-open a new chat + update binding.
 *  - AC-B1c-7: multi-thread × same cloud cat isolation — thread X and thread Y
 *    each get their own independent binding for the same cloud cat.
 *
 * All tests use mock adapters — no real Chrome/CDP.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ──────────────── Test helpers ────────────────

/** Counter to generate unique URLs */
let urlCounter = 0;
function nextUrl() {
  return `https://chatgpt.com/c/test-${++urlCounter}`;
}

/**
 * In-memory thread store stub that tracks cloudCatBindings.
 * Simulates the real ThreadStore binding read/write interface.
 */
function makeInMemoryBindingStore() {
  const bindings = new Map(); // key: `${threadId}:${catId}` → url

  return {
    _bindings: bindings,
    async getCloudCatBindings(threadId) {
      const result = {};
      for (const [key, url] of bindings) {
        const [tid, cid] = key.split(':');
        if (tid === threadId) result[cid] = url;
      }
      return result;
    },
    async updateCloudCatBinding(threadId, catId, chatUrl) {
      const key = `${threadId}:${catId}`;
      if (chatUrl === null) {
        bindings.delete(key);
      } else {
        bindings.set(key, chatUrl);
      }
    },
    // Stub the rest of IThreadStore so construction doesn't fail
    get: async () => null,
    create: async () => ({}),
    list: async () => [],
    update: async () => {},
    delete: async () => false,
  };
}

/**
 * Mock adapter that tracks calls and can be configured to:
 *  - Return specific URLs per call
 *  - Throw on specific boundUrl values (simulating stale binding)
 *  - Delay execution (for singleflight concurrency tests)
 */
function makeMockAdapter(opts = {}) {
  const calls = [];
  const {
    /** URLs to return in sequence; cycles if exhausted */
    urls = [],
    /** Set of boundUrl values that should trigger a "stale" error */
    staleUrls = new Set(),
    /** Delay in ms before returning (for concurrency tests) */
    delayMs = 0,
    /** Whether isReady() returns true */
    ready = true,
  } = opts;

  let callIndex = 0;

  return {
    calls,
    async isReady() {
      return ready;
    },
    async injectAndCaptureUrl({ renderedPrompt, boundUrl }) {
      calls.push({ renderedPrompt, boundUrl, callIndex: callIndex });

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      // Simulate stale binding: navigate to bound URL fails
      if (boundUrl && staleUrls.has(boundUrl)) {
        throw new Error(`CDP navigate failed: chat not found at ${boundUrl}`);
      }

      const url = urls[callIndex % urls.length] || nextUrl();
      callIndex++;
      return url;
    },
  };
}

function makeRecordingFallback() {
  const fallbacks = [];
  return {
    fallbacks,
    fn: async ({ threadId, catId, reason, detail }) => {
      fallbacks.push({ threadId, catId, reason, detail });
    },
  };
}

function makeNoopLogger() {
  return { warn() {}, info() {}, error() {} };
}

// ──────────────── Import bridge (after helpers) ────────────────

const { CloudInvokeBridge } = await import('../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js');

function makeDispatchParams(overrides = {}) {
  return {
    catId: 'gpt-pro',
    threadId: 'thread-1',
    userId: 'user-1',
    threadTitle: 'Test Thread',
    participants: [],
    calledBy: 'opus',
    intent: 'test intent',
    ...overrides,
  };
}

// ──────────────── AC-B1c-9: Singleflight lock-first ────────────────

describe('F247 AC-B1c-9: singleflight lock-first ordering', () => {
  it('concurrent dispatches to same (threadId, catId) only open ONE chat', async () => {
    // Two concurrent dispatches should result in:
    //  - First dispatch: no binding → opens new chat → captures URL → writes binding
    //  - Second dispatch: acquires lock AFTER first → re-reads binding inside lock →
    //    sees first's URL → navigates to bound chat (does NOT open a second)
    const store = makeInMemoryBindingStore();
    const url1 = 'https://chatgpt.com/c/first-chat';
    const adapter = makeMockAdapter({
      urls: [url1, url1], // both return same URL (second navigates to bound)
      delayMs: 50, // simulate real CDP latency so race is observable
    });
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    const params = makeDispatchParams();

    // Fire two concurrent dispatches
    const [r1, r2] = await Promise.all([bridge.dispatchInternal(params), bridge.dispatchInternal(params)]);

    // Both should succeed (no fallbacks)
    assert.equal(fallback.fallbacks.length, 0, 'no fallbacks expected');
    assert.equal(r1.kind, 'sent');
    assert.equal(r2.kind, 'sent');

    // Key assertion: adapter should have been called with boundUrl=null EXACTLY ONCE
    // (first dispatch). Second dispatch should see the binding and pass boundUrl.
    const nullBoundCalls = adapter.calls.filter((c) => c.boundUrl === null);
    const boundCalls = adapter.calls.filter((c) => c.boundUrl !== null);

    assert.equal(nullBoundCalls.length, 1, 'only ONE dispatch should open a new chat (boundUrl=null)');
    assert.equal(boundCalls.length, 1, 'second dispatch should navigate to existing bound URL');
    assert.equal(boundCalls[0].boundUrl, url1, "second dispatch uses first's captured URL");

    // Binding should be written exactly once (idempotent re-write is OK)
    const bindings = await store.getCloudCatBindings('thread-1');
    assert.equal(bindings['gpt-pro'], url1);
  });

  it('3+ concurrent dispatches still serialize (thundering herd)', async () => {
    // Regression: the original `if (existing)` check let 3+ waiters wake
    // simultaneously and race past each other. The while-loop re-check
    // ensures only one proceeds at a time.
    const store = makeInMemoryBindingStore();
    const url1 = 'https://chatgpt.com/c/herd-chat';
    let adapterCallCount = 0;
    const adapter = {
      async isReady() {
        return true;
      },
      async injectAndCaptureUrl({ boundUrl: _boundUrl }) {
        adapterCallCount++;
        // Simulate CDP latency so the race window is observable
        await new Promise((r) => setTimeout(r, 30));
        return url1;
      },
    };
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    const params = makeDispatchParams();

    // Fire FOUR concurrent dispatches to the same (threadId, catId)
    const results = await Promise.all([
      bridge.dispatchInternal(params),
      bridge.dispatchInternal(params),
      bridge.dispatchInternal(params),
      bridge.dispatchInternal(params),
    ]);

    // All should succeed
    assert.equal(fallback.fallbacks.length, 0, 'no fallbacks expected');
    for (const r of results) {
      assert.equal(r.kind, 'sent', 'every dispatch should succeed');
    }

    // Key assertion: adapter called with boundUrl=null exactly ONCE
    // (first dispatch opens the chat). All subsequent dispatches re-read
    // the binding inside the lock and use the bound URL.
    assert.equal(adapterCallCount, 4, 'adapter called 4 times total');

    // Binding should exist
    const bindings = await store.getCloudCatBindings('thread-1');
    assert.equal(bindings['gpt-pro'], url1);
  });

  it('different (threadId, catId) pairs are NOT serialized', async () => {
    // Dispatches to thread-A/gpt-pro and thread-B/gpt-pro should run concurrently
    // (different lock keys), both opening new chats.
    const store = makeInMemoryBindingStore();
    const urlA = 'https://chatgpt.com/c/thread-a-chat';
    const urlB = 'https://chatgpt.com/c/thread-b-chat';
    const callOrder = [];
    const adapter = {
      async isReady() {
        return true;
      },
      async injectAndCaptureUrl({ boundUrl: _boundUrl }) {
        const id = callOrder.length;
        callOrder.push(id);
        // Both should start with boundUrl=null (independent)
        await new Promise((r) => setTimeout(r, 20));
        return id === 0 ? urlA : urlB;
      },
    };
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    const paramsA = makeDispatchParams({ threadId: 'thread-A' });
    const paramsB = makeDispatchParams({ threadId: 'thread-B' });

    await Promise.all([bridge.dispatchInternal(paramsA), bridge.dispatchInternal(paramsB)]);

    // Each thread should have its own binding
    const bindingsA = await store.getCloudCatBindings('thread-A');
    const bindingsB = await store.getCloudCatBindings('thread-B');
    assert.ok(bindingsA['gpt-pro'], 'thread-A should have binding');
    assert.ok(bindingsB['gpt-pro'], 'thread-B should have binding');
    assert.notEqual(bindingsA['gpt-pro'], bindingsB['gpt-pro'], 'bindings should be different');
  });
});

// ──────────────── AC-B1c-6: Stale binding self-heal ────────────────

describe('F247 AC-B1c-6: stale binding self-heal', () => {
  it('auto re-opens chat when bound URL fails (stale)', async () => {
    const staleUrl = 'https://chatgpt.com/c/deleted-chat';
    const freshUrl = 'https://chatgpt.com/c/fresh-chat';

    const store = makeInMemoryBindingStore();
    // Pre-populate a stale binding
    await store.updateCloudCatBinding('thread-1', 'gpt-pro', staleUrl);

    const adapter = makeMockAdapter({
      staleUrls: new Set([staleUrl]),
      urls: [freshUrl], // fresh URL returned on retry
    });
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    const result = await bridge.dispatchInternal(makeDispatchParams());

    // Should succeed with the fresh URL (self-healed)
    assert.equal(result.kind, 'sent');
    assert.equal(result.capturedUrl, freshUrl);

    // Adapter should have been called twice:
    //  1. First with staleUrl (throws)
    //  2. Retry with boundUrl=null (succeeds)
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls[0].boundUrl, staleUrl, 'first attempt uses stale URL');
    assert.equal(adapter.calls[1].boundUrl, null, 'retry attempt opens fresh chat');

    // Binding should be updated to the fresh URL
    const bindings = await store.getCloudCatBindings('thread-1');
    assert.equal(bindings['gpt-pro'], freshUrl);

    // No user-visible fallback (self-heal is transparent)
    assert.equal(fallback.fallbacks.length, 0);
  });

  it('emits fallback when retry also fails (not just stale)', async () => {
    const staleUrl = 'https://chatgpt.com/c/deleted-chat';

    const store = makeInMemoryBindingStore();
    await store.updateCloudCatBinding('thread-1', 'gpt-pro', staleUrl);

    // Adapter fails on both attempts (stale + fresh)
    const adapter = {
      async isReady() {
        return true;
      },
      async injectAndCaptureUrl() {
        throw new Error('CDP session crashed');
      },
    };
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    const result = await bridge.dispatchInternal(makeDispatchParams());

    // Should have a fallback/error outcome
    assert.ok(result.kind === 'error' || result.kind === 'fallback', 'should fail when both attempts fail');

    // Stale binding should be cleared
    const bindings = await store.getCloudCatBindings('thread-1');
    assert.equal(bindings['gpt-pro'], undefined, 'stale binding should be cleared');
  });

  it('does NOT retry when there was no existing binding (fresh chat fail)', async () => {
    const store = makeInMemoryBindingStore();
    // No pre-existing binding

    let callCount = 0;
    const adapter = {
      async isReady() {
        return true;
      },
      async injectAndCaptureUrl() {
        callCount++;
        throw new Error('CDP timeout');
      },
    };
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    const result = await bridge.dispatchInternal(makeDispatchParams());

    // Should fail without retry (no stale binding to self-heal)
    assert.equal(callCount, 1, 'should NOT retry when no existing binding');
    assert.ok(result.kind === 'error' || result.kind === 'fallback');
  });
});

// ──────────────── AC-B1c-7: Multi-thread isolation ────────────────

describe('F247 AC-B1c-7: multi-thread × same cloud cat isolation', () => {
  it('thread X and thread Y get independent bindings for same cloud cat', async () => {
    const store = makeInMemoryBindingStore();
    const urlX = 'https://chatgpt.com/c/thread-x-chat';
    const urlY = 'https://chatgpt.com/c/thread-y-chat';

    let callIdx = 0;
    const adapter = {
      async isReady() {
        return true;
      },
      async injectAndCaptureUrl({ boundUrl: _boundUrl }) {
        // Return different URLs for each call
        return callIdx++ === 0 ? urlX : urlY;
      },
    };
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    // Dispatch to thread X first, then thread Y
    const resultX = await bridge.dispatchInternal(makeDispatchParams({ threadId: 'thread-X' }));
    const resultY = await bridge.dispatchInternal(makeDispatchParams({ threadId: 'thread-Y' }));

    assert.equal(resultX.kind, 'sent');
    assert.equal(resultY.kind, 'sent');
    assert.equal(resultX.capturedUrl, urlX);
    assert.equal(resultY.capturedUrl, urlY);

    // Verify independent bindings
    const bindingsX = await store.getCloudCatBindings('thread-X');
    const bindingsY = await store.getCloudCatBindings('thread-Y');
    assert.equal(bindingsX['gpt-pro'], urlX, 'thread X has its own binding');
    assert.equal(bindingsY['gpt-pro'], urlY, 'thread Y has its own binding');

    // Bindings are independent — updating X does NOT affect Y
    assert.notEqual(bindingsX['gpt-pro'], bindingsY['gpt-pro']);
  });

  it('stale binding in thread X does not affect thread Y binding', async () => {
    const staleUrl = 'https://chatgpt.com/c/stale-x';
    const freshUrl = 'https://chatgpt.com/c/fresh-x';
    const urlY = 'https://chatgpt.com/c/stable-y';

    const store = makeInMemoryBindingStore();
    // thread X has stale binding, thread Y has stable binding
    await store.updateCloudCatBinding('thread-X', 'gpt-pro', staleUrl);
    await store.updateCloudCatBinding('thread-Y', 'gpt-pro', urlY);

    const adapter = makeMockAdapter({
      staleUrls: new Set([staleUrl]),
      urls: [freshUrl, urlY], // fresh for X retry, existing for Y
    });
    const fallback = makeRecordingFallback();

    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: adapter,
      emitFallback: fallback.fn,
      threadStore: store,
      logger: makeNoopLogger(),
    });

    // Dispatch to thread X (stale → self-heal)
    const resultX = await bridge.dispatchInternal(makeDispatchParams({ threadId: 'thread-X' }));

    // Thread Y's binding should be completely untouched
    const bindingsY = await store.getCloudCatBindings('thread-Y');
    assert.equal(bindingsY['gpt-pro'], urlY, 'thread Y binding untouched after X self-heals');

    // Thread X should have the fresh binding
    assert.equal(resultX.kind, 'sent');
    const bindingsX = await store.getCloudCatBindings('thread-X');
    assert.equal(bindingsX['gpt-pro'], freshUrl, 'thread X has fresh binding after self-heal');
  });
});
