/**
 * F194 Phase Z9 — 砚砚 R1 P1-1: route-serial must stamp `invocationId = ownInvocationId`
 * on yielded events AFTER invocation_created system_info, so messages.ts live broadcast
 * doesn't fall back to `parent` when stamping `turnInvocationId`.
 *
 * Before fix: text/done/tool events yielded by routeSerial don't carry invocationId
 * (CLI doesn't emit it on those event types), only system_info=invocation_created does.
 * messages.ts:988 then does `turnInvocationId = msg.invocationId ?? createResult.invocationId`
 * → turnInvocationId = parent → bubble identity falls back to parent → 同一 chain 多
 * cat-turn 同 cat 错并 (R13 + R14).
 *
 * After fix: routeSerial stamps `invocationId: ownInvocationId` on every yielded event
 * after invocation_created is seen. Downstream broadcaster trusts msg.invocationId is
 * own turn id, not parent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, innerInvocationId, text) {
  return {
    async *invoke() {
      // 1. invocation_created system_info (carries inner CLI invocationId)
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: innerInvocationId }),
        timestamp: Date.now(),
      };
      // 2. text event (does NOT have invocationId field — CLI events typically don't)
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      // 3. done event (also no invocationId)
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

describe('F194 Phase Z9 — routeSerial stamps ownInvocationId on yielded events (砚砚 R1 P1-1)', () => {
  it('text event yielded after invocation_created has invocationId = ownInvocationId', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'cli-inner-id', 'hello') });

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: 'parent-z9-yield-test',
    })) {
      yielded.push(msg);
    }

    // Find the text event
    const textMsg = yielded.find((m) => m.type === 'text');
    assert.ok(textMsg, 'text message yielded');
    // Z9 contract: text event must carry the per-cat ownInvocationId, not undefined
    // (Otherwise downstream broadcaster fallbacks turnInvocationId to parent.)
    assert.ok(
      textMsg.invocationId,
      'yielded text event MUST carry invocationId (ownInvocationId from invocation_created)',
    );
    // Specifically should be the registry-created own id (per invokeSingleCat invocation),
    // NOT the outer parent.
    assert.notEqual(
      textMsg.invocationId,
      'parent-z9-yield-test',
      'yielded text invocationId must be own (NOT parent — that would defeat per-turn identity)',
    );
  });

  it('done event yielded after invocation_created also has invocationId = ownInvocationId', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'cli-inner-id', 'hello') });

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: 'parent-z9-yield-test',
    })) {
      yielded.push(msg);
    }

    const doneMsg = yielded.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'done event yielded');
    assert.ok(doneMsg.invocationId, 'yielded done event MUST carry invocationId');
    assert.notEqual(doneMsg.invocationId, 'parent-z9-yield-test', 'done invocationId is own, not parent');
  });
});
