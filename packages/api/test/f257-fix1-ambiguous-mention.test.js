/**
 * F257 修复清单 #1 — 路由解析：@ 多命中 → 拒绝路由并提示显式 handle，不猜。
 *
 * 证据坐标：dev-628ea4d1。防御纵深第二道：加载层 fail-closed（见
 * f257-fix1-config-uniqueness.test.js）拦住正常路径；本层保证当冲突数据从
 * 非常规路径进入 registry（手改 catalog / 外部注入）时，路由不做 longest-first
 * 静默择一，而是产出 mention_ambiguous 警告要求显式 handle。
 *
 * registry 冲突构造：catRegistry.register 直接注入（绕过 config 加载校验），
 * 模拟"两只猫都持有 @共名"的穿透场景。
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';

const { analyzeA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

/** Minimal mocks（模式对齐 f32b-mention-parsing.test.js） */
function createMockService(catId) {
  return {
    catId: createCatId(catId),
    invoke: async function* (prompt) {
      yield { type: 'text', catId: createCatId(catId), content: `[${catId}] ${prompt}`, timestamp: Date.now() };
      yield { type: 'done', catId: createCatId(catId), timestamp: Date.now() };
    },
  };
}

function createUserRouter() {
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('amb-cat-a', createMockService('amb-cat-a'));
  agentRegistry.register('amb-cat-b', createMockService('amb-cat-b'));
  return new AgentRouter({
    agentRegistry,
    registry: {
      create: () => ({ invocationId: 'inv-1', callbackToken: 'tok-1' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    messageStore: {
      append: (msg) => ({ ...msg, id: 'msg-000001', threadId: msg.threadId ?? 'default' }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
      deleteByThread: () => 0,
    },
    threadStore: {
      get: () => null,
      getParticipants: () => [],
      addParticipants: () => {},
      getParticipantsWithActivity: () => [],
      updateParticipantActivity: () => {},
      updateLastActive: () => {},
    },
  });
}

/** 注入两只共享 @共名 pattern 的测试猫（穿透加载校验的冲突态） */
function registerConflictPair() {
  const mk = (catId, patterns) => ({
    id: createCatId(catId),
    name: `${catId}-name`,
    displayName: `${catId}-display`,
    avatar: `/avatars/${catId}.png`,
    color: { primary: '#000000', secondary: '#ffffff' },
    mentionPatterns: patterns,
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
  });
  if (!catRegistry.has('amb-cat-a')) {
    catRegistry.register('amb-cat-a', mk('amb-cat-a', ['@amb-cat-a', '@共名']));
  }
  if (!catRegistry.has('amb-cat-b')) {
    catRegistry.register('amb-cat-b', mk('amb-cat-b', ['@amb-cat-b', '@共名']));
  }
}

registerConflictPair();

describe('F257 #1 修复：A2A 路由 @ 多命中拒绝', () => {
  it('行首 @共名（两猫共持）→ 不路由 + mention_ambiguous 警告列出候选', () => {
    const analysis = analyzeA2AMentions('@共名 请 review 这段代码', 'opus');
    assert.deepEqual(analysis.mentions, [], 'ambiguous mention must NOT resolve to any cat');
    const ambiguous = analysis.routing_warnings.filter((w) => w.kind === 'mention_ambiguous');
    assert.equal(ambiguous.length, 1);
    const candidateIds = ambiguous[0].candidates.map((c) => String(c.catId)).sort();
    assert.deepEqual(candidateIds, ['amb-cat-a', 'amb-cat-b']);
    // 候选必须携带可用的显式 handle（唯一 pattern），供发送方重试
    for (const candidate of ambiguous[0].candidates) {
      assert.match(candidate.mention, /^@amb-cat-/);
    }
  });

  it('attemptBatch 记录 ambiguous outcome（T-A typed-fact 流不丢真相）', () => {
    const analysis = analyzeA2AMentions('@共名 接球', 'opus');
    const ambiguousAttempts = analysis.attemptBatch.attempts.filter((a) => a.outcome === 'ambiguous');
    assert.equal(ambiguousAttempts.length, 1);
    assert.equal(ambiguousAttempts[0].token, '@共名');
    assert.equal(ambiguousAttempts[0].targetCatId, undefined, 'ambiguous attempt has no single target');
  });

  it('唯一 pattern 照常路由（回归保护）', () => {
    const analysis = analyzeA2AMentions('@amb-cat-a 接球', 'opus');
    assert.deepEqual(analysis.mentions.map(String), ['amb-cat-a']);
    assert.equal(analysis.routing_warnings.length, 0);
  });

  it('同行混合：@共名 @amb-cat-b → 歧义 token 拒绝、显式 token 正常路由', () => {
    const analysis = analyzeA2AMentions('@共名 @amb-cat-b 一起看', 'opus');
    assert.deepEqual(analysis.mentions.map(String), ['amb-cat-b']);
    assert.equal(analysis.routing_warnings.filter((w) => w.kind === 'mention_ambiguous').length, 1);
  });
});

describe('F257 #1 修复：用户消息路由 @ 多命中拒绝', () => {
  it('用户消息 @共名 → targetCats 为空（不 fallback 任何猫）+ mention_ambiguous 警告', async () => {
    const router = createUserRouter();
    // sol F3：ambiguous-only 消息 = 用户明确想叫某只特定猫但系统无法唯一确定。
    // 解析层拒绝后不得按「无 @」语义 fallback 到 recent/default 猫——提示「未路由」
    // 与实际唤起某只猫的副作用相反，事故类仍会发生。端到端断言零 targets。
    const { targetCats, hasMentions, routing_warnings } = await router.resolveTargetsAndIntent(
      '@共名 帮我看看这个问题',
      't-amb',
    );
    assert.equal(hasMentions, false, 'ambiguous mention must NOT count as a resolved mention');
    assert.deepEqual(targetCats, [], 'ambiguous-only message must resolve to ZERO targets — no fallback dispatch');
    const ambiguous = routing_warnings.filter((w) => w.kind === 'mention_ambiguous');
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].candidates.map((c) => String(c.catId)).sort(), ['amb-cat-a', 'amb-cat-b']);
  });

  it('混合：@共名 + @amb-cat-b → 只路由显式唯一 token（歧义 token 拒绝不阻塞其余）', async () => {
    const router = createUserRouter();
    const { targetCats, routing_warnings } = await router.resolveTargetsAndIntent('@共名 @amb-cat-b 一起看', 't-amb');
    assert.deepEqual(targetCats.map(String), ['amb-cat-b']);
    assert.equal(routing_warnings.filter((w) => w.kind === 'mention_ambiguous').length, 1);
  });

  it('无 @ 消息 fallback 行为不受影响（回归保护：仅 ambiguous-only 抑制 fallback）', async () => {
    const router = createUserRouter();
    const { targetCats } = await router.resolveTargetsAndIntent('大家好，看看这个问题', 't-amb');
    assert.ok(targetCats.length > 0, 'plain no-mention message keeps existing fallback routing');
  });

  it('用户消息显式 handle 照常路由（回归保护）', async () => {
    const router = createUserRouter();
    const { targetCats, routing_warnings } = await router.resolveTargetsAndIntent('@amb-cat-b 帮我看看', 't-amb');
    assert.ok(targetCats.map(String).includes('amb-cat-b'));
    assert.equal(routing_warnings.filter((w) => w.kind === 'mention_ambiguous').length, 0);
  });
});

describe('F257 #1 修复：resolveCatTarget 多命中拒绝', () => {
  it('resolveCatTarget(@共名) → mention_ambiguous error 而非静默取第一个', () => {
    const resolved = resolveCatTarget('@共名');
    assert.ok('error' in resolved, 'ambiguous target must be an error');
    assert.equal(resolved.error.kind, 'mention_ambiguous');
    assert.deepEqual(resolved.error.candidates.map((c) => String(c.catId)).sort(), ['amb-cat-a', 'amb-cat-b']);
  });

  it('resolveCatTarget 以 catId 直接命中不受影响（catId 全局唯一）', () => {
    const resolved = resolveCatTarget('amb-cat-a');
    assert.deepEqual(resolved, { ok: 'amb-cat-a' });
  });
});
