/**
 * F194 Phase Z9 — 砚砚 R2 P1: parallel done yield 必须 stamp ownInvocationId。
 *
 * Bug in R1 fix: route-parallel.ts:808 captures `ownInvId` before
 * route-parallel.ts:812 `catInvocationId.delete(msg.catId)`. The done-yield
 * stamp at route-parallel.ts:1246 then re-queries the (now empty) map,
 * getting `undefined` → done event yielded without invocationId →
 * messages.ts broadcaster falls back to parent for turnInvocationId →
 * parallel done's bubble identity / liveness binding incorrectly attaches
 * to parent instead of own turn.
 *
 * Fix: use the `ownInvId` local variable captured at L808 (before delete),
 * not a fresh map.get() at the done-yield site.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, innerInvocationId, text) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: innerInvocationId }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    voiceMode: false,
  };
}

describe('F194 Phase Z9 砚砚 R2 P1 — routeParallel done yield stamps ownInvocationId', () => {
  it('done event yielded by parallel route has invocationId = ownInvocationId (not undefined)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'cli-inner-id-parallel', 'hello') });

    const yielded = [];
    for await (const msg of routeParallel(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: 'parent-z9-parallel-done',
    })) {
      yielded.push(msg);
    }

    const doneMsg = yielded.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'done event yielded');
    // Bug before R2 fix: catInvocationId.delete(msg.catId) at parallel:812 ran
    // BEFORE the done yield stamp at parallel:1246 — stamp lookup returned undefined.
    assert.ok(doneMsg.invocationId, 'parallel done MUST carry invocationId (ownInvocationId captured before delete)');
    assert.notEqual(
      doneMsg.invocationId,
      'parent-z9-parallel-done',
      'parallel done invocationId is own per-cat-turn, NOT parent (otherwise turn collapses to parent)',
    );
  });
});
