/**
 * F194 Phase Z9 AC-Z25 — backend canonical bubble identity stamp.
 *
 * Current logic (`route-serial.ts:1455`):
 *   ...(ownInvocationId && ownInvocationId !== persistedInvocationId
 *     ? { turnInvocationId: ownInvocationId }
 *     : {}),
 *
 * Bug: when `ownInvocationId === persistedInvocationId` (first-in-chain,
 * no parentInvocationId option), `turnInvocationId` is NOT stamped. Frontend
 * `getBubbleInvocationId` then degrades to parent → multi-turn same-cat
 * (A2A handoff `codex → sonnet → codex`) collapses to one bubble (R13).
 *
 * Z9 fix: stamp `turnInvocationId = ownInvocationId` unconditionally when
 * ownInvocationId is set. Same value as parent is safe; explicit > implicit
 * for bubble identity.
 *
 * 砚砚 R0 push back: NOT per-raw-record mint (would split hydrate);
 * per visible cat turn (all stream/tool/rich/callback records share turn id).
 * ownInvocationId is already per visible cat turn (one per invokeSingleCat
 * invocation_created event) so stamping it unconditionally is the right
 * semantic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockServiceWithInvocationCreated(catId, text, innerInvocationId) {
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

function createMockDeps(services, appendCalls) {
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
        appendCalls.push(msg);
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

describe('F194 Phase Z9 AC-Z25 — route-serial always stamps turnInvocationId', () => {
  it('first-in-chain (no parentInvocationId): turnInvocationId still stamped (= ownInvocationId)', async () => {
    // BUG before Z9: ownInvocationId === persistedInvocationId → conditional skips stamp
    //   → extra.stream = { invocationId } only (no turnInvocationId)
    //   → frontend getBubbleInvocationId falls back to parent
    //   → if a later turn in same chain (different ownInvocationId) appears,
    //     this record's bubble identity collides with later turns of same cat
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      { opus: createMockServiceWithInvocationCreated('opus', '回答', 'unused-mock') },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'one message persisted');
    const extra = appendCalls[0].extra;
    assert.ok(extra?.stream, 'extra.stream present');
    const parent = extra.stream.invocationId;
    assert.ok(parent, 'parent invocationId set');
    // Z9 contract: turnInvocationId MUST be stamped, even when equal to parent
    assert.equal(
      extra.stream.turnInvocationId,
      parent,
      'turnInvocationId stamped explicitly (= parent in first-in-chain, but present)',
    );
  });

  it('chained turn (parentInvocationId set): turnInvocationId = ownInvocationId, different from parent', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const outerParent = 'parent-chain-z9';
    const deps = createMockDeps(
      { opus: createMockServiceWithInvocationCreated('opus', '回答', 'cli-inner') },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: outerParent,
    })) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1);
    const extra = appendCalls[0].extra;
    assert.equal(extra.stream.invocationId, outerParent, 'parent = outer chain');
    assert.ok(extra.stream.turnInvocationId, 'turn stamped');
    assert.notEqual(extra.stream.turnInvocationId, outerParent, 'turn ≠ parent (per-cat-turn distinct)');
  });
});
