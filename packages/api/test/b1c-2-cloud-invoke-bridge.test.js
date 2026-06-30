/**
 * F247 AC-B1c-2 + AC-B1c-4 + AC-B1c-11 (defense-in-depth): cloud-invoke-bridge tests.
 *
 * Pins:
 *  - dispatch is fire-and-forget — never throws to caller, even if adapter throws
 *  - no adapter → fallback emitted with reason 'no-adapter'
 *  - adapter.isReady=false → fallback 'adapter-not-ready'
 *  - adapter.injectAndCaptureUrl rejects → fallback 'inject-failed'
 *  - captured URL fails regex → fallback 'invalid-captured-url' + binding NOT written
 *  - happy path: adapter returns canonical URL → binding written + outcome='sent'
 *  - reading existing binding feeds adapter (`boundUrl`)
 *  - corrupted db URL (regex mismatch) is treated as no binding (adapter opens new chat)
 *  - emitFallback throwing is absorbed
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  buildFallbackMessageContent,
  CloudInvokeBridge,
} from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';

function makeMockThreadStore({ initialBindings = {} } = {}) {
  const state = { bindings: { ...initialBindings } };
  return {
    state,
    get: async (_id) => ({ id: 'thread_t1', title: 'demo', participants: ['opus-47', 'gpt-pro'] }),
    getCloudCatBindings: async (_id) => ({ ...state.bindings }),
    updateCloudCatBinding: async (_id, catId, chatUrl) => {
      if (chatUrl === null) {
        delete state.bindings[catId];
      } else {
        state.bindings[catId] = chatUrl;
      }
    },
  };
}

function makeRecordingFallback() {
  const calls = [];
  return {
    calls,
    fn: async (params) => {
      calls.push(params);
    },
  };
}

function makeRecordingLogger() {
  const events = [];
  return {
    events,
    logger: {
      warn: (ctx, msg) => events.push({ level: 'warn', ctx, msg }),
      info: (ctx, msg) => events.push({ level: 'info', ctx, msg }),
    },
  };
}

const baseParams = {
  catId: 'gpt-pro',
  threadId: 'thread_t1',
  userId: 'alice',
  threadTitle: 'demo',
  participants: [
    { catId: 'opus-47', handle: '@opus47' },
    { catId: 'gpt-pro', handle: '@gpt-pro' },
  ],
  calledBy: 'opus-47',
  intent: 'help me',
};

describe('F247 AC-B1c-2: dispatch fire-and-forget contract', () => {
  let threadStore;
  let fallback;
  beforeEach(() => {
    threadStore = makeMockThreadStore();
    fallback = makeRecordingFallback();
  });

  it('does NOT throw to caller when adapter is null', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: null,
      emitFallback: fallback.fn,
      threadStore,
    });
    await bridge.dispatch(baseParams);
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0].reason, 'no-adapter');
  });

  it('does NOT throw to caller when adapter throws inside isReady', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => {
          throw new Error('boom');
        },
        injectAndCaptureUrl: async () => 'unused',
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    await assert.doesNotReject(() => bridge.dispatch(baseParams));
    assert.equal(fallback.calls[0].reason, 'adapter-not-ready');
  });

  it('does NOT throw to caller when adapter.injectAndCaptureUrl rejects', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async () => {
          throw new Error('selector missing');
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    await assert.doesNotReject(() => bridge.dispatch(baseParams));
    assert.equal(fallback.calls[0].reason, 'inject-failed');
  });

  it('does NOT throw to caller even if emitFallback throws', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: null,
      emitFallback: async () => {
        throw new Error('fallback broken too');
      },
      threadStore,
    });
    await assert.doesNotReject(() => bridge.dispatch(baseParams));
    // No way to observe — but the test that it doesn't throw is the contract.
  });
});

describe('F247 AC-B1c-2: dispatchInternal outcome (observable)', () => {
  let threadStore;
  let fallback;
  beforeEach(() => {
    threadStore = makeMockThreadStore();
    fallback = makeRecordingFallback();
  });

  it('returns kind=fallback reason=no-adapter when adapter is null', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: null,
      emitFallback: fallback.fn,
      threadStore,
    });
    const outcome = await bridge.dispatchInternal(baseParams);
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'no-adapter');
  });

  it('returns kind=fallback reason=adapter-not-ready when adapter says not ready', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => false,
        injectAndCaptureUrl: async () => 'unused',
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    const outcome = await bridge.dispatchInternal(baseParams);
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'adapter-not-ready');
  });

  it('returns kind=sent with capturedUrl on happy path', async () => {
    const captured = 'https://chatgpt.com/c/abc-123-uuid';
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async () => captured,
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    const outcome = await bridge.dispatchInternal(baseParams);
    assert.equal(outcome.kind, 'sent');
    assert.equal(outcome.capturedUrl, captured);
    assert.equal(threadStore.state.bindings['gpt-pro'], captured, 'binding written');
    assert.equal(fallback.calls.length, 0, 'no fallback emitted');
  });

  it('returns kind=fallback reason=invalid-captured-url when adapter returns non-canonical URL', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async () => 'http://evil.com/c/abc', // wrong scheme/host
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    const outcome = await bridge.dispatchInternal(baseParams);
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'invalid-captured-url');
    assert.equal(threadStore.state.bindings['gpt-pro'], undefined, 'binding NOT written for invalid URL');
  });

  it('returns kind=error when adapter inject throws', async () => {
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async () => {
          throw new Error('DOM moved');
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    const outcome = await bridge.dispatchInternal(baseParams);
    assert.equal(outcome.kind, 'error');
    assert.match(outcome.message, /DOM moved/);
    assert.equal(fallback.calls[0].reason, 'inject-failed');
  });
});

describe('F247 AC-B1c-2: existing binding read + corruption-safe', () => {
  it('feeds adapter boundUrl from threadStore when binding exists', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    let capturedArgs;
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async (args) => {
          capturedArgs = args;
          return existing;
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    await bridge.dispatchInternal(baseParams);
    assert.equal(capturedArgs.boundUrl, existing);
  });

  it('treats corrupted binding (regex mismatch) as no binding', async () => {
    const threadStore = makeMockThreadStore({
      initialBindings: { 'gpt-pro': 'http://evil.com/corrupted' },
    });
    const fallback = makeRecordingFallback();
    let capturedArgs;
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async (args) => {
          capturedArgs = args;
          return 'https://chatgpt.com/c/new-uuid';
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    await bridge.dispatchInternal(baseParams);
    assert.equal(capturedArgs.boundUrl, null, 'corrupted URL treated as no binding');
  });

  it('rebinds even when previous binding was valid (new URL captured)', async () => {
    const oldUrl = 'https://chatgpt.com/c/old-uuid';
    const newUrl = 'https://chatgpt.com/c/new-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': oldUrl } });
    const fallback = makeRecordingFallback();
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async () => newUrl,
      },
      emitFallback: fallback.fn,
      threadStore,
    });
    await bridge.dispatchInternal(baseParams);
    assert.equal(threadStore.state.bindings['gpt-pro'], newUrl);
  });
});

describe('F247 AC-B1c-4: fallback message content', () => {
  it('produces a JSON system_info-shaped block per reason', () => {
    for (const reason of ['no-adapter', 'adapter-not-ready', 'inject-failed', 'invalid-captured-url']) {
      const out = buildFallbackMessageContent({ reason, catId: 'gpt-pro', detail: 'why' });
      const parsed = JSON.parse(out);
      assert.equal(parsed.type, 'b1c_bridge_fallback');
      assert.equal(parsed.catId, 'gpt-pro');
      assert.equal(parsed.reason, reason);
      assert.ok(parsed.headline.length > 0, 'has user-readable headline');
      assert.equal(parsed.detail, 'why');
    }
  });

  it('survives undefined detail', () => {
    const out = buildFallbackMessageContent({ reason: 'no-adapter', catId: 'gpt-pro' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.detail, '');
  });
});

describe('F247 AC-B1c-2: logger integration (non-essential)', () => {
  it('logs info on completion', async () => {
    const threadStore = makeMockThreadStore();
    const fallback = makeRecordingFallback();
    const { logger, events } = makeRecordingLogger();
    const bridge = new CloudInvokeBridge({
      pinchTabAdapter: {
        isReady: async () => true,
        injectAndCaptureUrl: async () => 'https://chatgpt.com/c/ok',
      },
      emitFallback: fallback.fn,
      threadStore,
      logger,
    });
    await bridge.dispatch(baseParams);
    assert.ok(events.some((e) => e.level === 'info' && /dispatch complete/.test(e.msg)));
  });
});
