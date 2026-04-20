/**
 * F32-b Phase 2: Thread-level preferredCats tests
 *
 * Tests:
 * 1. ThreadStore (memory): updatePreferredCats set/clear/get
 * 2. AgentRouter: preferredCats routing fallback chain
 * 3. threads.ts route validation (catIdSchema on preferredCats)
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

// ── Mock factories ────────────────────────────────────

function createMockRegistry() {
  let counter = 0;
  return {
    create: () => ({
      invocationId: `inv-${++counter}`,
      callbackToken: `tok-${counter}`,
    }),
    verify: () => null,
  };
}

function createMockMessageStore() {
  const rows = [];
  let seq = 0;
  const sorted = () => rows.slice().sort((a, b) => a.id.localeCompare(b.id));
  return {
    append: (msg) => {
      const stored = { ...msg, id: `msg-${String(++seq).padStart(6, '0')}`, threadId: msg.threadId ?? 'default' };
      rows.push(stored);
      return stored;
    },
    getRecent: (limit = 50) => sorted().slice(-limit),
    getMentionsFor: () => [],
    getBefore: () => [],
    getByThread: (threadId, limit = 50) =>
      sorted()
        .filter((m) => m.threadId === threadId)
        .slice(-limit),
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
    _rows: rows,
  };
}

function createMockAgentService(catId, responseText = 'Hello from mock') {
  const invoke = mock.fn(async function* (_prompt, options) {
    const sessionId = options?.sessionId ?? `${catId}-session-new`;
    yield { type: 'session_init', catId, sessionId, timestamp: Date.now() };
    yield { type: 'text', catId, content: responseText, timestamp: Date.now() };
    yield { type: 'done', catId, timestamp: Date.now() };
  });
  return { invoke };
}

/**
 * Mock thread store with preferredCats support.
 * @param {Object} opts - { preferredCats?: Record<string, string[]>, participants?: Record<string, string[]> }
 */
function createMockThreadStoreWithPreferred(opts = {}) {
  const preferredCats = { ...opts.preferredCats };
  const participants = { ...opts.participants };
  const activity = {};
  return {
    create: (userId, title, projectPath) => ({
      id: 'thread_mock',
      projectPath: projectPath ?? 'default',
      title: title ?? null,
      createdBy: userId,
      participants: [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
    get: (threadId) => ({
      id: threadId,
      projectPath: 'default',
      title: null,
      createdBy: 'system',
      participants: participants[threadId] ?? [],
      preferredCats: preferredCats[threadId],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
    list: () => [],
    listByProject: () => [],
    addParticipants: (threadId, catIds) => {
      if (!participants[threadId]) participants[threadId] = [];
      const now = Date.now();
      for (const catId of catIds) {
        if (!participants[threadId].includes(catId)) participants[threadId].push(catId);
        const key = `${threadId}:${catId}`;
        const existing = activity[key] ?? { lastMessageAt: 0, messageCount: 0 };
        activity[key] = { lastMessageAt: now, messageCount: existing.messageCount + 1 };
      }
    },
    getParticipants: (threadId) => participants[threadId] ?? [],
    // F032 P1-2: Return participants with activity
    getParticipantsWithActivity: (threadId) => {
      const cats = participants[threadId] ?? [];
      return cats
        .map((catId) => {
          const key = `${threadId}:${catId}`;
          const data = activity[key] ?? { lastMessageAt: 0, messageCount: 0 };
          return { catId, lastMessageAt: data.lastMessageAt, messageCount: data.messageCount };
        })
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    },
    updateParticipantActivity: (threadId, catId) => {
      if (!participants[threadId]) participants[threadId] = [];
      if (!participants[threadId].includes(catId)) {
        participants[threadId].push(catId);
      }
      const key = `${threadId}:${catId}`;
      const existing = activity[key] ?? { lastMessageAt: 0, messageCount: 0 };
      activity[key] = { lastMessageAt: Date.now(), messageCount: existing.messageCount + 1 };
    },
    consumeMentionRoutingFeedback: () => null,
    updateLastActive: () => {},
    updatePreferredCats: (threadId, catIds) => {
      if (catIds.length > 0) {
        preferredCats[threadId] = catIds;
      } else {
        delete preferredCats[threadId];
      }
    },
    delete: () => true,
    _preferredCats: preferredCats,
    _participants: participants,
  };
}

// ── ThreadStore (memory) tests ────────────────────────

describe('ThreadStore preferredCats (memory)', () => {
  test('updatePreferredCats sets and retrieves preferred cats', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { createCatId } = await import('@cat-cafe/shared');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'test');
    store.updatePreferredCats(thread.id, [createCatId('codex')]);

    const updated = store.get(thread.id);
    assert.deepEqual(updated.preferredCats, [createCatId('codex')]);
  });

  test('updatePreferredCats with empty array clears preference', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { createCatId } = await import('@cat-cafe/shared');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'test');
    store.updatePreferredCats(thread.id, [createCatId('codex')]);
    store.updatePreferredCats(thread.id, []);

    const updated = store.get(thread.id);
    assert.equal(updated.preferredCats, undefined);
  });

  test('updatePreferredCats supports multiple cats', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { createCatId } = await import('@cat-cafe/shared');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'test');
    store.updatePreferredCats(thread.id, [createCatId('codex'), createCatId('gemini')]);

    const updated = store.get(thread.id);
    assert.deepEqual(updated.preferredCats, [createCatId('codex'), createCatId('gemini')]);
  });
});

// ── AgentRouter preferredCats routing tests ───────────

describe('AgentRouter preferredCats routing', () => {
  test('routes to preferredCats when no @mention and thread has preference', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini response');

    const threadStore = createMockThreadStoreWithPreferred({
      preferredCats: { 'thread-1': ['codex'] },
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-1')) {
      messages.push(msg);
    }

    // Should route to codex (preferredCats), not opus (default)
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
  });

  test('@mention overrides preferredCats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini response');

    const threadStore = createMockThreadStoreWithPreferred({
      preferredCats: { 'thread-2': ['codex'] },
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@gemini help me', 'thread-2')) {
      messages.push(msg);
    }

    // @gemini overrides preferredCats=['codex']
    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
  });

  test('falls back to healthy participants before non-participant preferredCats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini response');

    const threadStore = createMockThreadStoreWithPreferred({
      preferredCats: { 'thread-3': ['gemini'] },
      participants: { 'thread-3': ['opus', 'codex'] },
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-3')) {
      messages.push(msg);
    }

    // #1148 + #267: preferredCats only scopes candidates when there is no
    // healthy participant to continue with. A non-participant preferred cat
    // should not displace existing healthy participants.
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
  });

  test('invalid preferredCats (unregistered) are filtered out, falls back to participants', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');

    // 'nonexistent' is not a registered service
    const threadStore = createMockThreadStoreWithPreferred({
      preferredCats: { 'thread-4': ['nonexistent'] },
      participants: { 'thread-4': ['codex'] },
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-4')) {
      messages.push(msg);
    }

    // 'nonexistent' filtered out → falls back to participants=['codex']
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
  });

  // R5 P1-1 regression: prototype chain keys like 'toString' must not pass filter
  test('prototype chain key (toString) in preferredCats is filtered out', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');

    const threadStore = createMockThreadStoreWithPreferred({
      preferredCats: { 'thread-proto': ['toString'] },
      participants: { 'thread-proto': ['codex'] },
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-proto')) {
      messages.push(msg);
    }

    // 'toString' should NOT pass filter → falls back to participants=['codex']
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
    // No cat_error messages
    assert.equal(messages.filter((m) => m.type === 'error').length, 0);
  });

  // R5 P1-2 regression: duplicate catIds must be deduped — cat invoked only once
  test('duplicate catIds in preferredCats invokes cat only once', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');

    const threadStore = createMockThreadStoreWithPreferred({
      preferredCats: { 'thread-dup': ['codex', 'codex'] },
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-dup')) {
      messages.push(msg);
    }

    // codex should be invoked exactly once despite duplicate in preferredCats
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
  });

  // Cloud P1 regression: non-array preferredCats from corrupted Redis data must not crash
  test('non-array preferredCats (corrupted data) falls through gracefully', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');

    // Simulate corrupted Redis data: preferredCats is an object instead of array
    const threadStore = createMockThreadStoreWithPreferred({});
    const originalGet = threadStore.get.bind(threadStore);
    threadStore.get = (threadId) => {
      const thread = originalGet(threadId);
      // Inject non-array value to simulate corrupted Redis hydration
      thread.preferredCats = {};
      return thread;
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-corrupt')) {
      messages.push(msg);
    }

    // Corrupted preferredCats should be treated as empty → default cat (opus)
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(messages.filter((m) => m.type === 'error').length, 0);
  });

  test('empty preferredCats falls through to default cat', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');

    const threadStore = createMockThreadStoreWithPreferred({
      // No preferredCats, no participants for thread-5
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello!', 'thread-5')) {
      messages.push(msg);
    }

    // No preferredCats, no participants → falls back to default (opus)
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
  });
});
