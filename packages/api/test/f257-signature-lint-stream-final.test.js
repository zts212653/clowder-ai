/**
 * F257 #4 (sol R1 P1-1) — stream-final signature-lint coverage.
 *
 * The detection layer must stamp `extra.signatureLint` on ORDINARY agent final
 * messages (persisted by route-serial / route-parallel with `origin:'stream'`),
 * not just explicit callback `post_message` posts. Otherwise a cat that never
 * calls post_message is absent from the sign-rate denominator → systematic bias.
 * These integration tests drive the real routeSerial/routeParallel generators
 * and assert the stream-final append carries the signed/unsigned verdict.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SIGNED_FINAL = 'Review done, all green.\n\n[宪宪/claude-opus-4-8🐾]';
const UNSIGNED_FINAL = 'Review done, all green.';

function createMockService(catId, text, innerInvocationId = `cli-${catId}`) {
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
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        appendCalls.push(msg);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
      augmentStreamMetadata: async () => ({}),
    },
    socketManager: { broadcastToRoom: () => {} },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: () => Promise.resolve(),
      deleteByThread: () => {},
      getByThread: () => [],
    },
    voiceMode: false,
  };
}

function streamFinal(appendCalls, catId) {
  return appendCalls.find((m) => m.origin === 'stream' && m.catId === catId);
}

describe('F257 #4 (sol R1 P1-1) — routeSerial stream-final signature lint', () => {
  it('signed final → stream append carries extra.signatureLint.signed=true', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createMockService('opus', SIGNED_FINAL) }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1')) {
      /* drain */
    }
    const finalMsg = streamFinal(appendCalls, 'opus');
    assert.ok(finalMsg, 'serial stream-final persisted');
    assert.deepEqual(finalMsg.extra?.signatureLint, { signed: true });
  });

  it('unsigned final → stream append carries extra.signatureLint.signed=false (enters denominator)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createMockService('opus', UNSIGNED_FINAL) }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hi', 'user1', 'thread1')) {
      /* drain */
    }
    const finalMsg = streamFinal(appendCalls, 'opus');
    assert.ok(finalMsg, 'serial stream-final persisted');
    assert.deepEqual(finalMsg.extra?.signatureLint, { signed: false });
  });
});

describe('F257 #4 (sol R1 P1-1) — routeParallel stream-final signature lint', () => {
  it('signed final → stream append carries extra.signatureLint.signed=true', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createMockService('opus', SIGNED_FINAL) }, appendCalls);
    for await (const _msg of routeParallel(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: 'parent-p1-signed',
    })) {
      /* drain */
    }
    const finalMsg = streamFinal(appendCalls, 'opus');
    assert.ok(finalMsg, 'parallel stream-final persisted');
    assert.deepEqual(finalMsg.extra?.signatureLint, { signed: true });
  });

  it('unsigned final → stream append carries extra.signatureLint.signed=false (enters denominator)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createMockService('opus', UNSIGNED_FINAL) }, appendCalls);
    for await (const _msg of routeParallel(deps, ['opus'], 'hi', 'user1', 'thread1', {
      parentInvocationId: 'parent-p1-unsigned',
    })) {
      /* drain */
    }
    const finalMsg = streamFinal(appendCalls, 'opus');
    assert.ok(finalMsg, 'parallel stream-final persisted');
    assert.deepEqual(finalMsg.extra?.signatureLint, { signed: false });
  });
});
