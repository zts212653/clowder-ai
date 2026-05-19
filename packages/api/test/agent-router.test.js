/**
 * AgentRouter Tests
 * 测试 @ 提及路由功能
 *
 * Uses mock agent services for testability.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

// Create mock dependencies for AgentRouter
function createMockRegistry() {
  let counter = 0;
  return {
    create: () => ({
      invocationId: `inv-${++counter}`,
      callbackToken: `tok-${counter}`,
    }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  const rows = [];
  let seq = 0;

  // Redis 模型: thread sorted set 的 score = deliveredAt ?? timestamp（markDelivered 后 score 重打）。
  // mock 也用 effective score 排序/过滤，让 R9 cross-page cursor bug 可复现。
  const score = (m) => m.deliveredAt ?? m.timestamp;
  const sortedByScore = () => rows.slice().sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
  const sorted = () => rows.slice().sort((a, b) => a.id.localeCompare(b.id));
  return {
    append: (msg) => {
      const stored = {
        ...msg,
        id: `msg-${String(++seq).padStart(6, '0')}`,
        threadId: msg.threadId ?? 'default',
      };
      rows.push(stored);
      return stored;
    },
    getById: (id) => rows.find((m) => m.id === id) ?? null,
    getRecent: (limit = 50) => sorted().slice(-limit),
    getMentionsFor: (catId, limit = 50) =>
      sorted()
        .filter((m) => m.mentions?.includes(catId))
        .slice(-limit),
    getBefore: (timestamp, limit = 50) =>
      sorted()
        .filter((m) => m.timestamp < timestamp)
        .slice(-limit),
    getByThread: (threadId, limit = 50) =>
      sortedByScore()
        .filter((m) => m.threadId === threadId)
        .slice(-limit),
    getByThreadAfter: (threadId, afterId, limit) => {
      const inThread = sorted().filter((m) => m.threadId === threadId);
      const filtered = afterId ? inThread.filter((m) => m.id > afterId) : inThread;
      return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
    },
    getByThreadBefore: (threadId, timestamp, limit = 50, beforeId) =>
      sortedByScore()
        .filter((m) => m.threadId === threadId)
        .filter((m) => score(m) < timestamp || (score(m) === timestamp && (!beforeId || m.id < beforeId)))
        .slice(-limit),
    deleteByThread: (threadId) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].threadId === threadId) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    _rows: rows,
  };
}

function createMockThreadStore(
  initialParticipants = {},
  threadProjectPaths = {},
  threadRoutingPolicies = {},
  threadPreferredCats = {},
) {
  const participants = { ...initialParticipants };
  // F032 P1-2: Track activity timestamps for each participant
  const activity = {};
  // Monotonic counter to ensure stable ordering even when Date.now() has same-ms resolution
  let activitySeq = 0;
  return {
    create: (userId, title, projectPath) => ({
      id: `thread_mock`,
      projectPath: projectPath ?? 'default',
      title: title ?? null,
      createdBy: userId,
      participants: [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
    get: (threadId) => ({
      id: threadId,
      projectPath: threadProjectPaths[threadId] ?? 'default',
      title: null,
      createdBy: 'system',
      participants: participants[threadId] ?? [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
      routingPolicy: threadRoutingPolicies[threadId],
      preferredCats: threadPreferredCats[threadId],
    }),
    list: () => [],
    listByProject: () => [],
    addParticipants: (threadId, catIds) => {
      if (!participants[threadId]) participants[threadId] = [];
      const now = Date.now();
      for (const catId of catIds) {
        if (!participants[threadId].includes(catId)) {
          participants[threadId].push(catId);
        }
        // Track activity
        const key = `${threadId}:${catId}`;
        const existing = activity[key] ?? { lastMessageAt: 0, messageCount: 0 };
        activity[key] = { lastMessageAt: now, messageCount: existing.messageCount + 1 };
      }
    },
    getParticipants: (threadId) => participants[threadId] ?? [],
    // F032 P1-2: Return participants with activity, sorted by lastMessageAt desc
    getParticipantsWithActivity: (threadId) => {
      const cats = participants[threadId] ?? [];
      return cats
        .map((catId) => {
          const key = `${threadId}:${catId}`;
          const data = activity[key] ?? { lastMessageAt: 0, messageCount: 0 };
          return {
            catId,
            lastMessageAt: data.lastMessageAt,
            messageCount: data.messageCount,
            lastResponseHealthy: data.lastResponseHealthy,
          };
        })
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    },
    consumeMentionRoutingFeedback: () => null,
    // F032 P1-2: Update participant activity on message
    // #267: healthy param tracks whether last response succeeded
    updateParticipantActivity: (threadId, catId, healthy) => {
      if (!participants[threadId]) participants[threadId] = [];
      if (!participants[threadId].includes(catId)) {
        participants[threadId].push(catId);
      }
      const key = `${threadId}:${catId}`;
      const existing = activity[key] ?? { lastMessageAt: 0, messageCount: 0 };
      activity[key] = {
        lastMessageAt: Date.now() + ++activitySeq,
        messageCount: existing.messageCount + 1,
        lastResponseHealthy: healthy,
      };
    },
    updateLastActive: () => {},
    delete: () => true,
    _participants: participants, // exposed for test assertions
  };
}

function createDebugThinkingThreadStore() {
  return {
    create: (userId, title, projectPath) => ({
      id: 'thread_mock',
      projectPath: projectPath ?? 'default',
      title: title ?? null,
      createdBy: userId,
      participants: [],
      thinkingMode: 'debug',
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
    get: (threadId) => ({
      id: threadId,
      projectPath: 'default',
      title: null,
      createdBy: 'system',
      participants: [],
      thinkingMode: 'debug',
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
    list: () => [],
    listByProject: () => [],
    addParticipants: () => {},
    getParticipants: () => [],
    getParticipantsWithActivity: () => [],
    consumeMentionRoutingFeedback: () => null,
    updateParticipantActivity: () => {},
    updateLastActive: () => {},
    delete: () => true,
  };
}

// Create mock agent services
function createMockAgentService(catId, responseText = 'Hello from mock') {
  const invoke = mock.fn(async function* (_prompt, options) {
    const sessionId = options?.sessionId ?? `${catId}-session-new`;
    yield {
      type: 'session_init',
      catId,
      sessionId,
      timestamp: Date.now(),
    };
    yield {
      type: 'text',
      catId,
      content: responseText,
      timestamp: Date.now(),
    };
    yield {
      type: 'done',
      catId,
      timestamp: Date.now(),
    };
  });

  return { invoke };
}

const tempProjectRoots = [];

function createAvailabilityConfigProject(availabilityOverrides = {}) {
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'agent-router-availability-'));
  tempProjectRoots.push(projectRoot);
  const makeBreed = (id, family, displayName, provider, defaultModel) => ({
    id: family,
    catId: id,
    name: displayName,
    displayName,
    avatar: `/avatars/${id}.png`,
    color: { primary: '#334155', secondary: '#cbd5e1' },
    mentionPatterns: [`@${id}`],
    roleDescription: `${displayName} role`,
    defaultVariantId: `${id}-default`,
    variants: [
      {
        id: `${id}-default`,
        clientId: provider,
        defaultModel,
        mcpSupport: true,
        cli: {
          command: provider === 'anthropic' ? 'claude' : provider === 'google' ? 'gemini' : 'codex',
          outputFormat: 'json',
        },
      },
    ],
  });
  const templatePath = resolve(projectRoot, 'cat-template.json');
  writeFileSync(
    templatePath,
    JSON.stringify(
      {
        version: 2,
        breeds: [
          makeBreed('opus', 'ragdoll', '布偶猫', 'anthropic', 'claude-opus-4-6'),
          makeBreed('codex', 'maine-coon', '缅因猫', 'openai', 'gpt-5.4'),
          makeBreed('gemini', 'siamese', '暹罗猫', 'google', 'gemini-3.1-pro'),
        ],
        roster: {
          opus: {
            family: 'ragdoll',
            roles: ['assistant'],
            lead: true,
            available: availabilityOverrides.opus ?? true,
            evaluation: 'opus',
          },
          codex: {
            family: 'maine-coon',
            roles: ['assistant'],
            lead: false,
            available: availabilityOverrides.codex ?? true,
            evaluation: 'codex',
          },
          gemini: {
            family: 'siamese',
            roles: ['assistant'],
            lead: false,
            available: availabilityOverrides.gemini ?? true,
            evaluation: 'gemini',
          },
        },
        reviewPolicy: {
          requireDifferentFamily: true,
          preferActiveInThread: true,
          preferLead: true,
          excludeUnavailable: true,
        },
        coCreator: {
          name: 'Co-worker',
          aliases: ['共创伙伴'],
          mentionPatterns: ['@co-worker', '@owner'],
        },
      },
      null,
      2,
    ),
  );
  return templatePath;
}

async function withAvailabilityConfig(availabilityOverrides, fn) {
  const templatePath = createAvailabilityConfigProject(availabilityOverrides);
  const { _resetCachedConfig } = await import('../dist/config/cat-config-loader.js');
  const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
  process.env.CAT_TEMPLATE_PATH = templatePath;
  _resetCachedConfig();
  try {
    return await fn();
  } finally {
    if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
    _resetCachedConfig();
  }
}

after(() => {
  for (const projectRoot of tempProjectRoots) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('AgentRouter', () => {
  test('routingPolicy(review) avoids opus when default routing would pick opus', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini response');

    const threadStore = createMockThreadStore(
      {},
      {},
      {
        'thread-policy': { v: 1, scopes: { review: { avoidCats: ['opus'], reason: 'budget' } } },
      },
    );

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

    const { targetCats } = await router.resolveTargetsAndIntent('帮我 review 一下', 'thread-policy');
    assert.equal(targetCats[0], 'codex', 'Should pick deterministic non-opus fallback (codex) when opus is avoided');
  });

  test('routingPolicy(review) does not trigger on words containing "pr" like "prompt"', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      {},
      {},
      {
        'thread-policy': { v: 1, scopes: { review: { avoidCats: ['opus'], reason: 'budget' } } },
      },
    );

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus', 'Opus response'),
        codexService: createMockAgentService('codex', 'Codex response'),
        geminiService: createMockAgentService('gemini', 'Gemini response'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('prompt engineering 这块怎么做', 'thread-policy');
    assert.equal(targetCats[0], 'opus', 'Should not classify "prompt" as PR/review scope');
  });

  test('routingPolicy tolerates malformed avoid/prefer lists without crashing', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      {},
      {},
      {
        'thread-malformed': {
          v: 1,
          scopes: {
            review: {
              avoidCats: { bad: true },
              preferCats: 'opus',
            },
          },
        },
      },
    );

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus', 'Opus response'),
        codexService: createMockAgentService('codex', 'Codex response'),
        geminiService: createMockAgentService('gemini', 'Gemini response'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('请 review 这次改动', 'thread-malformed');
    assert.equal(targetCats[0], 'opus');
  });

  test('routingPolicy(architecture) prefers opus even when participants would route elsewhere', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      { 'thread-arch': ['codex'] },
      {},
      {
        'thread-arch': { v: 1, scopes: { architecture: { preferCats: ['opus'] } } },
      },
    );

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus', 'Opus response'),
        codexService: createMockAgentService('codex', 'Codex response'),
        geminiService: createMockAgentService('gemini', 'Gemini response'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('这个架构 tradeoff 怎么选', 'thread-arch');
    assert.equal(targetCats[0], 'opus', 'Should prefer opus first for architecture scope');
    assert.ok(targetCats.includes('codex'), 'Should keep existing participant after preferred cat');
  });

  test('routingPolicy does not override explicit @mention', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      {},
      {},
      {
        'thread-mention': { v: 1, scopes: { review: { avoidCats: ['opus'] } } },
      },
    );

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus', 'Opus response'),
        codexService: createMockAgentService('codex', 'Codex response'),
        geminiService: createMockAgentService('gemini', 'Gemini response'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@opus 帮我 review', 'thread-mention');
    assert.deepEqual(targetCats, ['opus']);
  });

  test('routes to opus (default) when no @ mention is present', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = createMockAgentService('codex', 'Codex response');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini response');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', 'Hello, how are you?')) {
      messages.push(msg);
    }

    // Should route to opus
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);

    // Should have session_init, text, and done from opus
    assert.ok(messages.length >= 3);
    assert.ok(messages.every((m) => m.catId === 'opus'));
  });

  test('routes to opus when @opus is mentioned', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus help me')) {
      messages.push(msg);
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
  });

  test('routes to opus when Chinese mention @布偶猫 is used', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@布偶猫 请帮我')) {
      messages.push(msg);
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
  });

  test('routes to codex when @codex is mentioned', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@codex review this')) {
      messages.push(msg);
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
    assert.ok(messages.every((m) => m.catId === 'codex'));
  });

  test('routes to codex when Chinese mention @缅因猫 is used', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@缅因猫 检查代码')) {
      messages.push(msg);
    }

    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.ok(messages.every((m) => m.catId === 'codex'));
  });

  test('routes to gemini when @gemini is mentioned', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@gemini design this')) {
      messages.push(msg);
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 0);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);
    assert.ok(messages.every((m) => m.catId === 'gemini'));
  });

  test('routes to gemini when Chinese mention @暹罗猫 is used', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@暹罗猫 设计表情')) {
      messages.push(msg);
    }

    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);
    assert.ok(messages.every((m) => m.catId === 'gemini'));
  });

  test('executes multiple cats in order when multiple @ mentions are present (#execute)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus says');
    const mockCodexService = createMockAgentService('codex', 'Codex says');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini says');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '#execute @opus write code, then @codex review it')) {
      messages.push(msg);
    }

    // Both should be called
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);

    // Messages should be in order: opus first, then codex
    const textMessages = messages.filter((m) => m.type === 'text');
    assert.equal(textMessages.length, 2);
    assert.equal(textMessages[0].catId, 'opus');
    assert.equal(textMessages[1].catId, 'codex');
  });

  test('multi-cat serial chain hides previous stream responses in play mode (#execute)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexReceivedPrompt = '';
    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexReceivedPrompt = prompt;
        yield { type: 'session_init', catId: 'codex', sessionId: 'codex-123', timestamp: Date.now() };
        yield { type: 'text', catId: 'codex', content: 'Codex reviewed', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '#execute @opus write code, then @codex review it')) {
      messages.push(msg);
    }

    // In play mode, stream thinking is isolated between cats.
    assert.ok(
      !codexReceivedPrompt.includes('Opus response'),
      'Codex prompt should NOT include Opus stream response in play mode',
    );
  });

  test('multi-cat serial chain includes previous stream responses in debug mode (#execute)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexReceivedPrompt = '';
    const mockClaudeService = createMockAgentService('opus', 'Opus response');
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexReceivedPrompt = prompt;
        yield { type: 'session_init', catId: 'codex', sessionId: 'codex-123', timestamp: Date.now() };
        yield { type: 'text', catId: 'codex', content: 'Codex reviewed', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore: createDebugThinkingThreadStore(),
      }),
    );

    for await (const _ of router.route('user-1', '#execute @opus write code, then @codex review it')) {
      // consume
    }

    assert.ok(
      codexReceivedPrompt.includes('Opus response'),
      'Codex prompt should include Opus stream response in debug mode',
    );
  });

  test('stores and uses session IDs per user per cat', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let capturedOptions = null;
    const mockClaudeService = {
      invoke: mock.fn(async function* (_prompt, options) {
        capturedOptions = options;
        yield { type: 'session_init', catId: 'opus', sessionId: 'opus-session-1', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'Hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    // First call - no session yet
    for await (const _ of router.route('user-1', 'Hello')) {
      // consume messages
    }
    assert.equal(capturedOptions?.sessionId, undefined);

    // Second call - should use stored session
    for await (const _ of router.route('user-1', 'Hello again')) {
      // consume messages
    }
    assert.equal(capturedOptions?.sessionId, 'opus-session-1');
  });

  test('maintains separate sessions for different users', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const capturedSessions = [];
    const mockClaudeService = {
      invoke: mock.fn(async function* (_prompt, options) {
        capturedSessions.push(options?.sessionId);
        const sessionId = options?.sessionId ?? `opus-session-${capturedSessions.length}`;
        yield { type: 'session_init', catId: 'opus', sessionId, timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'Hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    // User 1 first call
    for await (const _ of router.route('user-1', 'Hello')) {
    }
    // User 2 first call
    for await (const _ of router.route('user-2', 'Hello')) {
    }
    // User 1 second call
    for await (const _ of router.route('user-1', 'Hello')) {
    }
    // User 2 second call
    for await (const _ of router.route('user-2', 'Hello')) {
    }

    // First calls for both users should have no session
    assert.equal(capturedSessions[0], undefined);
    assert.equal(capturedSessions[1], undefined);
    // Second calls should have their respective sessions
    assert.equal(capturedSessions[2], 'opus-session-1');
    assert.equal(capturedSessions[3], 'opus-session-2');
  });

  test('handles all English mention patterns correctly', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const testCases = [
      { mention: '@ragdoll', expectedCat: 'opus' },
      { mention: '@maine', expectedCat: 'codex' },
      { mention: '@siamese', expectedCat: 'gemini' },
    ];

    for (const { mention, expectedCat } of testCases) {
      const mockClaudeService = createMockAgentService('opus');
      const mockCodexService = createMockAgentService('codex');
      const mockGeminiService = createMockAgentService('gemini');

      const router = new AgentRouter(
        await migrateRouterOpts({
          claudeService: mockClaudeService,
          codexService: mockCodexService,
          geminiService: mockGeminiService,
          registry: createMockRegistry(),
          messageStore: createMockMessageStore(),
        }),
      );

      for await (const _ of router.route('user-1', `${mention} do something`)) {
        // consume
      }

      const services = {
        opus: mockClaudeService,
        codex: mockCodexService,
        gemini: mockGeminiService,
      };

      assert.equal(services[expectedCat].invoke.mock.callCount(), 1, `${mention} should route to ${expectedCat}`);
    }
  });

  test('handles all Chinese mention patterns correctly', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const testCases = [
      { mention: '@布偶', expectedCat: 'opus' },
      { mention: '@缅因', expectedCat: 'codex' },
      { mention: '@暹罗', expectedCat: 'gemini' },
    ];

    for (const { mention, expectedCat } of testCases) {
      const mockClaudeService = createMockAgentService('opus');
      const mockCodexService = createMockAgentService('codex');
      const mockGeminiService = createMockAgentService('gemini');

      const router = new AgentRouter(
        await migrateRouterOpts({
          claudeService: mockClaudeService,
          codexService: mockCodexService,
          geminiService: mockGeminiService,
          registry: createMockRegistry(),
          messageStore: createMockMessageStore(),
        }),
      );

      for await (const _ of router.route('user-1', `${mention} 做某事`)) {
        // consume
      }

      const services = {
        opus: mockClaudeService,
        codex: mockCodexService,
        gemini: mockGeminiService,
      };

      assert.equal(services[expectedCat].invoke.mock.callCount(), 1, `${mention} should route to ${expectedCat}`);
    }
  });

  test('invokes all three cats for triple mention (parallel, no order guarantee)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus', 'Opus');
    const mockCodexService = createMockAgentService('codex', 'Codex');
    const mockGeminiService = createMockAgentService('gemini', 'Gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus design, @codex review, @gemini visualize')) {
      messages.push(msg);
    }

    // All three should be called
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);

    // All three texts present (parallel — order not guaranteed)
    const textMessages = messages.filter((m) => m.type === 'text');
    assert.equal(textMessages.length, 3);
    const catIds = textMessages.map((m) => m.catId).sort();
    assert.deepEqual(catIds, ['codex', 'gemini', 'opus']);
  });

  test('does not duplicate same cat when mentioned multiple times', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus do this, and @opus also do that')) {
      messages.push(msg);
    }

    // Should only call once, not twice
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
  });

  test('case insensitive mention matching', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '@OPUS help me')) {
      // consume
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
  });

  test('continues chain when first cat throws an error', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // Opus throws, Codex should still execute
    const mockClaudeService = {
      invoke: mock.fn(async function* () {
        throw new Error('Claude CLI crashed');
      }),
    };
    const mockCodexService = createMockAgentService('codex', 'Codex response');
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus write, @codex review')) {
      messages.push(msg);
    }

    // Opus error should be yielded
    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].catId, 'opus');
    assert.ok(errors[0].error.includes('Claude CLI crashed'));

    // Codex should still have been called
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(codexText.length, 1);

    // Both done messages should exist. In parallel mode, whichever finishes last isFinal=true.
    const dones = messages.filter((m) => m.type === 'done');
    assert.equal(dones.length, 2);
    const finalDones = dones.filter((m) => m.isFinal);
    assert.equal(finalDones.length, 1, 'Exactly one done should be isFinal');
    assert.ok(dones[dones.length - 1].isFinal, 'Last done should be isFinal');
  });

  test('session store failure degrades gracefully without crashing route', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let capturedOptions = null;
    const mockClaudeService = {
      invoke: mock.fn(async function* (_prompt, options) {
        capturedOptions = options;
        yield { type: 'session_init', catId: 'opus', sessionId: 'new-sess', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'Hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // SessionStore that throws on every operation (simulates Redis down)
    const brokenSessionStore = {
      getSessionId: mock.fn(async () => {
        throw new Error('Redis ETIMEDOUT');
      }),
      setSessionId: mock.fn(async () => {
        throw new Error('Redis ETIMEDOUT');
      }),
      deleteSession: mock.fn(async () => {
        throw new Error('Redis ETIMEDOUT');
      }),
      getDeliveryCursor: mock.fn(async () => {
        throw new Error('Redis ETIMEDOUT');
      }),
      setDeliveryCursor: mock.fn(async () => {
        throw new Error('Redis ETIMEDOUT');
      }),
      deleteDeliveryCursor: mock.fn(async () => {
        throw new Error('Redis ETIMEDOUT');
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        sessionStore: brokenSessionStore,
      }),
    );

    // Should NOT throw — should degrade to no-session
    const messages = [];
    for await (const msg of router.route('user-1', 'Hello')) {
      messages.push(msg);
    }

    // Service was called without session (degraded)
    assert.equal(capturedOptions?.sessionId, undefined);
    // Text message still came through
    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'Hello');
  });

  // --- Participant tracking tests (Phase 3.2 Task 3) ---

  test('@ mentions update thread participants via threadStore', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore();
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    for await (const _ of router.route('user-1', '@opus @codex help', 'thread_1')) {
    }

    // Participants should have been added
    assert.deepEqual(threadStore._participants.thread_1, ['opus', 'codex']);
  });

  test('no @ mention routes to last replier only (F078)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // Thread already has opus + codex as participants; codex more recent
    const threadStore = createMockThreadStore({ thread_1: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('thread_1', 'opus');
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure different timestamps
    threadStore.updateParticipantActivity('thread_1', 'codex'); // most recent
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
    // No @ mention — F078: routes to last replier only (codex)
    for await (const msg of router.route('user-1', 'what do you think?', 'thread_1')) {
      messages.push(msg);
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 0, 'opus not called — not last replier');
    assert.equal(mockCodexService.invoke.mock.callCount(), 1, 'codex called — last replier');
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
  });

  test('F078: no @ mention returns only last replier (most recent by activity)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // Create thread store with opus and codex as participants
    const threadStore = createMockThreadStore({ thread_activity: ['opus', 'codex'] });

    // Manually set activity timestamps: codex more recent than opus
    threadStore.updateParticipantActivity('thread_activity', 'opus');
    await new Promise((resolve) => setTimeout(resolve, 5));
    threadStore.updateParticipantActivity('thread_activity', 'codex');

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

    // F078: returns only the most recent replier, not all participants
    const result = await router.resolveTargetsAndIntent('what do you think?', 'thread_activity');

    assert.equal(result.targetCats[0], 'codex', 'Most recently active cat (codex) should be the target');
    assert.equal(result.targetCats.length, 1, 'F078: only last replier, not all participants');
  });

  test('#267: never-responded cat excluded from healthy replier fallback', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // codex is a participant but has never responded (messageCount=0)
    // opus has responded and is healthy
    const threadStore = createMockThreadStore({ t_never: ['codex', 'opus'] });
    threadStore.updateParticipantActivity('t_never', 'opus'); // opus responded

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

    const result = await router.resolveTargetsAndIntent('hello?', 't_never');
    assert.equal(result.targetCats[0], 'opus', 'opus selected — codex never responded');
    assert.equal(result.targetCats.length, 1);
  });

  test('#267: unhealthy last replier skipped, falls back to next healthy', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // codex responded last but errored; opus responded earlier and is healthy
    const threadStore = createMockThreadStore({ t_err: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('t_err', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_err', 'codex', false); // unhealthy

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

    const result = await router.resolveTargetsAndIntent('what happened?', 't_err');
    assert.equal(result.targetCats[0], 'opus', 'opus selected — codex was unhealthy');
    assert.equal(result.targetCats.length, 1);
  });

  test('no @ mention + no participants defaults to opus', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // Thread exists but has no participants
    const threadStore = createMockThreadStore({});
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

    for await (const _ of router.route('user-1', 'hello', 'thread_new')) {
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 0);
  });

  test('@three cats then no-@ routes to one cat from last user-message mentions (F078 superseded by F194 Z6 AC-Z16)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    const threadStore = createMockThreadStore();
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

    // First: @ all three cats
    for await (const _ of router.route('user-1', '@opus @codex @gemini meeting', 'thread_x')) {
    }

    // Verify all three called
    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);

    // Second: no @
    // F078 (旧语义): 路由到 last replier 的单只猫
    // F194 Phase Z6 AC-Z16 (修正语义): 候选集来自上一条 user message 的 mentions，
    // 但 no-@ fallback 只召唤一只确定的猫（first routable mention），不会把上一轮
    // parallel ideate 的全量 targetCats 自动延续成新一轮并发。
    for await (const _ of router.route('user-1', 'what about this?', 'thread_x')) {
    }

    // After Z6: only the first routable previous mention is called again.
    assert.equal(mockClaudeService.invoke.mock.callCount(), 2);
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);
    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);
  });

  test('route with explicit threadId passes it to messageStore.append', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const appendedMessages = [];
    const msgStore = {
      ...createMockMessageStore(),
      append: (msg) => {
        appendedMessages.push(msg);
        return { ...msg, id: 'msg-1' };
      },
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: msgStore,
      }),
    );

    for await (const _ of router.route('user-1', 'hi', 'my-thread')) {
    }

    // User message should have threadId
    assert.equal(appendedMessages[0].threadId, 'my-thread');
    // Cat response message should also have threadId
    if (appendedMessages.length > 1) {
      assert.equal(appendedMessages[1].threadId, 'my-thread');
    }
  });

  test('no threadStore degrades to default opus routing', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // No threadStore — old behavior
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', 'hello')) {
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 0);
  });

  test('new @ mention adds to participants; no-@ routes to last replier (F078)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaudeService = createMockAgentService('opus');
    const mockCodexService = createMockAgentService('codex');
    const mockGeminiService = createMockAgentService('gemini');

    // Thread already has opus
    const threadStore = createMockThreadStore({ thread_y: ['opus'] });
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

    // @gemini — should add gemini to participants and route only to gemini
    for await (const _ of router.route('user-1', '@gemini design this', 'thread_y')) {
    }
    assert.equal(mockGeminiService.invoke.mock.callCount(), 1);
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0); // not called — only @gemini

    // Now no @ — F078: routes to last replier only (gemini, most recent participant)
    for await (const _ of router.route('user-1', 'looks good?', 'thread_y')) {
    }
    assert.equal(mockClaudeService.invoke.mock.callCount(), 0, 'opus not called — not last replier');
    assert.equal(mockGeminiService.invoke.mock.callCount(), 2, 'gemini called again — last replier');
    assert.deepEqual(threadStore._participants.thread_y, ['opus', 'gemini']);
  });

  test('error from first cat is not passed as context to second cat', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexReceivedPrompt = '';
    const mockClaudeService = {
      invoke: mock.fn(async function* () {
        throw new Error('boom');
      }),
    };
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexReceivedPrompt = prompt;
        yield { type: 'session_init', catId: 'codex', sessionId: 'c-1', timestamp: Date.now() };
        yield { type: 'text', catId: 'codex', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };
    const mockGeminiService = createMockAgentService('gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: mockGeminiService,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '@opus then @codex')) {
      // consume
    }

    // Codex gets original message (with identity prefix) but no opus response since it crashed
    assert.ok(codexReceivedPrompt.includes('@opus then @codex'));
  });

  test('passes workingDirectory when thread has non-default projectPath', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
    const projectPath = resolve(process.cwd(), '..', '..');
    const previousAllowedRoots = process.env.PROJECT_ALLOWED_ROOTS;
    const previousAllowedRootsAppend = process.env.PROJECT_ALLOWED_ROOTS_APPEND;

    let receivedOptions = null;
    const mockClaudeService = {
      invoke: mock.fn(async function* (_prompt, options) {
        receivedOptions = options;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const threadStore = createMockThreadStore(
      {},
      {
        'thread-proj': projectPath,
      },
    );

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    process.env.PROJECT_ALLOWED_ROOTS = projectPath;
    process.env.PROJECT_ALLOWED_ROOTS_APPEND = 'true';
    try {
      for await (const _ of router.route('user-1', '@opus hello', 'thread-proj')) {
        // consume
      }

      assert.ok(receivedOptions);
      assert.equal(receivedOptions.workingDirectory, projectPath);
    } finally {
      if (previousAllowedRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
      else process.env.PROJECT_ALLOWED_ROOTS = previousAllowedRoots;

      if (previousAllowedRootsAppend === undefined) delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
      else process.env.PROJECT_ALLOWED_ROOTS_APPEND = previousAllowedRootsAppend;
    }
  });

  test('does NOT pass workingDirectory when thread has default projectPath', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let receivedOptions = null;
    const mockClaudeService = {
      invoke: mock.fn(async function* (_prompt, options) {
        receivedOptions = options;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const threadStore = createMockThreadStore(
      {},
      {
        'thread-default': 'default',
      },
    );

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    for await (const _ of router.route('user-1', '@opus hello', 'thread-default')) {
      // consume
    }

    assert.ok(receivedOptions);
    assert.equal(receivedOptions.workingDirectory, undefined);
  });

  test('passes auditContext with invocation correlation fields', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let receivedOptions = null;
    const mockClaudeService = {
      invoke: mock.fn(async function* (_prompt, options) {
        receivedOptions = options;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '@opus hello', 'thread-audit')) {
      // consume
    }

    assert.ok(receivedOptions);
    assert.deepEqual(receivedOptions.auditContext, {
      invocationId: 'inv-1',
      threadId: 'thread-audit',
      userId: 'user-1',
      catId: 'opus',
    });
  });

  test('F203 Phase C: provider WITHOUT native L0 still gets full static identity in user-message prompt', async () => {
    // 云端 Codex P1-cloud-1: only ClaudeBgCarrier + CodexAgent inject L0
    // natively (--system-prompt-file / -c developer_instructions). All other
    // providers (ClaudeAgentService legacy -p, GeminiAgentService, Antigravity,
    // CatAgentService, A2A, OpenCode, Dare, Kimi…) still rely on the
    // user-message `params.systemPrompt` prepend for identity/家规. The route
    // layer must consult `service.injectsL0Natively?.()` and keep FULL static
    // identity for non-native services — pack-only-everywhere would orphan
    // 9 of 11 providers.
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusReceivedPrompt = '';
    const mockClaudeService = {
      // Intentionally NO injectsL0Natively — represents legacy ClaudeAgentService.
      invoke: mock.fn(async function* (prompt) {
        opusReceivedPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '@opus hello')) {
      // consume
    }

    // Provider has no native L0 path → static identity MUST ride user message.
    assert.ok(
      opusReceivedPrompt.includes('由 Anthropic 提供'),
      'static provider/identity line MUST be in user-message prompt for non-native-L0 provider',
    );
    assert.ok(
      opusReceivedPrompt.includes('## 协作'),
      'static A2A collaboration section MUST be present for non-native-L0 provider',
    );
    assert.ok(opusReceivedPrompt.includes('Identity: 布偶猫'), 'dynamic invocation identity pin');
    assert.ok(opusReceivedPrompt.includes('hello'), 'original message');
  });

  test('F203 Phase C: provider WITH injectsL0Natively=true gets pack-only (non-pack via native channel)', async () => {
    // The intended behavior for ClaudeBgCarrier + CodexAgent: static identity
    // travels via --system-prompt-file / -c developer_instructions, not via
    // user message. Route layer detects via service.injectsL0Natively?.().
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusReceivedPrompt = '';
    const mockNativeL0Service = {
      injectsL0Natively: () => true,
      invoke: mock.fn(async function* (prompt) {
        opusReceivedPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockNativeL0Service,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '@opus hello')) {
      // consume
    }

    // Provider injects L0 natively → user message must NOT carry static identity.
    assert.ok(
      !opusReceivedPrompt.includes('由 Anthropic 提供'),
      'static provider/identity line must NOT duplicate in user message when provider injects natively',
    );
    assert.ok(
      !opusReceivedPrompt.includes('## 协作'),
      'static A2A section must NOT duplicate when provider injects natively',
    );
    // Dynamic pin + message still flow.
    assert.ok(opusReceivedPrompt.includes('Identity: 布偶猫'));
    assert.ok(opusReceivedPrompt.includes('hello'));
  });

  test('identity injection: codex prompt in serial chain contains 缅因猫 (#execute)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexReceivedPrompt = '';
    let _codexReceivedOptions;
    const mockClaudeService = createMockAgentService('opus', 'opus says hi');
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt, options) {
        codexReceivedPrompt = prompt;
        _codexReceivedOptions = options;
        yield { type: 'text', catId: 'codex', content: 'codex says hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '#execute @opus @codex hello')) {
      // consume
    }

    // Static identity (缅因猫) prepended to prompt by invoke-single-cat (new session)
    assert.ok(codexReceivedPrompt.includes('缅因猫'), 'Codex prompt should contain 缅因猫');
    // Dynamic chain position still in -p prompt
    assert.ok(codexReceivedPrompt.includes('2/2'), 'Codex prompt should show chain position 2/2');
  });

  // --- Parallel routing tests ---

  test('parallel: 2 cats both invoked with mode=parallel (auto ideate)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusPrompt = '';
    let codexPrompt = '';
    const mockClaudeService = {
      invoke: mock.fn(async function* (prompt) {
        opusPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'Opus thinks', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'Codex thinks', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus @codex what do you think?')) {
      messages.push(msg);
    }

    assert.equal(mockClaudeService.invoke.mock.callCount(), 1);
    assert.equal(mockCodexService.invoke.mock.callCount(), 1);

    // Both prompts should contain parallel mode text, NOT chain position
    assert.ok(opusPrompt.includes('独立思考'), 'Opus should get parallel mode');
    assert.ok(codexPrompt.includes('独立思考'), 'Codex should get parallel mode');
    assert.ok(!opusPrompt.includes('被召唤'), 'Opus should NOT have serial chain text');
    assert.ok(!codexPrompt.includes('被召唤'), 'Codex should NOT have serial chain text');

    // Both texts should be present
    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 2);
  });

  test('parallel: codex does NOT see opus response (independent thinking)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexPrompt = '';
    const mockClaudeService = createMockAgentService('opus', 'Opus unique response');
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'Codex response', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '@opus @codex brainstorm this')) {
      // consume
    }

    assert.ok(!codexPrompt.includes('Opus unique response'), 'Codex should NOT see opus response in parallel mode');
  });

  test('parallel: isFinal only on last done message', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus', 'a'),
        codexService: createMockAgentService('codex', 'b'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const doneMessages = [];
    for await (const msg of router.route('user-1', '@opus @codex parallel test')) {
      if (msg.type === 'done') doneMessages.push(msg);
    }

    assert.equal(doneMessages.length, 2, 'Should have 2 done messages');
    // Exactly one should have isFinal=true
    const finalCount = doneMessages.filter((m) => m.isFinal).length;
    assert.equal(finalCount, 1, 'Exactly one done should be isFinal');
    // The last done should be isFinal
    assert.ok(doneMessages[doneMessages.length - 1].isFinal, 'Last done should be isFinal');
  });

  test('parallel: #execute forces serial mode metadata even with multiple cats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexPrompt = '';
    const mockClaudeService = createMockAgentService('opus', 'Serial opus');
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'Serial codex', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    for await (const _ of router.route('user-1', '#execute @opus @codex do this')) {
      // consume
    }

    // Play mode: codex should NOT see opus stream response.
    assert.ok(!codexPrompt.includes('Serial opus'), '#execute should keep stream isolation in play mode');
    assert.ok(codexPrompt.includes('被召唤'), '#execute should use serial mode text');
  });

  test('parallel: #execute in debug mode includes previous stream responses', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let codexPrompt = '';
    const mockClaudeService = createMockAgentService('opus', 'Serial opus');
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'Serial codex', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore: createDebugThinkingThreadStore(),
      }),
    );

    for await (const _ of router.route('user-1', '#execute @opus @codex do this')) {
      // consume
    }

    assert.ok(codexPrompt.includes('Serial opus'), '#execute in debug mode should include previous stream response');
    assert.ok(codexPrompt.includes('被召唤'), '#execute in debug mode should keep serial mode text');
  });

  test('parallel: all cat responses are stored in messageStore', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const appendedMessages = [];
    const store = {
      ...createMockMessageStore(),
      append: (msg) => {
        appendedMessages.push(msg);
        return { ...msg, id: 'msg-1' };
      },
    };
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus', 'Opus stored'),
        codexService: createMockAgentService('codex', 'Codex stored'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: store,
      }),
    );

    for await (const _ of router.route('user-1', '@opus @codex store test')) {
      // consume
    }

    // User message + 2 cat responses = 3 appends
    assert.equal(appendedMessages.length, 3);
    const appendedCatIds = appendedMessages.map((m) => m.catId).filter(Boolean);
    assert.ok(appendedCatIds.includes('opus'), 'Opus response should be stored');
    assert.ok(appendedCatIds.includes('codex'), 'Codex response should be stored');
  });

  test('parallel: 3 cats all invoked independently', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const mockClaude = createMockAgentService('opus', 'a');
    const mockCodex = createMockAgentService('codex', 'b');
    const mockGemini = createMockAgentService('gemini', 'c');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaude,
        codexService: mockCodex,
        geminiService: mockGemini,
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const messages = [];
    for await (const msg of router.route('user-1', '@opus @codex @gemini three way')) {
      messages.push(msg);
    }

    assert.equal(mockClaude.invoke.mock.callCount(), 1);
    assert.equal(mockCodex.invoke.mock.callCount(), 1);
    assert.equal(mockGemini.invoke.mock.callCount(), 1);

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 3);
    const dones = messages.filter((m) => m.type === 'done');
    assert.equal(dones.length, 3);
    assert.equal(dones.filter((m) => m.isFinal).length, 1);
  });

  // --- Context history injection tests (Phase 3.6) ---

  test('context history: single cat prompt includes thread history', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusPrompt = '';
    const mockClaudeService = {
      invoke: mock.fn(async function* (prompt) {
        opusPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const store = createMockMessageStore();
    store.append({
      userId: 'user-1',
      catId: null,
      content: 'earlier question',
      mentions: [],
      timestamp: 1000,
      threadId: 'default',
    });
    store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'earlier answer',
      mentions: [],
      timestamp: 2000,
      threadId: 'default',
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: store,
      }),
    );

    for await (const _ of router.route('user-1', '@opus follow up')) {
    }

    assert.ok(opusPrompt.includes('对话历史'), 'Prompt should contain context history header');
    assert.ok(opusPrompt.includes('earlier question'), 'Prompt should contain user history');
    assert.ok(opusPrompt.includes('follow up'), 'Prompt should contain current user message');
  });

  test('context history: serial multi-cat — both cats receive history', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusPrompt = '';
    let codexPrompt = '';
    const mockClaudeService = {
      invoke: mock.fn(async function* (prompt) {
        opusPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'opus reply', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'codex reply', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const store = createMockMessageStore();
    store.append({
      userId: 'user-1',
      catId: 'gemini',
      content: 'gemini said something',
      mentions: [],
      timestamp: 1000,
      threadId: 'default',
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: store,
      }),
    );

    for await (const _ of router.route('user-1', '#execute @opus @codex review')) {
    }

    assert.ok(opusPrompt.includes('gemini said something'), 'Opus should see gemini history');
    assert.ok(codexPrompt.includes('gemini said something'), 'Codex should see gemini history');
  });

  test('context history: parallel multi-cat — both cats receive history', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusPrompt = '';
    let codexPrompt = '';
    const mockClaudeService = {
      invoke: mock.fn(async function* (prompt) {
        opusPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'a', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };
    const mockCodexService = {
      invoke: mock.fn(async function* (prompt) {
        codexPrompt = prompt;
        yield { type: 'text', catId: 'codex', content: 'b', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
    };

    const store = createMockMessageStore();
    store.append({
      userId: 'user-1',
      catId: null,
      content: 'user said hi',
      mentions: [],
      timestamp: 1000,
      threadId: 'default',
    });

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: mockCodexService,
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: store,
      }),
    );

    for await (const _ of router.route('user-1', '@opus @codex think about this')) {
    }

    assert.ok(opusPrompt.includes('user said hi'), 'Opus should see history in parallel mode');
    assert.ok(codexPrompt.includes('user said hi'), 'Codex should see history in parallel mode');
  });

  test('context history: empty history — no context header in prompt', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusPrompt = '';
    const mockClaudeService = {
      invoke: mock.fn(async function* (prompt) {
        opusPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    };

    const store = createMockMessageStore();
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: store,
      }),
    );

    for await (const _ of router.route('user-1', '@opus first message')) {
    }

    assert.ok(opusPrompt.includes('对话历史增量'), 'Incremental mode should include delta header');
    assert.ok(!opusPrompt.includes('[对话历史 - 最近'), 'Legacy history header should not be used');
    assert.ok(opusPrompt.includes('first message'), 'Prompt should still have the message');
  });

  test('parallel: resolveTargetsAndIntent returns correct intent', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const result1 = await router.resolveTargetsAndIntent('@opus @codex think');
    assert.equal(result1.intent.intent, 'ideate', '2 cats should auto-ideate');
    assert.equal(result1.targetCats.length, 2);

    const result2 = await router.resolveTargetsAndIntent('#execute @opus @codex do');
    assert.equal(result2.intent.intent, 'execute', '#execute should force execute');

    const result3 = await router.resolveTargetsAndIntent('@opus solo');
    assert.equal(result3.intent.intent, 'execute', '1 cat should default to execute');
  });
});

// ── F078: Smart Routing & Group Mentions ─────────────────────────────

describe('F078: Default to last replier', () => {
  test('no @mention routes to most recent replier only (not all participants)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex', 'gemini'] });
    // Simulate activity: codex first, then opus most recently
    threadStore.updateParticipantActivity('t1', 'gemini');
    threadStore.updateParticipantActivity('t1', 'codex');
    threadStore.updateParticipantActivity('t1', 'opus'); // most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
    assert.deepStrictEqual(targetCats, ['opus'], 'should route to last replier only');
  });

  test('no participants defaults to opus', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({});
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
    assert.deepStrictEqual(targetCats, ['opus']);
  });

  test('no @mention skips unavailable last replier and preferred cats', async () => {
    await withAvailabilityConfig({ codex: false }, async () => {
      const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

      const threadStore = createMockThreadStore({ t1: ['codex', 'gemini'] }, {}, {}, { t1: ['codex', 'gemini'] });
      threadStore.updateParticipantActivity('t1', 'gemini');
      threadStore.updateParticipantActivity('t1', 'codex');

      const router = new AgentRouter(
        await migrateRouterOpts({
          claudeService: createMockAgentService('opus'),
          codexService: createMockAgentService('codex'),
          geminiService: createMockAgentService('gemini'),
          registry: createMockRegistry(),
          messageStore: createMockMessageStore(),
          threadStore,
        }),
      );

      const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
      assert.deepStrictEqual(targetCats, ['gemini'], 'should skip unavailable last replier/preferred cats');
    });
  });

  test('no participants falls back away from an unavailable default cat', async () => {
    await withAvailabilityConfig({ opus: false }, async () => {
      const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

      const threadStore = createMockThreadStore({});
      const router = new AgentRouter(
        await migrateRouterOpts({
          claudeService: createMockAgentService('opus'),
          codexService: createMockAgentService('codex'),
          geminiService: createMockAgentService('gemini'),
          registry: createMockRegistry(),
          messageStore: createMockMessageStore(),
          threadStore,
        }),
      );

      const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
      assert.deepStrictEqual(
        targetCats,
        ['codex'],
        'should skip unavailable default cat and pick an available fallback',
      );
    });
  });

  test('explicit @mention still overrides last-replier default', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('t1', 'opus'); // most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@codex 帮我看看', 't1');
    assert.deepStrictEqual(targetCats, ['codex'], 'explicit @mention should override');
  });
});

describe('F078: Group mentions', () => {
  test('@all routes to all registered cats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@all 大家好');
    assert.ok(targetCats.length >= 3, 'should route to all registered cats');
    assert.ok(targetCats.includes('opus'));
    assert.ok(targetCats.includes('codex'));
    assert.ok(targetCats.includes('gemini'));
  });

  test('@all skips unavailable cats', async () => {
    await withAvailabilityConfig({ codex: false }, async () => {
      const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

      const router = new AgentRouter(
        await migrateRouterOpts({
          claudeService: createMockAgentService('opus'),
          codexService: createMockAgentService('codex'),
          geminiService: createMockAgentService('gemini'),
          registry: createMockRegistry(),
          messageStore: createMockMessageStore(),
        }),
      );

      const { targetCats } = await router.resolveTargetsAndIntent('@all 大家好');
      assert.ok(targetCats.includes('opus'));
      assert.ok(targetCats.includes('gemini'));
      assert.ok(!targetCats.includes('codex'), 'unavailable cat should be excluded from @all routing');
    });
  });

  test('@全体 routes to all registered cats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@全体 大家好');
    assert.ok(targetCats.length >= 3);
    assert.ok(targetCats.includes('opus'));
  });

  test('@全体布偶猫 routes to all ragdoll variants', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // Register sonnet as a second ragdoll variant
    const { catRegistry, createCatId } = await import('@cat-cafe/shared');
    if (!catRegistry.has('sonnet')) {
      catRegistry.register('sonnet', {
        id: createCatId('sonnet'),
        name: 'sonnet',
        displayName: '布偶猫',
        avatar: '/avatars/sonnet.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@sonnet', '@布偶sonnet'],
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        mcpSupport: true,
        breedId: 'ragdoll',
        roleDescription: 'Fast variant',
        personality: 'Quick and flexible',
      });
    }

    // Need AgentRegistry with sonnet too
    const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockAgentService('opus'));
    agentRegistry.register('sonnet', createMockAgentService('sonnet'));
    agentRegistry.register('codex', createMockAgentService('codex'));
    agentRegistry.register('gemini', createMockAgentService('gemini'));

    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
    });

    const { targetCats } = await router.resolveTargetsAndIntent('@全体布偶猫 你们好');
    assert.ok(targetCats.includes('opus'), 'should include opus (ragdoll)');
    assert.ok(targetCats.includes('sonnet'), 'should include sonnet (ragdoll)');
    assert.ok(!targetCats.includes('codex'), 'should NOT include codex (maine-coon)');
    assert.ok(!targetCats.includes('gemini'), 'should NOT include gemini (siamese)');
  });

  test('@all-ragdoll routes to ragdoll variants', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // sonnet already registered from previous test
    const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockAgentService('opus'));
    agentRegistry.register('sonnet', createMockAgentService('sonnet'));
    agentRegistry.register('codex', createMockAgentService('codex'));

    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
    });

    const { targetCats } = await router.resolveTargetsAndIntent('@all-ragdoll hello');
    assert.ok(targetCats.includes('opus'));
    assert.ok(targetCats.includes('sonnet'));
    assert.ok(!targetCats.includes('codex'));
  });

  test('@thread routes to current thread participants', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex'] });
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@thread 大家看看', 't1');
    assert.deepStrictEqual(new Set(targetCats), new Set(['opus', 'codex']));
  });

  test('@本帖 routes to thread participants', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'gemini'] });
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@本帖 看看', 't1');
    assert.deepStrictEqual(new Set(targetCats), new Set(['opus', 'gemini']));
  });

  test('@全体参与者 routes to thread participants', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['codex', 'gemini'] });
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@全体参与者 看看', 't1');
    assert.deepStrictEqual(new Set(targetCats), new Set(['codex', 'gemini']));
  });

  test('@thread with no participants falls back to default cat', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({});
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@thread hello', 't1');
    assert.deepStrictEqual(targetCats, ['opus'], 'no participants → fallback to default');
  });

  test('group mentions only include cats with registered services', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // Only register opus and codex services (not gemini)
    const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockAgentService('opus'));
    agentRegistry.register('codex', createMockAgentService('codex'));

    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
    });

    const { targetCats } = await router.resolveTargetsAndIntent('@all 大家好');
    assert.ok(targetCats.includes('opus'));
    assert.ok(targetCats.includes('codex'));
    assert.ok(!targetCats.includes('gemini'), 'gemini has no service, should be excluded');
  });

  // P1 fix: negative cases — substring collisions must NOT trigger group mentions
  test('@allison does NOT trigger @all (token boundary)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@allison hi');
    // @allison is not a known mention — should fall back to default, NOT trigger @all
    assert.ok(!targetCats.includes('codex'), '@allison should not broadcast to all cats');
    assert.ok(!targetCats.includes('gemini'), '@allison should not broadcast to all cats');
  });

  test('@threadsafe does NOT trigger @thread (token boundary)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex'] });
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@threadsafe hi', 't1');
    // Should NOT route to thread participants — @threadsafe is not @thread
    assert.equal(targetCats.length, 1, '@threadsafe should not trigger group mention');
  });

  test('@all-ragdollish does NOT trigger @all-ragdoll (token boundary)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const { catRegistry, createCatId } = await import('@cat-cafe/shared');
    if (!catRegistry.has('sonnet')) {
      catRegistry.register('sonnet', {
        id: createCatId('sonnet'),
        name: 'sonnet',
        displayName: '布偶猫',
        avatar: '/avatars/sonnet.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@sonnet', '@布偶sonnet'],
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        mcpSupport: true,
        breedId: 'ragdoll',
        roleDescription: 'Fast variant',
        personality: 'Quick and flexible',
      });
    }

    const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockAgentService('opus'));
    agentRegistry.register('sonnet', createMockAgentService('sonnet'));
    agentRegistry.register('codex', createMockAgentService('codex'));

    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
    });

    const { targetCats } = await router.resolveTargetsAndIntent('@all-ragdollish hi');
    // Should NOT trigger @all-ragdoll breed group
    assert.ok(!targetCats.includes('sonnet'), '@all-ragdollish should not match @all-ragdoll');
  });

  test('@全体布偶猫咪 does NOT trigger @全体布偶猫 (token boundary)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@全体布偶猫咪 hi');
    // 咪 is not a boundary char — should NOT match @全体布偶猫
    assert.equal(targetCats.length, 1, '@全体布偶猫咪 should not trigger breed group');
  });
});

// ────────────────────────────────────────────────────────────────
// #58: preferredCats should act as candidate scope, not dispatch list
// ────────────────────────────────────────────────────────────────

describe('#58: preferredCats candidate scope (not dispatch list)', () => {
  test('multi preferredCats + last replier in preferred set → routes to last replier only', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      { t1: ['opus', 'codex', 'gemini'] },
      {},
      {},
      { t1: ['opus', 'codex', 'gemini'] },
    );
    threadStore.updateParticipantActivity('t1', 'opus');
    threadStore.updateParticipantActivity('t1', 'gemini');
    threadStore.updateParticipantActivity('t1', 'codex'); // most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
    assert.deepStrictEqual(targetCats, ['codex'], 'should route to last replier, not all preferred cats');
  });

  test('last replier NOT in preferred set → still routes to last replier (user mental model)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      { t1: ['opus', 'codex', 'gemini'] },
      {},
      {},
      { t1: ['opus', 'gemini'] }, // codex not in preferred
    );
    threadStore.updateParticipantActivity('t1', 'opus');
    threadStore.updateParticipantActivity('t1', 'codex'); // most recent, but not preferred

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
    assert.deepStrictEqual(
      targetCats,
      ['codex'],
      'should route to last replier even when outside preferred set — user expects continuity',
    );
  });

  test('@mention overrides preferredCats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore(
      { t1: ['opus', 'codex'] },
      {},
      {},
      { t1: ['opus'] }, // only opus preferred
    );
    threadStore.updateParticipantActivity('t1', 'opus'); // most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('@codex review this', 't1');
    assert.deepStrictEqual(targetCats, ['codex'], '@mention should override preferredCats');
  });

  test('no preferredCats preserves existing last-replier behavior', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex', 'gemini'] });
    threadStore.updateParticipantActivity('t1', 'codex');
    threadStore.updateParticipantActivity('t1', 'opus');
    threadStore.updateParticipantActivity('t1', 'gemini'); // most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('hello', 't1');
    assert.deepStrictEqual(targetCats, ['gemini'], 'without preferredCats, last replier should still work');
  });

  test('@全体布偶猫 still triggers parallel dispatch even with preferredCats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
    const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

    // Register sonnet as a second ragdoll variant (needed for breed group mention)
    const { catRegistry, createCatId } = await import('@cat-cafe/shared');
    if (!catRegistry.has('sonnet')) {
      catRegistry.register('sonnet', {
        id: createCatId('sonnet'),
        name: 'sonnet',
        displayName: '布偶猫',
        avatar: '/avatars/sonnet.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@sonnet', '@布偶sonnet'],
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        mcpSupport: true,
        breedId: 'ragdoll',
        roleDescription: 'Fast variant',
        personality: 'Quick and flexible',
      });
    }

    const threadStore = createMockThreadStore(
      { t1: ['opus'] },
      {},
      {},
      { t1: ['opus'] }, // only opus preferred
    );
    threadStore.updateParticipantActivity('t1', 'opus');

    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockAgentService('opus'));
    agentRegistry.register('sonnet', createMockAgentService('sonnet'));
    agentRegistry.register('codex', createMockAgentService('codex'));
    agentRegistry.register('gemini', createMockAgentService('gemini'));

    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      threadStore,
    });

    const { targetCats } = await router.resolveTargetsAndIntent('@全体布偶猫 discuss this', 't1');
    // @全体布偶猫 is a breed group mention — should override preferredCats and route to all ragdolls
    assert.ok(targetCats.length > 1, '@全体布偶猫 should still trigger multi-cat dispatch');
    assert.ok(targetCats.includes('opus'), 'should include opus');
  });

  test('explicit #ideate with multi preferredCats dispatches all preferred cats', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex'] }, {}, {}, { t1: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('t1', 'opus');
    threadStore.updateParticipantActivity('t1', 'codex');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats, intent } = await router.resolveTargetsAndIntent('#ideate discuss this together', 't1');
    assert.deepStrictEqual(targetCats.sort(), ['codex', 'opus'], '#ideate should dispatch all preferred cats');
    assert.equal(intent.intent, 'ideate', 'intent should be ideate');
    assert.equal(intent.explicit, true, 'ideate should be explicit');
  });

  test('no #ideate with multi preferredCats still routes to single cat', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const threadStore = createMockThreadStore({ t1: ['opus', 'codex'] }, {}, {}, { t1: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('t1', 'opus');
    threadStore.updateParticipantActivity('t1', 'codex');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: createMockMessageStore(),
        threadStore,
      }),
    );

    const { targetCats } = await router.resolveTargetsAndIntent('just a normal message', 't1');
    assert.equal(targetCats.length, 1, 'without #ideate, should still route to single cat');
  });

  test('refreshFromRegistry updates routable service set after runtime catalog changes', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
    const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
    const { catRegistry } = await import('@cat-cafe/shared');

    const threadStore = createMockThreadStore();
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockAgentService('opus'));
    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      threadStore,
    });

    // Before refresh: codex is in catRegistry (mention parsing) but NOT in agentRegistry
    // Mention resolution finds codex, but route() will fail to dispatch it
    const before = await router.resolveTargetsAndIntent('@codex review this', 't1');
    assert.deepEqual(before.targetCats, ['codex'], 'codex mention should be parsed from catRegistry');

    const codexConfig = catRegistry.tryGet('codex')?.config;
    assert.ok(codexConfig, 'codex config should exist');
    agentRegistry.register('codex', createMockAgentService('codex'));
    router.refreshFromRegistry(agentRegistry);

    // After refresh: codex is both in catRegistry AND agentRegistry — fully routable
    const after = await router.resolveTargetsAndIntent('@codex review this', 't1');
    assert.deepEqual(after.targetCats, ['codex'], 'codex should be routable after refresh');
  });

  // F194 Phase Z5 AC-Z16: 无 @ fallback 优先用上一条 user message 的 mentions，
  // 不让 thread 里其他猫的发言（如 vision guard）抢路由 fallback。
  // 铲屎官 alpha catch 2026-05-10 04:51："明明 at 的最后一只猫是 47 or 55 但是召唤出来的却是 46"
  // user message 严格定义：userId !== null && catId === null（cat-to-cat handoff/vision guard 不计）
  test('AC-Z16: no-mention msg falls back to PREVIOUS user message mentions, not thread activity', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now() - 5000; // recent — within Z5 1h time window
    // user msg1 @ codex + opus
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex @opus think about this',
      mentions: ['codex', 'opus'],
      timestamp: baseTs,
      threadId: 't_z16',
    });
    // gemini (vision guard cat) replied — would normally win lastMessageAt
    messageStore.append({
      userId: null,
      catId: 'gemini',
      content: '愿景守护对照表 done',
      mentions: [],
      timestamp: baseTs + 100,
      threadId: 't_z16',
    });

    const threadStore = createMockThreadStore({ t_z16: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16', 'gemini'); // gemini most recent → would win pre-Z5

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    // user msg2 (current message under resolution) has no @
    const result = await router.resolveTargetsAndIntent('继续刚才的讨论', 't_z16');
    // GREEN after Z6: fallback picks one deterministic cat from prev user mentions [codex, opus].
    // RED before Z5: gemini wins via lastMessageAt → wrong cat.
    // RED in Z5: both codex+opus are invoked → over-broad parallel fallback.
    assert.deepEqual(result.targetCats, ['codex']);
    assert.ok(
      !result.targetCats.includes('gemini'),
      `gemini was vision guard cat, NOT user-mentioned — must not win fallback. got ${JSON.stringify(result.targetCats)}`,
    );
  });

  test('AC-Z16: cat-to-cat handoff messages (catId-bearing) are NOT counted as user messages', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now() - 5000; // recent — within Z5 1h time window
    // user msg @ opus
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@opus do this',
      mentions: ['opus'],
      timestamp: baseTs,
      threadId: 't_z16b',
    });
    // opus replied with @codex (A2A handoff) — has both userId AND catId, NOT a user message
    messageStore.append({
      userId: null,
      catId: 'opus',
      content: '@codex 你来 review',
      mentions: ['codex'],
      timestamp: baseTs + 100,
      threadId: 't_z16b',
    });

    const threadStore = createMockThreadStore({ t_z16b: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('t_z16b', 'opus');
    threadStore.updateParticipantActivity('t_z16b', 'codex');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    // user msg2 no @ — fallback should use prev USER msg's mentions [opus], NOT cat-to-cat A2A's mentions [codex]
    const result = await router.resolveTargetsAndIntent('谢谢', 't_z16b');
    assert.deepEqual(
      result.targetCats,
      ['opus'],
      'fallback uses last user msg mentions [opus], ignores cat A2A mentions',
    );
  });

  test('AC-Z16 R2: async messageStore (Redis-style) — getByThread returns Promise, must be awaited (砚砚 R1 P1#1)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    // Async messageStore mock — mirror RedisMessageStore.getByThread Promise return
    const userMsg = {
      id: 'msg-async-1',
      userId: 'user-1',
      catId: null,
      content: '@codex 来 review',
      mentions: ['codex'],
      timestamp: Date.now() - 5000, // recent — within Z5 1h time window
      threadId: 't_async_z16',
    };
    const asyncMessageStore = {
      append: () => userMsg,
      getById: async () => userMsg,
      getRecent: async () => [userMsg],
      getMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [userMsg], // ← Promise return — Z5 R1 was missing await
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
      deleteByThread: async () => 0,
    };

    const threadStore = createMockThreadStore({ t_async_z16: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_async_z16', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_async_z16', 'gemini'); // gemini most recent → would抢上游 if fallback skipped

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: asyncMessageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续讨论', 't_async_z16');
    // GREEN after R2 fix: await Promise → fallback returns [codex] (last user msg mentions)
    // RED before R2 fix: Array.isArray(Promise) === false → fallback returns null → legacy
    //   participantsWithActivity wins → gemini selected (wrong)
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'async messageStore.getByThread must be awaited; codex (last user mention) wins, not gemini (last activity)',
    );
  });

  test('AC-Z16 R3: user @ + 6 cat/vision-guard messages between + no-@ → still finds user mention (砚砚 R2 P1)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now() - 10000; // recent enough to pass 1h window

    // user msg @ codex
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs,
      threadId: 't_z16_window',
    });
    // 6 cat/vision-guard messages between (would挤出 5-thread-message window if window 取 thread msgs)
    for (let i = 0; i < 6; i += 1) {
      messageStore.append({
        userId: null,
        catId: i % 2 === 0 ? 'gemini' : 'opus',
        content: `cat msg ${i} (vision guard / handoff)`,
        mentions: [],
        timestamp: baseTs + (i + 1) * 100,
        threadId: 't_z16_window',
      });
    }

    const threadStore = createMockThreadStore({ t_z16_window: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_window', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_window', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_window', 'gemini'); // gemini latest activity

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续刚才的', 't_z16_window');
    // GREEN after R3 fix: window fetches 50 thread messages, counts up to 5 user messages,
    //   finds first user msg with mentions → codex
    // RED before R3 fix: window=5 thread messages = 6 cat messages full, no user msg seen →
    //   fallback null → legacy participantsWithActivity → gemini selected (wrong)
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'window should count user messages not thread messages; cat dispatches between user @ and current msg should not push out user mention',
    );
  });

  test('AC-Z16 R3: time window 1h cutoff — old user mention not used as fallback', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const oldTs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago — beyond window

    // 远古 user msg @ codex
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 老问题',
      mentions: ['codex'],
      timestamp: oldTs,
      threadId: 't_z16_old',
    });

    const threadStore = createMockThreadStore({ t_z16_old: ['codex', 'opus'] });
    threadStore.updateParticipantActivity('t_z16_old', 'opus'); // opus most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('hi', 't_z16_old');
    // 远古 mention (>1h ago) 不再用 → fallback to legacy participantsWithActivity → opus
    assert.deepEqual(result.targetCats, ['opus'], 'old user mention beyond 1h window should not win fallback');
  });

  test('AC-Z16 R4: 51+ non-user messages between user @ and current → pagination still finds user mention (砚砚 R3 P1)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now() - 30000; // recent enough to pass 1h window

    // user msg @ codex (oldest in thread)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs,
      threadId: 't_z16_pagination',
    });
    // 51 cat/vision-guard messages between — overflows any single-page lookback (50)
    // R3's "fetch 50" still missed user mention because user @ would be page-2 territory.
    for (let i = 0; i < 51; i += 1) {
      messageStore.append({
        userId: null,
        catId: i % 2 === 0 ? 'gemini' : 'opus',
        content: `cat msg ${i} (vision guard / handoff)`,
        mentions: [],
        timestamp: baseTs + (i + 1) * 10,
        threadId: 't_z16_pagination',
      });
    }

    const threadStore = createMockThreadStore({ t_z16_pagination: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_pagination', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_pagination', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_pagination', 'gemini'); // gemini latest activity

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续刚才的', 't_z16_pagination');
    // GREEN after R4: pagination loops with getByThreadBefore beyond first 50,
    //   finds user @ codex on later page → returns ['codex']
    // RED before R4: 50-message single-page lookback never reaches the user msg →
    //   fallback null → legacy participantsWithActivity → gemini selected (wrong)
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'pagination should keep walking past one page of cat messages until user mention or 5 user msgs / 1h cutoff',
    );
  });

  test('AC-Z16 R5: system notices (userId="system") must NOT count as user messages (cloud Codex P1)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now() - 30000;

    // 真正的 user msg @ codex (oldest)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs,
      threadId: 't_z16_sys',
    });
    // 5 个 system 通知（route-serial.ts 持久化 system 注入用 userId='system', catId=null）
    // 当前实现把它们也算 user message → 5 条 system 占满 user count limit → 找不到真正
    // 的 user @ codex → fallback 退化到 participantsWithActivity (gemini)
    for (let i = 0; i < 5; i += 1) {
      messageStore.append({
        userId: 'system',
        catId: null,
        content: `[SYS] 自动通知 #${i}`,
        mentions: [],
        timestamp: baseTs + (i + 1) * 100,
        threadId: 't_z16_sys',
      });
    }

    const threadStore = createMockThreadStore({ t_z16_sys: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_sys', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_sys', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_sys', 'gemini'); // gemini latest activity

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续', 't_z16_sys');
    // GREEN after R5: system notices excluded from user count → reaches真正的 user msg @ codex
    // RED before R5: 5 system notices consume the count limit → fallback null → gemini wins (wrong)
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'system notices (userId=system, catId=null) must not count as user messages — they should not consume the 5-msg lookback limit',
    );
  });

  test('AC-Z16 R11: page-level cutoff stops scan when oldestScore < 1h ago (砚砚 R10 P2)', async () => {
    // 砚砚 R10 P2: 1h cutoff 在 isUserMessage filter 之后判断，导致只扫 user msg 时才 trip。
    // 高流量 thread (e.g. 300 cat msgs) 全部 > 1h ago + 0 user msg → 当前 R10 实现会扫完整
    // 历史才退出 (no more history)，浪费 page query。
    // 修法: 每页反序扫完没命中 user mention 后，检查 page[0].effectiveScore < cutoffTimestamp，
    // 直接 return null（下一页 effective score 只会更老，不会有可用 user mention）。
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now();

    // 300 条 cat msgs 全部 > 1h ago (no user msg at all)
    for (let i = 0; i < 300; i += 1) {
      messageStore.append({
        userId: null,
        catId: i % 2 === 0 ? 'gemini' : 'opus',
        content: `vision-guard ancient ${i}`,
        mentions: [],
        timestamp: baseTs - 2 * 60 * 60 * 1000 - i * 1000, // 全部 > 2h ago
        threadId: 't_z16_pcutoff',
      });
    }

    // 计数 store calls 验证 early stop
    let pageCalls = 0;
    const wrappedStore = {
      ...messageStore,
      getByThread: (...args) => {
        pageCalls += 1;
        return messageStore.getByThread(...args);
      },
      getByThreadBefore: (...args) => {
        pageCalls += 1;
        return messageStore.getByThreadBefore(...args);
      },
    };

    const threadStore = createMockThreadStore({ t_z16_pcutoff: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_pcutoff', 'gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore: wrappedStore,
        threadStore,
      }),
    );

    await router.resolveTargetsAndIntent('继续', 't_z16_pcutoff');
    // GREEN after R11: page-level cutoff trigger 后 ≤2 page calls (1 from peekTargets + 1 from resolveTargets,
    //   each finds first page with oldestScore < cutoff and stops immediately)
    // RED before R11: scans all 300 msgs / 50 = 6 pages × 2 (peek + resolve) = 12 page calls
    // 用阈值 ≤4 (peek + resolve 各 ≤2 calls) 判断 early stop
    assert.ok(
      pageCalls <= 4,
      `page-level cutoff should stop after first page when oldestScore < 1h cutoff; got ${pageCalls} page calls (expected ≤4)`,
    );
  });

  test('AC-Z16 R10: 250+ non-user msgs do not cap fallback scan (cloud Codex round-6 P2)', async () => {
    // Cloud Codex round-6 P2: R9 之前 Z5_MAX_PAGES=5 → 50*5=250 thread msgs 上限。
    // 高流量 thread (vision-guard / handoff spam > 250 条) + 1h 内 user msg < 5
    //   → page cap trip → return null → fallback 退化回 participantsWithActivity。
    // Spec stop conditions only: 5 user msgs / 1h cutoff / no more history。无固定 page cap。
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now();

    // msg 1 (oldest): user @ codex within 1h (recent enough)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs - 30 * 60 * 1000, // 30 min ago, within 1h cutoff
      threadId: 't_z16_unbounded',
    });
    // 300 cat / vision-guard messages between (would trip Z5_MAX_PAGES * Z5_PAGE_SIZE = 250 cap)
    for (let i = 0; i < 300; i += 1) {
      messageStore.append({
        userId: null,
        catId: i % 2 === 0 ? 'gemini' : 'opus',
        content: `vision-guard / handoff msg ${i}`,
        mentions: [],
        timestamp: baseTs - 25 * 60 * 1000 + i * 1000, // staggered ts in 25min..0s ago
        threadId: 't_z16_unbounded',
      });
    }

    const threadStore = createMockThreadStore({ t_z16_unbounded: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_unbounded', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_unbounded', 'gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续', 't_z16_unbounded');
    // GREEN after R10: pagination keeps walking past 250+ non-user msgs until找到 user @ codex (within 1h)
    // RED before R10: Z5_MAX_PAGES=5 caps at 250 → user @ codex on page 7 → null → gemini wins
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'pagination must not impose fixed thread-msg cap — only spec stop conditions (5 user msgs / 1h cutoff / no more history) apply',
    );
  });

  test('AC-Z16 R9: cross-page cursor uses effective score (deliveredAt ?? timestamp) (砚砚 R8 P1)', async () => {
    // 砚砚 R8 review退回 1 P1: pagination cursor 用 oldest.timestamp（原 send-time），
    // 不是 effective score = deliveredAt ?? timestamp。Redis markDelivered 把 thread zset
    // 的 score 改成 deliveredAt 但 msg.timestamp 仍是 send-time。如果 page 1 boundary 落在
    // 一条 re-delivered 老消息（timestamp << deliveredAt），cursor 跳到老 send-time，
    // 整个 deliveredAt 排序的中间区间被跳过，真正的 user mention 在那段里就漏。
    // 修法: cursor + cutoff 都用 effectiveOrderTime = deliveredAt ?? timestamp。
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now();

    // msg 1: 真正的 recent user @ codex (oldest by score in this scenario)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs - 90 * 1000, // score = now-90s (oldest)
      threadId: 't_z16_xpage',
    });
    // msg 2: re-delivered system msg — 落到 page 1 boundary (最旧 score in page 1).
    // 关键: timestamp << deliveredAt 让 cursor=oldest.timestamp 跳到老 send-time。
    messageStore.append({
      userId: 'system',
      catId: null,
      content: '[Re-delivered] queued 2h ago, just delivered',
      mentions: [],
      timestamp: baseTs - 2 * 60 * 60 * 1000, // OLD send-time (2h ago)
      deliveredAt: baseTs - 60 * 1000, // score = now-60s
      threadId: 't_z16_xpage',
    });
    // msg 3-51: 49 条 cat msgs，score 都比 msg 2 新 (now-50s..now-1s)。
    // 让 page 1 (top 50 by score) = [msg2, msg3, ..., msg51]，page[0] = msg2 (re-delivered)。
    for (let i = 0; i < 49; i += 1) {
      messageStore.append({
        userId: null,
        catId: i % 2 === 0 ? 'gemini' : 'opus',
        content: `cat msg ${i}`,
        mentions: [],
        timestamp: baseTs - 50 * 1000 + i * 1000, // ts in now-50s..now-2s
        threadId: 't_z16_xpage',
      });
    }

    const threadStore = createMockThreadStore({ t_z16_xpage: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_xpage', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_xpage', 'gemini'); // gemini latest

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续', 't_z16_xpage');
    // GREEN after R9: cursor 用 effectiveOrderTime = deliveredAt ?? timestamp
    //   page 1 boundary effective = msg 2 effective ≈ now-30s → page 2 returns msg 1 (effective=now-1min < now-30s) → user @ codex found
    // RED before R9: cursor = oldest.timestamp = msg 51's send-time (2h ago)
    //   page 2 query returns msgs with score < 2h ago → 空 (msg 1 score=now-1min > 2h ago)
    //   → 找不到 user mention → fallback null → gemini wins
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'pagination cursor must use effectiveOrderTime (deliveredAt ?? timestamp) — Redis markDelivered re-score breaks send-time-based cursor',
    );
  });

  test('AC-Z16 R8: 1h cutoff only applies to USER messages (cloud Codex round-4 P1 — Redis markDelivered re-score)', async () => {
    // Cloud Codex round-4 P1: Redis `markDelivered` 把 thread sorted set 的 score 改成
    // deliveredAt，但 msg.timestamp 仍是原 send-time。一条原本 send-time 在 2h 前但
    // 刚刚被 markDelivered 的 system/cat 消息会出现在 recent page 里。当前实现把 cutoff
    // 应用在 EVERY message → 反序扫遇到这条老 ts 的非 user 消息直接 return null →
    // 跳过同页里真正 recent 的 user mention → fallback 退化回 participantsWithActivity。
    // 修法：cutoff 只应用在 user message 上（非 user msg 用 continue 跳过即可）。
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now();

    // msg 1 (id 0001): 真正的 recent user @ codex
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs - 30000, // recent (30s ago)
      threadId: 't_z16_redeliver',
    });
    // msg 2 (id 0002): system 消息 — timestamp 老 (2h 前) 但被 markDelivered 后排到 recent slot
    // 在 mock 里通过 id 顺序模拟「较新的 list 位置」（real Redis 用 score）。
    messageStore.append({
      userId: 'system',
      catId: null,
      content: '[Re-delivered] 老消息但刚被推给 user',
      mentions: [],
      timestamp: baseTs - 2 * 60 * 60 * 1000, // OLD timestamp (2h ago)
      threadId: 't_z16_redeliver',
    });

    const threadStore = createMockThreadStore({ t_z16_redeliver: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_redeliver', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_redeliver', 'gemini'); // gemini latest activity

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续', 't_z16_redeliver');
    // GREEN after R8: cutoff 只应用在 user msg → 老 ts 的 system msg 走 isUserMessage
    //   continue → 接着扫到 user @codex (recent) → 返回 ['codex']
    // RED before R8: 反序扫先遇 system 老 ts → cutoff trip → return null → fallback gemini
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      '1h cutoff must only apply to user messages — non-user old-ts msgs (Redis markDelivered re-score) must not trip return null',
    );
  });

  test('AC-Z16 R6: scheduler notices (userId="scheduler") must NOT count as user messages (cloud Codex round-2 P1)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    const baseTs = Date.now() - 30000;

    // 真正的 user msg @ codex (oldest)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex 这个怎么处理',
      mentions: ['codex'],
      timestamp: baseTs,
      threadId: 't_z16_sched',
    });
    // 5 个 scheduler 通知 — visibility.ts SYSTEM_USER_IDS = {'scheduler', 'system'}
    // R5 只排除了 'system'，scheduler 仍被算进 user count → 真正 user mention 被挤出
    for (let i = 0; i < 5; i += 1) {
      messageStore.append({
        userId: 'scheduler',
        catId: null,
        content: `[Scheduler] 任务触发 #${i}`,
        mentions: [],
        timestamp: baseTs + (i + 1) * 100,
        threadId: 't_z16_sched',
      });
    }

    const threadStore = createMockThreadStore({ t_z16_sched: ['codex', 'opus', 'gemini'] });
    threadStore.updateParticipantActivity('t_z16_sched', 'codex');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_sched', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16_sched', 'gemini');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('继续', 't_z16_sched');
    // GREEN after R6: scheduler notices excluded (SYSTEM_USER_IDS predicate) → reaches user @ codex
    // RED before R6: scheduler 5 条 consume count → fallback null → gemini wins (wrong)
    assert.deepEqual(
      result.targetCats,
      ['codex'],
      'scheduler notices must not count as user messages — use SYSTEM_USER_IDS predicate not just userId === system',
    );
  });

  test('AC-Z16: when no recent user mentions exist, falls back to participantsWithActivity (legacy behavior)', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    const messageStore = createMockMessageStore();
    // No user messages with mentions in store (empty thread / first user message)

    const threadStore = createMockThreadStore({ t_z16c: ['opus', 'codex'] });
    threadStore.updateParticipantActivity('t_z16c', 'opus');
    await new Promise((r) => setTimeout(r, 5));
    threadStore.updateParticipantActivity('t_z16c', 'codex'); // codex most recent

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createMockAgentService('opus'),
        codexService: createMockAgentService('codex'),
        geminiService: createMockAgentService('gemini'),
        registry: createMockRegistry(),
        messageStore,
        threadStore,
      }),
    );

    const result = await router.resolveTargetsAndIntent('first message', 't_z16c');
    // No prev user mentions → falls back to legacy participantsWithActivity → codex (most recent)
    assert.deepEqual(result.targetCats, ['codex'], 'no prev user mentions → falls back to legacy');
  });
});
