/**
 * #573: route-serial must persist messages with the OUTER parentInvocationId
 * (cat-cafe's invocation tracker id), not the INNER ownInvocationId (claude/codex
 * CLI's own session UUID from invocation_created event).
 *
 * Background: socket broadcasts (QueueProcessor:761) tag events with parentInvocationId.
 * If the persisted record's extra.stream.invocationId carries the inner CLI id instead,
 * the frontend creates two bubbles for one logical response — one from live broadcast
 * (outer id), one from persisted-msg broadcast (inner id). This is the dup root cause
 * shown by F173 PR #1352 hotfix exposing it as 100% reproducible.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockServiceWithInvocationCreated(catId, text, innerInvocationId) {
  return {
    async *invoke() {
      // CLI emits invocation_created system_info with its own inner invocationId.
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
        const stored = {
          id: `msg-${++messageSeq}`,
          ...msg,
          threadId: msg.threadId ?? 'default',
        };
        appendCalls.push(msg);
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
    },
    socketManager: {
      broadcastToRoom: () => {},
    },
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    voiceMode: false,
  };
}

describe('#573: route-serial parentInvocationId vs ownInvocationId', () => {
  it('persists message with parentInvocationId when both options.parentInvocationId and CLI invocation_created are set', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const innerCliInvocationId = 'cli-inner-uuid-bc758bd1';
    const outerParentInvocationId = 'cat-cafe-outer-a25e3bd9';

    const deps = createMockDeps(
      { opus: createMockServiceWithInvocationCreated('opus', '回答', innerCliInvocationId) },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: outerParentInvocationId,
    })) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'one message persisted');
    const persistedExtra = appendCalls[0].extra;
    assert.ok(persistedExtra?.stream, 'persisted record carries extra.stream');
    assert.equal(
      persistedExtra.stream.invocationId,
      outerParentInvocationId,
      'persisted record uses OUTER parentInvocationId, not INNER CLI id',
    );
    assert.notEqual(
      persistedExtra.stream.invocationId,
      innerCliInvocationId,
      'must NOT use the inner CLI invocationId',
    );
  });

  it('falls back to ownInvocationId when parentInvocationId is not provided', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    // Note: invokeSingleCat overrides our mock invocation_created with its own from
    // registry.create(). So the actual ownInvocationId persisted is the registry-created
    // id, not what our mock service yields. This test verifies the fallback path executes
    // (extra.stream.invocationId is set) when no parentInvocationId is provided.
    const deps = createMockDeps(
      { opus: createMockServiceWithInvocationCreated('opus', '回答', 'unused-mock-id') },
      appendCalls,
    );

    // No parentInvocationId in options
    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'one message persisted');
    const persistedInv = appendCalls[0].extra?.stream?.invocationId;
    assert.ok(persistedInv, 'extra.stream.invocationId is set via fallback to ownInvocationId');
    // Registry mock creates ids like `inv-N` — verify shape (not specific value).
    assert.match(persistedInv, /^inv-\d+$/, 'fallback id matches registry-created shape');
  });
});
