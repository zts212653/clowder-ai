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
    verify: () => null,
  };
}

function createMockMessageStore() {
  const rows = [];
  let seq = 0;

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
      sorted()
        .filter((m) => m.threadId === threadId)
        .slice(-limit),
    getByThreadAfter: (threadId, afterId, limit) => {
      const inThread = sorted().filter((m) => m.threadId === threadId);
      const filtered = afterId ? inThread.filter((m) => m.id > afterId) : inThread;
      return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
    },
    getByThreadBefore: (threadId, timestamp, limit = 50, beforeId) =>
      sorted()
        .filter((m) => m.threadId === threadId)
        .filter((m) => m.timestamp < timestamp || (m.timestamp === timestamp && (!beforeId || m.id < beforeId)))
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
        provider,
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

  test('@three cats then no-@ routes to last replier only (F078)', async () => {
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

    // Second: no @ — F078: routes to last replier only (not all three)
    // The last participant added was gemini (serial order: opus → codex → gemini)
    for await (const _ of router.route('user-1', 'what about this?', 'thread_x')) {
    }

    // Only one cat should be called again (the most recent replier)
    const totalSecondRound =
      mockClaudeService.invoke.mock.callCount() +
      mockCodexService.invoke.mock.callCount() +
      mockGeminiService.invoke.mock.callCount();
    assert.equal(totalSecondRound, 4, 'F078: 3 from first round + 1 from second (last replier only)');
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

  test('identity injection: opus prompt contains 布偶猫', async () => {
    const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

    let opusReceivedPrompt = '';
    let _opusReceivedOptions;
    const mockClaudeService = {
      invoke: mock.fn(async function* (prompt, options) {
        opusReceivedPrompt = prompt;
        _opusReceivedOptions = options;
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

    // Static identity (布偶猫, Anthropic) prepended to prompt by invoke-single-cat (new session)
    assert.ok(opusReceivedPrompt.includes('布偶猫'), 'Opus prompt should contain 布偶猫');
    assert.ok(opusReceivedPrompt.includes('Anthropic'), 'Opus prompt should mention Anthropic');
    assert.ok(opusReceivedPrompt.includes('hello'), 'Opus prompt should contain original message');
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

  test('last replier NOT in preferred set → routes to first preferred cat only', async () => {
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
      ['opus'],
      'should route to first preferred cat when last replier is outside preferred set',
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
});
