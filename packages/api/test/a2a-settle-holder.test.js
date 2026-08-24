/**
 * F086/F216 — INV-2 HOLDER: every group settles through ONE exit, and a failing summary write can
 * never surface as an unhandledRejection.
 *
 * 砚砚 flagged the bare detached flush in R4, I fixed the one site he named, and R5 found the same
 * hole at three sites — including one my own R4 fix had just added. That is the signature of
 * enumerating branches instead of owning the transition: the branch count grows while you patch.
 *
 * Parameterised by ENTRY POINT, because entry points are exactly what kept getting missed:
 *   - completion hook   (a queued target finishes)
 *   - queue all-rejected (nothing could be admitted)
 *   - legacy all-failed  (every admission threw)
 *   - legacy dispatch error (an admitted target crashes while executing)
 * ADDING A SETTLE TRIGGER MEANS ADDING A ROW HERE.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { resetMultiMentionOrchestrator } from '../dist/routes/callback-multi-mention-routes.js';

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId) {
      const id = `inv-${records.size}`;
      const token = `tok-${records.size}`;
      records.set(id, {
        catId,
        threadId,
        userId,
        invocationId: id,
        callbackToken: token,
        ownerAuthProvenance: 'strict',
      });
      return { invocationId: id, callbackToken: token };
    },
    async verify(invocationId, callbackToken) {
      const r = records.get(invocationId);
      if (!r) return { ok: false, reason: 'unknown_invocation' };
      if (r.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
      return { ok: true, record: r };
    },
    isLatest: () => true,
    claimClientMessageId: () => true,
  };
}

/** Captures unhandled rejections for the duration of one scenario. */
async function withRejectionWatch(fn) {
  const seen = [];
  const onRejection = (err) => seen.push(err instanceof Error ? err.message : String(err));
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    // Unhandled rejections are reported at the end of a microtask checkpoint — give them room.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

describe('INV-2: the single settle exit swallows no group and leaks no rejection', () => {
  let app;
  let mockRegistry, creds, invocationQueue, appendImpl, queueProcessor, legacyCreateImpl, legacyRouteError, useQueue;

  const buildApp = async () => {
    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore: {
        append: (msg) => appendImpl(msg),
        getById: () => null,
      },
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
      router: {
        // biome-ignore lint/correctness/useYield: only an async iterable is required here
        async *routeExecution() {
          if (legacyRouteError) throw legacyRouteError;
        },
      },
      invocationRecordStore: { create: (input) => legacyCreateImpl(input), update() {} },
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete() {},
        completeAll() {},
      },
      ...(useQueue ? { invocationQueue, queueProcessor } : {}),
    });
    await app.ready();
  };

  beforeEach(() => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    invocationQueue = new InvocationQueue();
    appendImpl = (msg) => ({ id: 'm', ...msg });
    legacyCreateImpl = () => ({ outcome: 'created', invocationId: `inv-${Math.random()}` });
    legacyRouteError = undefined;
    useQueue = true;
    const hooks = new Map();
    queueProcessor = {
      registerEntryCompleteHook: (id, hook) => hooks.set(id, hook),
      unregisterEntryCompleteHook: (id) => hooks.delete(id),
      tryAutoExecute: () => Promise.resolve(),
      getHooks: () => hooks,
      simulateComplete: (id, status, text) => {
        const hook = hooks.get(id);
        if (hook) {
          hook(id, status, text);
          hooks.delete(id);
        }
      },
    };
    creds = mockRegistry.register('opus', 'thread-settle', 'user-1');
  });

  afterEach(async () => {
    await app?.close();
  });

  const dispatch = (targets) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets, question: '看一眼', callbackTo: 'opus' },
    });

  const failTheSummaryWrite = () => {
    appendImpl = (msg) => {
      if (typeof msg.content === 'string' && msg.content.includes('Multi-Mention 结果汇总')) {
        return Promise.reject(new Error('flush store unavailable'));
      }
      return { id: 'm', ...msg };
    };
  };

  test('ENTRY: completion hook — a failing summary write does not leak a rejection', async () => {
    await buildApp();
    const rejections = await withRejectionWatch(async () => {
      await dispatch(['codex']);
      failTheSummaryWrite();
      const [entryId] = [...queueProcessor.getHooks().keys()];
      queueProcessor.simulateComplete(entryId, 'succeeded', 'codex reply');
    });
    assert.deepEqual(rejections, [], `settle must own its failure policy, got: ${rejections.join(' | ')}`);
  });

  test('ENTRY: queue all-rejected — a failing summary write does not leak a rejection', async () => {
    await buildApp();
    // Saturate the agent-entry depth budget so nothing can be admitted.
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue({
        threadId: 'thread-settle',
        userId: 'user-1',
        ownerAuthProvenance: 'strict',
        content: `filler-${i}`,
        source: 'agent',
        targetCats: ['opus'],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
      });
    }
    const rejections = await withRejectionWatch(async () => {
      failTheSummaryWrite();
      const res = await dispatch(['codex', 'gemini']);
      assert.equal(res.statusCode, 200);
    });
    assert.deepEqual(rejections, [], `settle must own its failure policy, got: ${rejections.join(' | ')}`);
  });

  test('ENTRY: legacy all-failed admission — a failing summary write does not leak a rejection', async () => {
    useQueue = false;
    legacyCreateImpl = () => {
      throw new Error('record store down');
    };
    await buildApp();
    const rejections = await withRejectionWatch(async () => {
      failTheSummaryWrite();
      const res = await dispatch(['codex', 'gemini']);
      assert.equal(res.statusCode, 200);
    });
    assert.deepEqual(rejections, [], `settle must own its failure policy, got: ${rejections.join(' | ')}`);
  });

  test('ENTRY: legacy dispatch error — the terminal group persists its summary immediately', async () => {
    useQueue = false;
    legacyRouteError = new Error('runtime dispatch failed');
    const summaries = [];
    appendImpl = (msg) => {
      if (typeof msg.content === 'string' && msg.content.includes('Multi-Mention 结果汇总')) {
        summaries.push(msg);
      }
      return { id: 'm', ...msg };
    };
    await buildApp();

    let response;
    const rejections = await withRejectionWatch(async () => {
      response = await dispatch(['codex']);
    });

    assert.equal(response.statusCode, 200);
    assert.equal(summaries.length, 1, 'a terminal dispatch error must flush without waiting for timeout');
    assert.match(summaries[0].content, /dispatch error: runtime dispatch failed/);
    assert.deepEqual(rejections, [], `settle must own its failure policy, got: ${rejections.join(' | ')}`);
  });
});
