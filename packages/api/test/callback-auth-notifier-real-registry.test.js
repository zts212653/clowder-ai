/**
 * F298 regression: in-context surface MUST preserve metadata for typed
 * terminal tombstones through the real registry + preHandler path.
 *
 * Also covers: appended message classified as connector (not user) on reload
 * via the `source` field (砚砚 P1 #2).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

async function buildRealRegistryApp({ notifier }) {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
  const registry = new InvocationRegistry();
  const app = Fastify({ logger: false });
  registerCallbackAuthHook(app, registry, { notifier });
  app.get('/api/callbacks/post-message', async () => ({ ok: true }));
  await app.ready();
  return { registry, app };
}

describe('typed terminal state surfaces with real InvocationRegistry (F298)', () => {
  it('reason=interrupted triggers notifier.notify with tombstone metadata', async () => {
    const calls = [];
    const notifier = {
      async notify(params) {
        calls.push(params);
        return true;
      },
    };
    const { registry, app } = await buildRealRegistryApp({ notifier });

    const { invocationId, callbackToken } = await registry.create('user-real-1', 'opus', 'thread-real-1');
    await registry.commitTerminal({
      invocationId,
      disposition: 'interrupted',
      endedAt: Date.now(),
      endReason: 'api_restart',
      terminalRef: `turn_execution:${invocationId}`,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.reason, 'interrupted');
    assert.equal(calls.length, 1, 'notifier must receive the typed terminal event');
    assert.equal(calls[0].reason, 'interrupted');
    assert.equal(calls[0].threadId, 'thread-real-1');
    assert.equal(calls[0].catId, 'opus');
    assert.equal(calls[0].userId, 'user-real-1');
    assert.equal(calls[0].tool, 'post-message');
    await app.close();
  });

  it('reason=invalid_token also triggers notifier.notify with record metadata', async () => {
    const calls = [];
    const notifier = {
      async notify(params) {
        calls.push(params);
        return true;
      },
    };
    const { registry, app } = await buildRealRegistryApp({ notifier });
    const { invocationId } = await registry.create('user-real-2', 'codex', 'thread-real-2');

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'tok-WRONG' },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, 'invalid_token');
    assert.equal(calls[0].threadId, 'thread-real-2');
    assert.equal(calls[0].catId, 'codex');
    await app.close();
  });

  it('reason=unknown_invocation does NOT trigger notify (no record to peek)', async () => {
    const calls = [];
    const notifier = {
      async notify(params) {
        calls.push(params);
        return true;
      },
    };
    const { app } = await buildRealRegistryApp({ notifier });
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-never-existed', 'x-callback-token': 'tok' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0, 'no peek hit → no in-context surface (telemetry only)');
    await app.close();
  });
});

describe('P1 regression — message source classifies as connector on reload (F174-D2b-1)', () => {
  it('appended message has source=callback-auth so messages.ts maps to connector type', async () => {
    const { CallbackAuthSystemMessageNotifier, CALLBACK_AUTH_SOURCE } = await import(
      '../dist/routes/callback-auth-system-message.js'
    );
    const appended = [];
    const messageStore = {
      async append(msg) {
        const stored = { ...msg, id: 'm1', threadId: msg.threadId };
        appended.push(stored);
        return stored;
      },
    };
    const broadcasts = [];
    const socketManager = {
      broadcastToRoom(room, event, payload) {
        broadcasts.push({ room, event, payload });
      },
    };
    const notifier = new CallbackAuthSystemMessageNotifier({ messageStore, socketManager });
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'interrupted',
      tool: 'register_pr_tracking',
    });

    assert.equal(appended.length, 1);
    const msg = appended[0];
    assert.deepEqual(
      msg.source,
      CALLBACK_AUTH_SOURCE,
      '砚砚 P1: source must be set so reload classifies as connector not user',
    );
    assert.equal(msg.source.connector, 'callback-auth');
    // Mirror the timeline-classifier rule from messages.ts:1209:
    //   catId truthy → assistant/system; catId null → source ? 'connector' : 'user'/'system'
    // With our source set, catId=null + source=callback-auth → 'connector'.
    const derivedTimelineType = msg.catId ? 'assistant' : msg.source ? 'connector' : 'user';
    assert.equal(derivedTimelineType, 'connector', 'reload classification is connector (not user)');

    // Live socket broadcast also carries source so the live and reloaded
    // versions of the message agree on type.
    assert.equal(broadcasts.length, 1);
    assert.deepEqual(broadcasts[0].payload.message.source, CALLBACK_AUTH_SOURCE);
  });

  it('source has NO presentation:system_notice (or CallbackAuthFailureBlock would be bypassed)', async () => {
    const { CALLBACK_AUTH_SOURCE } = await import('../dist/routes/callback-auth-system-message.js');
    // 砚砚 P1 #1397 re-review: ChatMessage.tsx:60-63 routes connector +
    // meta.presentation==='system_notice' to SystemNoticeBar, which does
    // NOT render extra.rich.blocks. The dedicated CallbackAuthFailureBlock
    // would never render — defeating the entire point of D2b-1.
    const presentation = CALLBACK_AUTH_SOURCE.meta?.presentation;
    assert.notEqual(
      presentation,
      'system_notice',
      'CALLBACK_AUTH_SOURCE.meta.presentation must NOT be system_notice — would route to SystemNoticeBar and bypass rich block renderer',
    );

    // Mirror the exact ChatMessage.isConnectorSystemNotice() rule:
    //   message.type === 'connector' && message.source?.meta?.presentation === 'system_notice'
    // This message has type=connector + source set, so the only way to avoid
    // SystemNoticeBar routing is for presentation !== 'system_notice'.
    const wouldRouteToSystemNoticeBar = CALLBACK_AUTH_SOURCE.meta?.presentation === 'system_notice';
    assert.equal(
      wouldRouteToSystemNoticeBar,
      false,
      'message must NOT route to SystemNoticeBar — must hit ConnectorBubble (which renders RichBlocks)',
    );
  });
});
