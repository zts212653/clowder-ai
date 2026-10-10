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
 * ADDING A SETTLE TRIGGER MEANS ADDING A ROW HERE.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { resetMultiMentionOrchestrator } from '../dist/routes/callback-multi-mention-routes.js';
import {
  adaptInvocationQueue,
  adaptMessageStore,
  appendTestLifecycleResponseSource,
  canonicalTestQueueInput,
} from './helpers/message-from-fixtures.js';

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
  let mockRegistry, creds, invocationQueue, appendImpl, persistedAppend, queueProcessor, messageStore;

  const buildApp = async () => {
    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete() {},
        completeAll() {},
      },
      invocationQueue,
      queueProcessor,
    });
    await app.ready();
  };

  beforeEach(() => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    invocationQueue = adaptInvocationQueue(new InvocationQueue());
    messageStore = adaptMessageStore(new MessageStore());
    persistedAppend = messageStore.append.bind(messageStore);
    appendImpl = (msg) => persistedAppend(msg);
    messageStore.append = (msg) => appendImpl(msg);
    const hooks = new Map();
    queueProcessor = {
      registerEntryCompleteHook: (id, hook) => hooks.set(id, hook),
      unregisterEntryCompleteHook: (id) => hooks.delete(id),
      requestDrain: () => Promise.resolve(),
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
    appendTestLifecycleResponseSource(messageStore, {
      ...creds,
      threadId: 'thread-settle',
      userId: 'user-1',
    });
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
      return persistedAppend(msg);
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
      invocationQueue.enqueue(
        canonicalTestQueueInput({
          kind: 'private_input',
          threadId: 'thread-settle',
          userId: 'user-1',
          ownerAuthProvenance: 'strict',
          content: `filler-${i}`,
          source: 'agent',
          targetCats: ['opus'],
          intent: 'execute',
          autoExecute: true,
          callerCatId: 'opus',
        }),
      );
    }
    const rejections = await withRejectionWatch(async () => {
      failTheSummaryWrite();
      const res = await dispatch(['codex', 'gemini']);
      assert.equal(res.statusCode, 200);
    });
    assert.deepEqual(rejections, [], `settle must own its failure policy, got: ${rejections.join(' | ')}`);
  });
});
