/**
 * F203 Phase E: route-parallel per-cat tool budget.
 *
 * Siamese (cat-vf01f06u) answering a broad "how is this implemented" question
 * spawned Agent(Explore) and then hundreds of Bash/Read calls without producing
 * text, eventually getting SIGTERM'd. This test verifies that route-parallel
 * aborts a cat once its tool budget is exceeded and yields a system_info
 * explaining the limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, messages) {
  return {
    async *invoke() {
      for (const m of messages) {
        yield { ...m, catId, timestamp: Date.now() };
      }
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
        create: () => ({ invocationId: `inner-inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
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
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

describe('F203 Phase E: route-parallel per-cat tool budget', () => {
  it('aborts a cat that exceeds the tool budget and yields a system_info warning', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const envLimit = '3';
    const previous = process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS;
    process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS = envLimit;
    try {
      const toolMessages = Array.from({ length: 5 }, (_, i) => ({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: `echo ${i}` },
        toolUseId: `tu-${i}`,
      }));
      const services = {
        catvf: createMockService('catvf', toolMessages),
      };
      const deps = createMockDeps(services);

      const messages = [];
      for await (const m of routeParallel(deps, ['catvf'], 'how is this implemented?', 'user1', 'thread1', {})) {
        messages.push(m);
      }

      const budgetWarnings = messages.filter(
        (m) => m.type === 'system_info' && m.content && m.content.includes('tool_call_budget_exceeded'),
      );
      assert.equal(budgetWarnings.length, 1, 'must yield exactly one tool budget warning');

      const parsed = JSON.parse(budgetWarnings[0].content);
      assert.equal(parsed.limit, 3, 'warning reports the env limit');
      assert.ok(parsed.toolCount >= 3, 'warning reports the tool count that triggered it');

      const toolUses = messages.filter((m) => m.type === 'tool_use');
      assert.ok(toolUses.length >= 3, 'at least the budget number of tool_use events were processed');
    } finally {
      if (previous === undefined) {
        delete process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS;
      } else {
        process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS = previous;
      }
    }
  });

  it('does not enforce the budget when the env override is disabled', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const previous = process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS;
    process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS = '100';
    try {
      const toolMessages = Array.from({ length: 5 }, (_, i) => ({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: `echo ${i}` },
        toolUseId: `tu-${i}`,
      }));
      const services = {
        catvf: createMockService('catvf', toolMessages),
      };
      const deps = createMockDeps(services);

      const messages = [];
      for await (const m of routeParallel(deps, ['catvf'], 'short question', 'user1', 'thread1', {})) {
        messages.push(m);
      }

      const budgetWarnings = messages.filter(
        (m) => m.type === 'system_info' && m.content && m.content.includes('tool_call_budget_exceeded'),
      );
      assert.equal(budgetWarnings.length, 0, 'no warning when under budget');
    } finally {
      if (previous === undefined) {
        delete process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS;
      } else {
        process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS = previous;
      }
    }
  });
});
