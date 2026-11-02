import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const threadId = 'optional-files-thread';
const catId = 'codex';
const userId = 'owner';
const session = { id: 'owned-home', threadId, catId, userId, status: 'active' };

function fixture(branch, getFilesTouched, sessions = [session]) {
  const messages = new MessageStore();
  const input = messages.append({
    threadId,
    userId,
    from: { kind: 'user', userId },
    timestamp: 1000,
    content: 'Start with this authoritative owner message',
    mentions: [],
  });
  const calls = [];
  const deps = {
    services: {},
    messageStore: messages,
    deliveryCursorStore: new DeliveryCursorStore(),
    invocationDeps: {
      threadStore: {
        get: async () => ({ id: threadId, title: 'Startup remains available', createdBy: userId }),
        getThreadMemory: async () => null,
      },
      sessionChainStore: {
        getActive: async (cat, thread, owner) => {
          assert.deepEqual([cat, thread, owner], [catId, threadId, userId]);
          return branch === 'active' ? sessions[0] : null;
        },
        getChainByThread: async (thread) => {
          assert.equal(thread, threadId);
          return sessions;
        },
      },
      transcriptWriter: {
        getFilesTouched: (...args) => {
          calls.push(args);
          return getFilesTouched(...args);
        },
      },
    },
  };
  return {
    calls,
    input,
    assemble: (options = {}) =>
      assembleIncrementalContext(deps, userId, threadId, catId, undefined, undefined, {
        effectiveMaxContextTokens: 500000,
        ...options,
      }),
  };
}

for (const branch of ['active', 'chain']) {
  for (const failure of ['sync', 'async']) {
    test(`${branch} auxiliary file ${failure} failure preserves authoritative context assembly`, async () => {
      const error = new Error('Projection worker timed out');
      const f = fixture(branch, () => {
        if (failure === 'sync') throw error;
        return Promise.reject(error);
      });
      let result;
      await assert.doesNotReject(async () => {
        result = await f.assemble();
      });
      assert.deepEqual(f.calls, [[session.id, { threadId, catId }]]);
      assert.ok(result.contextText.includes(f.input.id));
      assert.ok(result.contextText.includes('Start with this authoritative owner message'));
      assert.ok(result.navigationHeader.includes('真相源: 未定位'), 'unavailable history is not a file-state fact');
    });
  }

  test(`${branch} healthy file read retains the observed file and exact owner session`, async () => {
    const f = fixture(branch, async () => [{ path: 'src/observed-owner-file.ts', ops: ['edit'] }]);
    const result = await f.assemble();
    assert.deepEqual(f.calls, [[session.id, { threadId, catId }]]);
    assert.ok(result.contextText.includes('observed-owner-file.ts'));
    assert.ok(result.navigationHeader.includes('observed-owner-file.ts'));
  });
}

test('foreign and scoped sessions never authorize an auxiliary file read', async () => {
  const sessions = [
    { ...session, id: 'foreign', userId: 'foreign' },
    { ...session, id: 'other-cat', catId: 'codex-sol' },
    { ...session, id: 'scoped', scopedInvocation: { invocationId: 'external-scope' } },
  ];
  const f = fixture('chain', () => assert.fail('unadmitted session must not read transcript files'), sessions);
  const result = await f.assemble();
  assert.deepEqual(f.calls, []);
  assert.ok(result.contextText.includes(f.input.id));
});

test('explicit file observations retain their original precedence without a transcript read', async () => {
  const f = fixture('active', () => assert.fail('explicit observation must not read transcript files'));
  const result = await f.assemble({ recentFilesTouched: [{ path: 'src/explicit-fact.ts', ops: ['edit'] }] });
  assert.deepEqual(f.calls, []);
  assert.ok(result.contextText.includes('explicit-fact.ts'));
});
