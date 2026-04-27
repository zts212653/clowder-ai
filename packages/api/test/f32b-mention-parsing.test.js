/**
 * F32-b: Multi-variant mention parsing tests
 * Tests longest-match-first + token boundary + consumed interval algorithm
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

/** Minimal mock service that yields text + done */
function createMockService(catId) {
  return {
    catId: createCatId(catId),
    invoke: async function* (prompt) {
      yield { type: 'text', catId: createCatId(catId), content: `[${catId}] ${prompt}`, timestamp: Date.now() };
      yield { type: 'done', catId: createCatId(catId), timestamp: Date.now() };
    },
  };
}

function createMockRegistry() {
  let counter = 0;
  return {
    create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
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
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
  };
}

function createMockThreadStore() {
  const participants = new Map();
  const activity = new Map();
  return {
    get: () => null,
    getParticipants: (threadId) => participants.get(threadId) ?? [],
    addParticipants: (threadId, cats) => {
      const existing = participants.get(threadId) ?? [];
      const merged = [...new Set([...existing, ...cats])];
      participants.set(threadId, merged);
      // Track activity
      const now = Date.now();
      for (const catId of cats) {
        const key = `${threadId}:${catId}`;
        const existing = activity.get(key) ?? { lastMessageAt: 0, messageCount: 0 };
        activity.set(key, { lastMessageAt: now, messageCount: existing.messageCount + 1 });
      }
    },
    // F032 P1-2: Return participants with activity
    getParticipantsWithActivity: (threadId) => {
      const cats = participants.get(threadId) ?? [];
      return cats
        .map((catId) => {
          const key = `${threadId}:${catId}`;
          const data = activity.get(key) ?? { lastMessageAt: 0, messageCount: 0 };
          return { catId, lastMessageAt: data.lastMessageAt, messageCount: data.messageCount };
        })
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    },
    updateParticipantActivity: (threadId, catId) => {
      const cats = participants.get(threadId) ?? [];
      if (!cats.includes(catId)) {
        participants.set(threadId, [...cats, catId]);
      }
      const key = `${threadId}:${catId}`;
      const existing = activity.get(key) ?? { lastMessageAt: 0, messageCount: 0 };
      activity.set(key, { lastMessageAt: Date.now(), messageCount: existing.messageCount + 1 });
    },
    updateLastActive: () => {},
  };
}

// Register variant cats for testing
const variantCatConfigs = {
  'opus-45': {
    id: createCatId('opus-45'),
    name: 'opus-45',
    displayName: '布偶猫 4.5',
    avatar: '/avatars/opus.png',
    color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
    mentionPatterns: ['@opus-45', '@布偶猫4.5'],
    provider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
    roleDescription: '主架构师',
    personality: '快速',
    breedId: 'ragdoll',
  },
};

// Track whether we registered (for cleanup)
let _registeredVariants = false;

before(() => {
  for (const [id, config] of Object.entries(variantCatConfigs)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
      _registeredVariants = true;
    }
  }
});

after(() => {
  // catRegistry has no unregister API, but since tests run in isolation this is fine
});

describe('F32-b: parseMentions (longest-match-first)', () => {
  /** Create a router with variant services registered */
  async function createVariantRouter() {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockService('opus'));
    agentRegistry.register('codex', createMockService('codex'));
    agentRegistry.register('gemini', createMockService('gemini'));
    agentRegistry.register('opus-45', createMockService('opus-45'));

    return new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      threadStore: createMockThreadStore(),
    });
  }

  it('@opus-45 routes to opus-45 only, not both opus and opus-45', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('请 @opus-45 帮我写个函数', 'test-thread');
    assert.deepEqual(targetCats.map(String), ['opus-45']);
  });

  it('@opus routes to opus only, not opus-45', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('请 @opus 帮我看看', 'test-thread');
    assert.deepEqual(targetCats.map(String), ['opus']);
  });

  it('@opus and @opus-45 both mentioned → two distinct targets', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('@opus 和 @opus-45 一起来讨论', 'test-thread');
    assert.equal(targetCats.length, 2);
    assert.ok(targetCats.map(String).includes('opus'));
    assert.ok(targetCats.map(String).includes('opus-45'));
  });

  it('@布偶猫4.5 routes to opus-45 (Chinese variant mention)', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('请 @布偶猫4.5 来帮忙', 'test-thread');
    assert.deepEqual(targetCats.map(String), ['opus-45']);
  });

  it('token boundary: @opus-45x does not match (no boundary after)', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('邮件 @opus-45x 不是猫猫', 'test-thread');
    // Should fall through to default (opus) since no valid mention found
    assert.deepEqual(targetCats.map(String), ['opus']);
  });

  it('token boundary: @opus-45, (with comma) matches', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('@opus-45，帮我看看代码', 'test-thread');
    assert.deepEqual(targetCats.map(String), ['opus-45']);
  });

  it('preserves first-occurrence ordering', async () => {
    const router = await createVariantRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('@codex 和 @opus 来看看', 'test-thread');
    assert.deepEqual(targetCats.map(String), ['codex', 'opus']);
  });

  it('earliest position wins when same cat has short+long alias (cloud P1 regression)', async () => {
    const router = await createVariantRouter();
    // @布偶 (short alias, early) → opus, @codex (mid), @布偶猫 (long alias, late) → opus
    // Longest-first processing sees @布偶猫 first (later position), but opus should
    // resolve to the earliest occurrence (@布偶 at position 0), not the longest match.
    const { targetCats } = await router.resolveTargetsAndIntent(
      '@布偶 和 @codex 讨论一下 @布偶猫 的方案',
      'test-thread',
    );
    // opus should come first (earliest mention), codex second
    assert.deepEqual(targetCats.map(String), ['opus', 'codex']);
  });

  it('bracket delimiters count as token boundary (cloud P2 regression)', async () => {
    const router = await createVariantRouter();
    // (@codex) — parenthesis after mention should be a valid boundary
    const r1 = await router.resolveTargetsAndIntent('(@codex)', 'test-thread');
    assert.deepEqual(r1.targetCats.map(String), ['codex']);

    // [@布偶猫] — square bracket
    const r2 = await router.resolveTargetsAndIntent('[@布偶猫]', 'test-thread');
    assert.deepEqual(r2.targetCats.map(String), ['opus']);

    // <@opus> — angle bracket
    const r3 = await router.resolveTargetsAndIntent('<@opus>', 'test-thread');
    assert.deepEqual(r3.targetCats.map(String), ['opus']);
  });

  it('CJK fullwidth brackets count as token boundary (R3 P1 regression)', async () => {
    const router = await createVariantRouter();
    // （@codex） — fullwidth parenthesis
    const r1 = await router.resolveTargetsAndIntent('（@codex）', 'test-thread');
    assert.deepEqual(r1.targetCats.map(String), ['codex']);

    // 【@缅因猫】 — fullwidth square bracket
    const r2 = await router.resolveTargetsAndIntent('【@缅因猫】', 'test-thread');
    assert.deepEqual(r2.targetCats.map(String), ['codex']);

    // 《@opus》 — fullwidth angle bracket
    const r3 = await router.resolveTargetsAndIntent('《@opus》', 'test-thread');
    assert.deepEqual(r3.targetCats.map(String), ['opus']);

    // 「@布偶猫」 — corner bracket (common in Japanese/traditional Chinese)
    const r4 = await router.resolveTargetsAndIntent('「@布偶猫」', 'test-thread');
    assert.deepEqual(r4.targetCats.map(String), ['opus']);
  });
});
