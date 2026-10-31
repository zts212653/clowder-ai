/**
 * F247 AC-B1c-2 + AC-B1c-4: cloud-invoke-bridge tests.
 *
 * Pins:
 *  - dispatch returns a bounded outcome and never throws; a failure before any transport outcome
 *    is `dispatch-failed`
 *  - no adapter → fallback emitted with reason 'no-adapter'
 *  - a bound conversation is appended through the Host adapter, which returns the receipt
 *  - a missing or corrupted binding is never sent anywhere (needs-binding)
 *  - Host rejections map to typed outcomes; there is no second transport (the legacy PinchTab
 *    bridge was removed, issue #1538)
 *  - emitFallback throwing is absorbed
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  buildCloudBridgeStatusContent,
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
  sourceMessageId: 'source-message-123',
};

describe('F247 AC-B1c-2: dispatch non-throwing outcome contract', () => {
  let threadStore;
  let fallback;
  beforeEach(() => {
    threadStore = makeMockThreadStore();
    fallback = makeRecordingFallback();
  });

  it('does NOT throw to caller when adapter is null', async () => {
    const bridge = new CloudInvokeBridge({
      emitFallback: fallback.fn,
      threadStore,
    });
    await bridge.dispatch(baseParams);
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0].reason, 'no-adapter');
  });

  it('returns dispatch-failed, not a throw, when the bridge fails before any transport outcome', async () => {
    const bridge = new CloudInvokeBridge({ emitFallback: fallback.fn, threadStore });

    const outcome = await bridge.dispatch({ ...baseParams, participants: null });

    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.reason, 'dispatch-failed');
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0].reason, 'dispatch-failed');
  });

  it('does NOT throw to caller even if emitFallback throws', async () => {
    const bridge = new CloudInvokeBridge({
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
      emitFallback: fallback.fn,
      threadStore,
    });
    const outcome = await bridge.dispatchInternal(baseParams);
    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'no-adapter');
  });
});

describe('F247 Host Adapter: background append without foreground UI takeover', () => {
  it('reports needs-binding without touching the Host when the thread has no route', async () => {
    const threadStore = makeMockThreadStore();
    const fallback = makeRecordingFallback();
    let hostCalls = 0;
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async () => {
          hostCalls += 1;
          return { hostMessageId: 'must-not-send' };
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.deepEqual(outcome, {
      kind: 'fallback',
      reason: 'needs-binding',
      detail: 'Personal Chrome Host is available, but this thread has no bound ChatGPT conversation',
    });
    assert.equal(hostCalls, 0);
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0].reason, 'needs-binding');
  });

  it('treats a corrupted binding as none: needs-binding, nothing sent', async () => {
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': 'https://evil.example.com/c/abc' } });
    const fallback = makeRecordingFallback();
    let hostCalls = 0;
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async () => {
          hostCalls += 1;
          return { hostMessageId: 'must-not-send' };
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.equal(outcome.reason, 'needs-binding');
    assert.equal(hostCalls, 0);
  });

  it('routes two Clowder AI threads to two exact authorized conversation IDs without cross-talk', async () => {
    const bindingsByThread = new Map([
      ['thread_a', { 'gpt-pro': 'https://chatgpt.com/c/conversation-7' }],
      ['thread_b', { 'gpt-pro': 'https://chatgpt.com/c/conversation-8' }],
    ]);
    const threadStore = {
      get: async (threadId) => ({ id: threadId, title: threadId, participants: ['gpt-pro'] }),
      getCloudCatBindings: async (threadId) => ({ ...bindingsByThread.get(threadId) }),
      updateCloudCatBinding: async (threadId, catId, chatUrl) => {
        bindingsByThread.set(threadId, { ...bindingsByThread.get(threadId), [catId]: chatUrl });
      },
    };
    const hostCalls = [];
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async (...args) => {
          hostCalls.push(args);
          return { hostMessageId: `host-${args[0]}` };
        },
      },
      emitFallback: async () => undefined,
      threadStore,
    });

    const first = await bridge.dispatchInternal({
      ...baseParams,
      threadId: 'thread_a',
      sourceMessageId: 'source-thread-a',
    });
    const second = await bridge.dispatchInternal({
      ...baseParams,
      threadId: 'thread_b',
      sourceMessageId: 'source-thread-b',
    });

    assert.equal(first.hostMessageId, 'host-conversation-7');
    assert.equal(second.hostMessageId, 'host-conversation-8');
    assert.deepEqual(
      hostCalls.map(([conversationId, _text, idempotencyKey]) => [conversationId, idempotencyKey]),
      [
        ['conversation-7', 'source-thread-a'],
        ['conversation-8', 'source-thread-b'],
      ],
    );
  });

  it('prefers append_message for a bound conversation and returns the host message ID', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    const hostCalls = [];
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async (...args) => {
          hostCalls.push(args);
          return { hostMessageId: 'host-message-77' };
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.equal(outcome.kind, 'sent');
    assert.equal(outcome.hostMessageId, 'host-message-77');
    assert.equal(outcome.transport, 'host');
    assert.equal(hostCalls.length, 1);
    assert.equal(hostCalls[0][0], 'existing-uuid');
    assert.match(hostCalls[0][1], /help me/);
    assert.equal(hostCalls[0][2], 'source-message-123');
    assert.equal(fallback.calls.length, 0);
  });

  it('fails closed on host append failure', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async () => {
          throw new Error('host rejected append');
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.equal(outcome.kind, 'error');
    assert.equal(fallback.calls[0].reason, 'host-append-failed');
  });

  it('maps the Host exact NEEDS_BINDING rejection to the same zero-send typed outcome', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    const needsBinding = new Error('owner route is no longer authorized');
    needsBinding.code = 'NEEDS_BINDING';
    const bridge = new CloudInvokeBridge({
      hostAdapter: { append_message: async () => Promise.reject(needsBinding) },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'needs-binding');
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0].reason, 'needs-binding');
  });

  it('reports a Host failure after the request was handed over as unknown, never as not sent', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    let hostCalls = 0;
    const ambiguous = Object.assign(new Error('connection failed after the request was sent'), {
      code: 'AMBIGUOUS_EFFECT',
    });
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async () => {
          hostCalls += 1;
          throw ambiguous;
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.reason, 'host-append-failed');
    assert.equal(hostCalls, 1, 'one send, and no second transport');
    const { outboundReceipt } = JSON.parse(
      buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome,
        audit: {
          sourceMessageId: 'source-message-123',
          sourceSender: { kind: 'user', id: 'alice' },
          dispatchInvocationId: 'inv-ambiguous',
        },
      }),
    );
    assert.equal(outboundReceipt.status, 'unknown');
    assert.equal(outboundReceipt.transport, 'host');
    assert.equal(outboundReceipt.idempotency.disposition, 'unknown');
  });

  it('treats a refreshable Host with no installation as unavailable rather than a broken delivery', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    const unavailable = new Error('personal Chrome Host Adapter is not installed');
    unavailable.code = 'HOST_UNAVAILABLE';
    const bridge = new CloudInvokeBridge({
      hostAdapter: { append_message: async () => Promise.reject(unavailable) },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal(baseParams);

    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'no-adapter');
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0].reason, 'no-adapter');
  });

  it('requires the persisted source message ID and sends nothing without it', async () => {
    const existing = 'https://chatgpt.com/c/existing-uuid';
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': existing } });
    const fallback = makeRecordingFallback();
    let hostCalls = 0;
    const bridge = new CloudInvokeBridge({
      hostAdapter: {
        append_message: async () => {
          hostCalls += 1;
          return { hostMessageId: 'should-not-exist' };
        },
      },
      emitFallback: fallback.fn,
      threadStore,
    });

    const outcome = await bridge.dispatchInternal({ ...baseParams, sourceMessageId: undefined });

    assert.equal(outcome.kind, 'fallback');
    assert.equal(outcome.reason, 'missing-source-message-id');
    assert.equal(fallback.calls[0].reason, 'missing-source-message-id');
    assert.equal(hostCalls, 0);
  });
});

describe('F247 AC-B1c-4: fallback message content', () => {
  it('produces a JSON system_info-shaped block per reason', () => {
    for (const reason of [
      'no-adapter',
      'dispatch-failed',
      'host-append-failed',
      'needs-binding',
      'missing-source-message-id',
      'incomplete-dispatch-provenance',
    ]) {
      const out = buildFallbackMessageContent({ reason, catId: 'gpt-pro', detail: 'why' });
      const parsed = JSON.parse(out);
      assert.equal(parsed.type, 'cloud_bridge_status');
      assert.equal(parsed.catId, 'gpt-pro');
      assert.equal(parsed.status, 'unavailable');
      assert.equal(parsed.reason, reason);
      assert.ok(parsed.message.length > 0, 'has user-readable message');
      assert.equal(parsed.detail, 'why');
    }
  });

  it('projects a Host send as sent with its receipt, and a last-resort failure as unknown', () => {
    const audit = {
      sourceMessageId: 'source-1',
      sourceSender: { kind: 'user', id: 'alice' },
      dispatchInvocationId: 'inv-1',
    };
    const sent = JSON.parse(
      buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome: {
          kind: 'sent',
          capturedUrl: 'https://chatgpt.com/c/conversation-1',
          transport: 'host',
          hostMessageId: 'host-message-1',
        },
        audit,
      }),
    );
    assert.equal(sent.status, 'sent');
    assert.equal(sent.transport, 'host');
    assert.equal(sent.outboundReceipt.status, 'sent');
    assert.equal(sent.outboundReceipt.transport, 'host');
    assert.equal(sent.outboundReceipt.hostMessageId, 'host-message-1');

    const failed = JSON.parse(
      buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome: { kind: 'error', reason: 'dispatch-failed', message: 'boom' },
        audit,
      }),
    );
    assert.equal(failed.reason, 'dispatch-failed');
    assert.equal(failed.outboundReceipt.status, 'unknown');
    assert.equal(failed.outboundReceipt.transport, 'none');
  });

  it('preserves terminal Host failure replay truth in the durable receipt', () => {
    const parsed = JSON.parse(
      buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome: {
          kind: 'error',
          reason: 'host-append-failed',
          message: 'HOST_REJECTED',
          idempotentReplay: true,
        },
        audit: {
          sourceMessageId: 'source-failed-replay',
          sourceSender: { kind: 'user', id: 'alice' },
          dispatchInvocationId: 'inv-failed-replay',
        },
      }),
    );

    assert.equal(parsed.outboundReceipt.status, 'unknown');
    assert.equal(parsed.outboundReceipt.idempotency.disposition, 'replayed');
  });

  it('survives undefined detail', () => {
    const out = buildFallbackMessageContent({ reason: 'no-adapter', catId: 'gpt-pro' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.detail, '');
  });
});

describe('F247 AC-B1c-2: logger integration (non-essential)', () => {
  it('logs info on completion', async () => {
    const threadStore = makeMockThreadStore({ initialBindings: { 'gpt-pro': 'https://chatgpt.com/c/ok' } });
    const fallback = makeRecordingFallback();
    const { logger, events } = makeRecordingLogger();
    const bridge = new CloudInvokeBridge({
      hostAdapter: { append_message: async () => ({ hostMessageId: 'host-ok' }) },
      emitFallback: fallback.fn,
      threadStore,
      logger,
    });
    await bridge.dispatch(baseParams);
    assert.ok(events.some((e) => e.level === 'info' && /dispatch complete/.test(e.msg)));
  });
});
