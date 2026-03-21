import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function createVoteService(catId, option) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: `[VOTE:${option}]`, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createDeps(services, threadStore) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({ id: `msg-${counter}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0 }),
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('routeParallel vote interception', () => {
  test('captures [VOTE:xxx] and updates active vote state', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    let state = {
      v: 1,
      question: '谁最可爱？',
      options: ['A', 'B', 'C'],
      votes: {},
      anonymous: false,
      deadline: Date.now() + 60_000,
      createdBy: 'owner',
      status: 'active',
    };

    const threadStore = {
      getVotingState: async () => state,
      updateVotingState: async (_threadId, next) => {
        state = next;
      },
      updateParticipantActivity: async () => {},
      getParticipantsWithActivity: async () => [],
      get: async () => null,
    };

    const deps = createDeps(
      {
        opus: createVoteService('opus', 'A'),
        sonnet: createVoteService('sonnet', 'B'),
      },
      threadStore,
    );

    for await (const _msg of routeParallel(deps, ['opus', 'sonnet'], 'vote', 'user1', 'thread1')) {
      // drain
    }

    assert.ok(state, 'vote state should remain active when no designated voters list');
    assert.equal(state.status, 'active');
    assert.equal(state.votes.opus, 'A');
    assert.equal(state.votes.sonnet, 'B');
    assert.equal(Object.keys(state.votes).length, 2);
  });

  test('auto-close persists separate connector message with vote-result source', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    let state = {
      v: 1,
      question: '谁最坏？',
      options: ['opus', 'codex'],
      votes: {},
      anonymous: false,
      deadline: Date.now() + 60_000,
      createdBy: 'owner',
      status: 'active',
      voters: ['opus', 'codex'],
    };

    const threadStore = {
      getVotingState: async () => state,
      updateVotingState: async (_threadId, next) => {
        state = next;
      },
      updateParticipantActivity: async () => {},
      getParticipantsWithActivity: async () => [],
      get: async () => null,
    };

    const appendedMessages = [];
    const deps = createDeps(
      {
        opus: createVoteService('opus', 'codex'),
        codex: createVoteService('codex', 'opus'),
      },
      threadStore,
    );
    // Override messageStore to capture appends
    deps.messageStore.append = async (msg) => {
      const stored = { id: `msg-${appendedMessages.length}`, ...msg };
      appendedMessages.push(stored);
      return stored;
    };

    for await (const _msg of routeParallel(deps, ['opus', 'codex'], 'vote', 'user1', 'thread1')) {
      // drain
    }

    // Should have at least one connector message with vote-result source
    const connectorMsgs = appendedMessages.filter((m) => m.source?.connector === 'vote-result');
    assert.equal(connectorMsgs.length, 1, 'should persist exactly one vote-result connector message');
    assert.equal(connectorMsgs[0].source.label, '投票结果');
    assert.equal(connectorMsgs[0].source.icon, 'ballot');
    assert.equal(connectorMsgs[0].userId, 'user1');
  });

  test('ignores votes from non-designated cats', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    let state = {
      v: 1,
      question: '谁最可爱？',
      options: ['A', 'B'],
      votes: {},
      anonymous: false,
      deadline: Date.now() + 60_000,
      createdBy: 'owner',
      status: 'active',
      voters: ['opus', 'codex'],
    };

    const threadStore = {
      getVotingState: async () => state,
      updateVotingState: async (_threadId, next) => {
        state = next;
      },
      updateParticipantActivity: async () => {},
      getParticipantsWithActivity: async () => [],
      get: async () => null,
    };

    const deps = createDeps(
      {
        opus: createVoteService('opus', 'A'),
        sonnet: createVoteService('sonnet', 'B'),
      },
      threadStore,
    );

    for await (const _msg of routeParallel(deps, ['opus', 'sonnet'], 'vote', 'user1', 'thread1')) {
      // drain
    }

    assert.ok(state, 'vote state should remain active');
    assert.equal(state.votes.opus, 'A');
    assert.equal(state.votes.sonnet, undefined);
    assert.equal(Object.keys(state.votes).length, 1);
  });
});
