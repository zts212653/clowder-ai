/**
 * SystemPromptBuilder Tests
 * 测试身份注入 prompt 生成
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

describe('SystemPromptBuilder', () => {
  // Dynamic import after build
  async function getBuilder() {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    return buildSystemPrompt;
  }

  test('contains display name for opus', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('布偶猫'));
    assert.ok(prompt.includes('opus'));
  });

  test('contains display name for codex', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('缅因猫'));
    assert.ok(prompt.includes('codex'));
  });

  test('contains display name for gemini', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'gemini',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('暹罗猫'));
    assert.ok(prompt.includes('gemini'));
  });

  test('contains teammate info only for cats in context.teammates', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: ['codex', 'gemini'],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('缅因猫'));
    assert.ok(prompt.includes('暹罗猫'));
    assert.ok(prompt.includes('队友'));
  });

  test('omits dynamic teammate listing when teammates is empty', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    // Dynamic teammate listing absent, but static collaboration guide still present
    assert.ok(!prompt.includes('你的队友'));
    assert.ok(prompt.includes('@队友'));
    // Still mentions 铲屎官
    assert.ok(prompt.includes('铲屎官'));
  });

  test('contains 铲屎官 reference', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('铲屎官'));
  });

  test('contains serial chain context when mode is serial', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 3,
      teammates: ['opus', 'gemini'],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('2/3'));
    assert.ok(prompt.includes('被召唤'));
  });

  test('contains independent mode when mode is independent', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('独立回答'));
  });

  test('contains MCP tools when mcpAvailable is true', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    assert.ok(prompt.includes('cat_cafe_post_message'));
    assert.ok(prompt.includes('cat_cafe_register_pr_tracking'));
    assert.ok(prompt.includes('cat_cafe_get_pending_mentions'));
    assert.ok(prompt.includes('cat_cafe_get_thread_context'));
  });

  test('omits MCP tools when mcpAvailable is false', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!prompt.includes('cat_cafe_post_message'));
  });

  test('contains anti-impersonation rule', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('不冒充'));
  });

  test('is deterministic (identical inputs produce identical output)', async () => {
    const build = await getBuilder();
    const ctx = {
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
    };
    const a = build(ctx);
    const b = build(ctx);
    assert.equal(a, b);
  });

  test('output size is under 3200 chars (raised for F102-D17 MCP tools section)', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
    });
    assert.ok(prompt.length < 3350, `Prompt is ${prompt.length} chars, expected < 3350`);
  });

  test('returns empty string for unknown catId', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'unknown-cat',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.equal(prompt, '');
  });

  test('contains provider label (Anthropic for opus)', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('Anthropic'));
  });

  test('parallel mode produces independent thinking text', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'parallel',
      teammates: ['codex'],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('独立思考'));
    assert.ok(prompt.includes('各自独立'));
    assert.ok(!prompt.includes('被召唤'));
    // Should NOT contain the standalone "独立回答。" from independent mode
    assert.ok(!prompt.includes('当前模式：独立回答。'));
  });

  test('critique promptTag adds critical analysis text', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      promptTags: ['critique'],
    });
    assert.ok(prompt.includes('批判性分析'));
    assert.ok(prompt.includes('挑战假设'));
  });

  test('empty promptTags produces no extra text', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      promptTags: [],
    });
    assert.ok(!prompt.includes('批判性分析'));
  });

  // --- Phase 3.6: honesty rule ---

  test('contains "不确定" honesty rule', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('不确定'), 'Prompt should tell cats to say "I\'m not sure"');
  });

  test('contains "不要编造" anti-fabrication rule', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('实事求是'), 'Prompt should enforce evidence-based honesty');
    assert.ok(prompt.includes('还没查完'), 'Prompt should tell cats to say when investigation is incomplete');
  });

  // --- System prompt split tests (buildStaticIdentity / buildInvocationContext) ---

  test('buildStaticIdentity returns identity for known cat', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('布偶猫'), 'Should contain display name');
    assert.ok(identity.includes('Anthropic'), 'Should contain provider');
    assert.ok(identity.includes('## 协作'), 'Should contain collaboration guide');
    assert.ok(identity.includes('不冒充'), 'Should contain anti-impersonation rule');
    assert.ok(identity.includes('团队用"我们"'), 'Should contain identity contract (folded into L0)');
  });

  test('buildStaticIdentity returns empty for unknown cat', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    assert.equal(buildStaticIdentity('unknown-cat'), '');
  });

  test('buildStaticIdentity includes workflow triggers', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const opusId = buildStaticIdentity('opus');
    assert.ok(opusId.includes('工作流'), 'Opus should have workflow triggers');
    assert.ok(opusId.includes('@缅因猫'), 'Opus workflow should mention review with 缅因猫');

    const codexId = buildStaticIdentity('codex');
    assert.ok(codexId.includes('工作流'), 'Codex should have workflow triggers');
    assert.ok(codexId.includes('@布偶猫'), 'Codex workflow should mention notifying 布偶猫');
    assert.ok(codexId.includes('出口一问'), 'Codex workflow should include exit check (出口一问)');
  });

  test('buildStaticIdentity is deterministic', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    assert.equal(buildStaticIdentity('opus'), buildStaticIdentity('opus'));
  });

  test('buildStaticIdentity disambiguates duplicate display names in runtime multi-variant config', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('opus');
      const mentionLine = identity.split('\n').find((line) => line.startsWith('你可以 @队友: '));
      assert.ok(mentionLine, 'should include teammate @mention line');

      // Use lookahead to only match "@缅因猫" NOT followed by " Spark" (which is a different variant displayName)
      const maineCount = (mentionLine.match(/@缅因猫(?=\s*\/)/g) ?? []).length;
      assert.equal(maineCount, 1, 'default maine mention should appear only once');
      assert.ok(mentionLine.includes('@gpt52'), 'should expose non-default variant handle');
      assert.ok(identity.includes('同族多分身时'), 'should explicitly teach same-breed multi-variant rule');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity duplicate-name hint should not suggest self handle', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('gpt52');
      assert.ok(identity.includes('唯一句柄'), 'should include duplicate-name hint');
      assert.ok(!identity.includes('如 @gpt52'), 'hint example must not point to self handle');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // --- F-Ground-3: Teammate roster tests ---

  test('buildStaticIdentity includes teammate roster with strengths', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('## 队友名册'), 'Should have roster section');
    assert.ok(identity.includes('擅长'), 'Should have strengths column header');
    assert.ok(identity.includes('@缅因猫') || identity.includes('@codex'), 'Should list codex mention');
    assert.ok(identity.includes('@暹罗猫') || identity.includes('@gemini'), 'Should list gemini mention');
  });

  test('buildStaticIdentity roster excludes self', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const opusRoster = buildStaticIdentity('opus');
    // Self (opus) should not appear in the roster table rows
    // The roster rows start after the header, each begins with "|"
    const rosterSection = opusRoster.split('## 队友名册')[1];
    assert.ok(rosterSection, 'Roster section should exist');
    assert.ok(!rosterSection.includes('| 布偶猫/宪宪'), 'Opus default should not list itself');
  });

  test('buildStaticIdentity roster uses teamStrengths from config', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('opus');
      // gpt52 keeps teamStrengths and has no explicit caution override in current config.
      assert.ok(identity.includes('架构思考'), 'Should include gpt52 teamStrengths');
      assert.ok(identity.includes('| 缅因猫/砚砚（GPT-5.4） |') || identity.includes('| 缅因猫/砚砚 |'));
      // gemini has caution about no coding
      assert.ok(identity.includes('禁止写代码'), 'Should include gemini caution');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity roster: Sonnet does not inherit Opus cost caution (R1 null override)', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('codex');
      const rosterSection = identity.split('## 队友名册')[1];
      assert.ok(rosterSection, 'Roster section should exist');
      // Find the Sonnet row
      const sonnetRow = rosterSection.split('\n').find((line) => line.includes('Sonnet'));
      assert.ok(sonnetRow, 'Should have a Sonnet row');
      // Sonnet has caution: null in config → should show "—", NOT "额度消耗大"
      assert.ok(!sonnetRow.includes('额度消耗大'), 'Sonnet should not inherit Opus cost caution');
      assert.ok(sonnetRow.includes('—'), 'Sonnet caution should be "—"');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity roster size with full runtime config is under 4100 (raised for F102-D17 MCP tools section)', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const prompt = buildSystemPrompt({
        catId: 'opus',
        mode: 'serial',
        chainIndex: 1,
        chainTotal: 3,
        teammates: ['codex', 'gemini'],
        mcpAvailable: true,
        promptTags: ['critique'],
      });
      assert.ok(prompt.length < 4250, `Full runtime prompt is ${prompt.length} chars, expected < 4250`);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildInvocationContext returns teammates when present', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: false,
    });
    assert.ok(ctx.includes('你的队友'), 'Should list teammates');
    assert.ok(ctx.includes('缅因猫'), 'Should mention codex by display name');
    assert.ok(ctx.includes('1/2'), 'Should show chain position');
  });

  test('buildInvocationContext omits teammate listing when empty', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('你的队友'), 'Should not list teammates');
    assert.ok(ctx.includes('独立回答'), 'Should indicate independent mode');
  });

  test('buildInvocationContext injects A2A exit check when enabled (non-parallel)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(ctx.includes('A2A 出口检查'), 'Should include A2A exit check hint');
    assert.ok(ctx.includes('句中 @ 无效'), 'Should teach inline @ is invalid for routing');
  });

  test('buildInvocationContext does not inject A2A exit check in parallel mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'parallel',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(!ctx.includes('A2A 出口检查'), 'Parallel mode should not encourage @mention chaining');
  });

  test('buildInvocationContext injects mention routing feedback when provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
      mentionRoutingFeedback: {
        sourceTimestamp: Date.now(),
        items: [{ targetCatId: 'opus', reason: 'no_action' }],
      },
    });
    assert.ok(ctx.includes('[路由提醒]'), 'Should include routing feedback banner');
    assert.ok(ctx.includes('@opus'), 'Should mention the target cat');
  });

  test('buildInvocationContext does not contain static identity or MCP tools', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    // Static identity content should NOT be in invocation context
    assert.ok(!ctx.includes('Anthropic'), 'Should not contain provider');
    assert.ok(!ctx.includes('## 协作'), 'Should not contain collaboration guide');
    // MCP tools moved to static identity (session-level, not per-message)
    assert.ok(!ctx.includes('cat_cafe_post_message'), 'MCP tools should be in static identity, not invocation context');
    // 铲屎官 reference also moved to static identity
    assert.ok(!ctx.includes('铲屎官是真人用户'), '铲屎官 reference should be in static identity');
  });

  test('buildStaticIdentity includes MCP tools when mcpAvailable', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus', { mcpAvailable: true });
    assert.ok(identity.includes('cat_cafe_post_message'), 'Should contain MCP tools when mcpAvailable');
    assert.ok(identity.includes('cat_cafe_get_thread_context'), 'Should contain thread context tool');
  });

  test('buildStaticIdentity omits MCP tools when mcpAvailable is false', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(!identity.includes('cat_cafe_post_message'), 'Should not contain MCP tools without mcpAvailable');
  });

  test('buildStaticIdentity does NOT include mcpCallbackInstructions (non-Claude stays per-message)', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    // Non-Claude cats use per-message injection for HTTP callback instructions
    // because their systemPrompt lives in session history and may be lost on compression.
    // Only Claude's MCP_TOOLS_SECTION goes in staticIdentity (survives compression via --append-system-prompt).
    const identity = buildStaticIdentity('codex');
    assert.ok(!identity.includes('cat_cafe_post_message'), 'Codex should not have MCP tools in static identity');
    assert.ok(!identity.includes('HTTP 回调'), 'Codex should not have callback instructions in static identity');
  });

  test('buildStaticIdentity includes 铲屎官 reference', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('铲屎官'), 'Should contain 铲屎官 reference in static identity');
  });

  test('buildStaticIdentity includes configured co-creator name and mention handles', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    // Owner config has name: "You", mentionPatterns: ["@co-creator", "@co-creator", "@co-creator"]
    assert.ok(identity.includes('You'), 'Should include co-creator name from config');
    assert.ok(identity.includes('@co-creator'), 'Should include @co-creator mention handle');
    assert.ok(identity.includes('@co-creator'), 'Should include @co-creator mention handle');
    assert.ok(identity.includes('行首'), 'Should teach line-start rule for owner mentions');
  });

  // F032 Phase D2: Reviewer section tests
  test('buildReviewerSection returns reviewer list for opus (different family reviewers)', async () => {
    const { buildReviewerSection } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const section = buildReviewerSection('opus');
    assert.ok(section, 'Should return section for opus');
    assert.ok(section.includes('## 你当前的 Reviewers'), 'Should have reviewer header');
    assert.ok(section.includes('@codex'), 'Should list codex as reviewer (different family)');
    // Should NOT list same-family cats (opus-45 is ragdoll, same as opus)
    assert.ok(!section.includes('@opus-45'), 'Should not list same-family opus-45');
  });

  test('buildReviewerSection returns null for unknown cat', async () => {
    const { buildReviewerSection } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const section = buildReviewerSection('unknown-cat');
    assert.equal(section, null, 'Should return null for unknown cat');
  });

  // Cloud Codex R5 P2: Verify same-family fallback behavior is documented
  // When requireDifferentFamily is enabled but no cross-family reviewers are available,
  // same-family reviewers should be shown with a fallback note.
  // This test verifies the cross-family-available case works correctly;
  // the fallback case requires mocking roster/availability (out of scope for unit test).
  test('buildReviewerSection shows cross-family when available (R5 P2 prerequisite)', async () => {
    const { buildReviewerSection } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const section = buildReviewerSection('opus');
    assert.ok(section, 'Should return section');
    // Cross-family available, so should NOT show fallback note
    assert.ok(!section.includes('fallback'), 'Should not show fallback note when cross-family available');
    assert.ok(section.includes('@codex'), 'Should show cross-family reviewer');
  });

  test('buildSystemPrompt includes reviewer section', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    assert.ok(prompt.includes('## 你当前的 Reviewers'), 'System prompt should include reviewer section');
  });

  // --- F042 Wave 3: Active participant hint tests ---

  test('buildInvocationContext injects most-recently-active participant', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 2,
      teammates: ['opus'],
      mcpAvailable: false,
      activeParticipants: [
        { catId: 'opus', lastMessageAt: 2000, messageCount: 5 },
        { catId: 'codex', lastMessageAt: 1000, messageCount: 3 },
      ],
    });
    assert.match(ctx, /最近活跃：布偶猫\(opus\)\n|最近活跃：布偶猫\(opus\)$/, 'Should inject displayName(id) format');
    assert.ok(!ctx.includes('最近活跃：缅因猫(codex)'), 'Self (codex) should not appear as most recently active');
  });

  test('buildInvocationContext skips self in activity list', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: false,
      activeParticipants: [
        { catId: 'opus', lastMessageAt: 3000, messageCount: 8 },
        { catId: 'codex', lastMessageAt: 2000, messageCount: 4 },
      ],
    });
    // opus is self and most-recent, should be skipped; codex is next
    assert.match(ctx, /最近活跃：缅因猫\(codex\)\n|最近活跃：缅因猫\(codex\)$/, 'Should inject displayName(id) format');
  });

  test('buildInvocationContext omits hint when activeParticipants absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('最近活跃'), 'Should not inject when no activeParticipants');
  });

  test('buildInvocationContext omits hint when only self has activity', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: false,
      activeParticipants: [
        { catId: 'opus', lastMessageAt: 1000, messageCount: 1 },
        { catId: 'codex', lastMessageAt: 0, messageCount: 0 },
      ],
    });
    assert.ok(!ctx.includes('最近活跃'), 'Should not inject when no non-self participant has activity');
  });

  test('buildSystemPrompt size with activeParticipants stays under 3250 chars (raised for F102-D17 MCP tools section)', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
      activeParticipants: [
        { catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 },
        { catId: 'opus', lastMessageAt: Date.now() - 1000, messageCount: 3 },
      ],
    });
    assert.ok(prompt.length < 3400, `Prompt with activity is ${prompt.length} chars, expected < 3400`);
  });

  // --- F042: pinned identity constant + direct-message reply target ---

  test('buildInvocationContext includes pinned Identity line with handle + model', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.match(ctx, /^Identity:/m);
    assert.ok(ctx.includes('@codex'));
    assert.ok(ctx.includes('model='), 'Identity line should include model=');
  });

  test('buildInvocationContext Identity line uses resolved runtime model override', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const prev = process.env.CAT_CODEX_MODEL;
    process.env.CAT_CODEX_MODEL = 'gpt-5.9-codex-test';
    try {
      const ctx = buildInvocationContext({
        catId: 'codex',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
      });
      assert.ok(
        ctx.includes('model=gpt-5.9-codex-test'),
        'Identity line should use runtime-resolved model from env override',
      );
    } finally {
      if (prev === undefined) {
        delete process.env.CAT_CODEX_MODEL;
      } else {
        process.env.CAT_CODEX_MODEL = prev;
      }
    }
  });

  test('buildInvocationContext includes Direct message reply target when provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });
    assert.match(ctx, /^Direct message from 布偶猫\(opus\)/m);
    assert.ok(ctx.includes('reply to 布偶猫(opus)'));
    assert.ok(!ctx.includes('Direct message from @opus'));
  });

  test('buildInvocationContext supports runtime variant cat IDs (gpt52)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'gpt52',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'codex',
      });
      assert.match(ctx, /^Identity:/m);
      assert.ok(ctx.includes('@gpt52'));
      assert.match(ctx, /^Direct message from 缅因猫\(codex\)/m);
      assert.ok(ctx.includes('reply to 缅因猫(codex)'));
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // --- F042: Thread routingPolicy hint tests ---

  test('buildInvocationContext injects routing policy summary line when present', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      routingPolicy: {
        v: 1,
        scopes: {
          review: { avoidCats: ['opus'], reason: 'budget' },
          architecture: { preferCats: ['opus'] },
        },
      },
    });
    assert.match(ctx, /Routing:.*review.*avoid.*@opus(?!-)/, 'Should include review avoid @opus');
    assert.match(ctx, /Routing:.*architecture.*prefer.*@opus(?!-)/, 'Should include architecture prefer @opus');
  });

  test('buildInvocationContext sanitizes routing reason and tolerates malformed lists', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      routingPolicy: {
        v: 1,
        scopes: {
          review: {
            avoidCats: 'opus',
            preferCats: { bad: true },
            reason: 'budget\ninject',
          },
        },
      },
    });
    assert.ok(ctx.includes('Routing: review'), 'Should still render routing line');
    assert.ok(ctx.includes('(budget inject)'), 'Should sanitize newline in reason');
    assert.ok(!ctx.includes('budget\ninject'), 'Should not allow multiline reason injection');
  });

  // --- F073 P4: SOP stage hint injection ---

  test('buildInvocationContext injects SOP stage hint when sopStageHint provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      sopStageHint: {
        stage: 'impl',
        suggestedSkill: 'tdd',
        featureId: 'F073',
      },
    });
    assert.ok(ctx.includes('SOP'), 'Should contain SOP label');
    assert.ok(ctx.includes('impl'), 'Should contain current stage');
    assert.ok(ctx.includes('tdd'), 'Should contain suggested skill');
    assert.ok(ctx.includes('F073'), 'Should contain feature ID');
  });

  test('buildInvocationContext omits SOP hint when sopStageHint absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('SOP:'), 'Should not contain SOP line when no hint');
  });

  test('buildInvocationContext SOP hint omits suggestedSkill when null', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      sopStageHint: {
        stage: 'review',
        suggestedSkill: null,
        featureId: 'F080',
      },
    });
    assert.ok(ctx.includes('SOP'), 'Should contain SOP label');
    assert.ok(ctx.includes('review'), 'Should contain stage');
    assert.ok(ctx.includes('F080'), 'Should contain feature ID');
    assert.ok(!ctx.includes('skill'), 'Should not contain skill reference when null');
  });

  test('buildSystemPrompt size stays under 3300 chars with SOP hint (raised for F102-D17 MCP tools section)', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
      activeParticipants: [{ catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 }],
      sopStageHint: {
        stage: 'quality_gate',
        suggestedSkill: 'quality-gate',
        featureId: 'F073',
      },
    });
    assert.ok(prompt.length < 3450, `Prompt with SOP hint is ${prompt.length} chars, expected < 3450`);
  });

  // --- F092: Voice Mode prompt injection ---

  test('buildInvocationContext includes voice mode instructions when voiceMode=true', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      voiceMode: true,
    });
    assert.ok(ctx.includes('Voice Mode ON'), 'Should include voice mode header');
    assert.ok(ctx.includes('audio rich block'), 'Should mention audio rich block');
  });

  test('buildInvocationContext omits voice mode instructions when voiceMode absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('Voice Mode ON'), 'Should not include voice mode header');
  });

  test('buildSystemPrompt size stays under 3450 chars with voice mode + SOP hint (raised for F102-D17 MCP tools section)', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
      activeParticipants: [{ catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 }],
      sopStageHint: {
        stage: 'quality_gate',
        suggestedSkill: 'quality-gate',
        featureId: 'F073',
      },
      voiceMode: true,
    });
    assert.ok(prompt.length < 3600, `Prompt with voice mode + SOP hint is ${prompt.length} chars, expected < 3600`);
  });

  test('buildInvocationContext injects bootcamp mode when bootcampState provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      bootcampState: {
        v: 1,
        phase: 'phase-2-env-check',
        leadCat: 'opus',
        startedAt: Date.now(),
      },
    });
    assert.ok(ctx.includes('Bootcamp Mode'), 'Should include bootcamp header');
    assert.ok(ctx.includes('phase-2-env-check'), 'Should include current phase');
    assert.ok(ctx.includes('leadCat=opus'), 'Should include lead cat');
    assert.ok(ctx.includes('bootcamp-guide'), 'Should reference skill');
  });

  test('buildInvocationContext injects threadId in bootcamp mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread_abc123',
      bootcampState: {
        v: 1,
        phase: 'phase-0-select-cat',
        startedAt: Date.now(),
      },
    });
    assert.ok(ctx.includes('thread=thread_abc123'), 'Should include threadId in bootcamp line');
  });

  test('buildInvocationContext omits bootcamp when bootcampState absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('Bootcamp Mode'), 'Should not include bootcamp header');
  });

  // --- 回归测试：maine-coon prompt 必须包含 A2A 执行纪律 ---

  test('maine-coon prompt contains execution discipline keywords', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('静默执行'), 'maine-coon prompt must include 静默执行');
    assert.ok(prompt.includes('声明'), 'maine-coon prompt must include 声明 ≠ 执行');
    assert.ok(prompt.includes('空气传球'), 'maine-coon prompt must include 空气传球 warning');
    assert.ok(prompt.includes('出口一问'), 'maine-coon prompt must include 出口一问');
  });

  test('maine-coon workflow contains A2A state transition keywords', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const codexId = buildStaticIdentity('codex');
    assert.ok(codexId.includes('BLOCKED'), 'codex prompt must include BLOCKED state');
    assert.ok(codexId.includes('REVIEW READY'), 'codex prompt must include REVIEW READY state');
    assert.ok(codexId.includes('DONE'), 'codex prompt must include DONE state');
  });

  // ─── F129 Pack Block Injection ──────────────────────────────────────

  test('F129: buildStaticIdentity injects all pack blocks', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      mcpAvailable: false,
      packBlocks: {
        packName: 'test-pack',
        guardrailBlock: '## [Pack: test-pack] 硬约束\n- Never trade without risk disclosure',
        defaultsBlock: '## [Pack: test-pack] 默认行为\n- Use formal financial terminology',
        masksBlock: '## [Pack: test-pack] 角色叠加\n- Role: Quantitative Analyst',
        workflowsBlock: '## [Pack: test-pack] 工作流\n- Trigger: /research',
        worldDriverSummary: '## [Pack: test-pack] 世界引擎（只读摘要）\nResolver: hybrid',
      },
    });

    assert.ok(prompt.includes('硬约束'), 'Should inject guardrail block');
    assert.ok(prompt.includes('默认行为'), 'Should inject defaults block');
    assert.ok(prompt.includes('角色叠加'), 'Should inject masks block');
    assert.ok(prompt.includes('工作流'), 'Should inject workflows block');
    assert.ok(prompt.includes('世界引擎'), 'Should inject world driver summary');
  });

  test('F129: pack masks appear after identity, before governance', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      packBlocks: {
        packName: 'test-pack',
        masksBlock: '## PACK_MASK_MARKER',
        guardrailBlock: '## PACK_GUARD_MARKER',
        defaultsBlock: null,
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    const maskPos = prompt.indexOf('PACK_MASK_MARKER');
    const guardPos = prompt.indexOf('PACK_GUARD_MARKER');
    const identityPos = prompt.indexOf('布偶猫');

    assert.ok(maskPos > identityPos, 'Masks should appear after identity');
    assert.ok(guardPos > maskPos, 'Guardrails should appear after masks');
  });

  test('F129: pack guardrails appear after core governance', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      packBlocks: {
        packName: 'test-pack',
        guardrailBlock: '## PACK_GUARD_MARKER',
        defaultsBlock: '## PACK_DEFAULT_MARKER',
        masksBlock: null,
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    const guardPos = prompt.indexOf('PACK_GUARD_MARKER');
    const defaultPos = prompt.indexOf('PACK_DEFAULT_MARKER');
    // Core governance (L0 家规) must come before pack guardrails
    const coreGovPos = prompt.indexOf('家规');

    assert.ok(coreGovPos > -1, 'Core governance (家规) should exist in prompt');
    assert.ok(guardPos > coreGovPos, 'Pack guardrails must come AFTER core governance (KD-9)');
    assert.ok(defaultPos > guardPos, 'Pack defaults must come after pack guardrails');
  });

  test('F129: buildSystemPrompt passes packBlocks through', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      packBlocks: {
        packName: 'quant-cats',
        guardrailBlock: '## [Pack: quant-cats] 硬约束\n- Risk disclosure required',
        defaultsBlock: '## [Pack: quant-cats] 默认行为\n- Financial terminology',
        masksBlock: '## [Pack: quant-cats] 角色叠加\n- Quantitative Analyst',
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    assert.ok(prompt.includes('硬约束'), 'buildSystemPrompt should include guardrail block');
    assert.ok(prompt.includes('角色叠加'), 'buildSystemPrompt should include masks block');
    assert.ok(prompt.includes('默认行为'), 'buildSystemPrompt should include defaults block');
  });

  test('F129: null/undefined packBlocks produce no pack sections', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const withNull = buildStaticIdentity('opus', { packBlocks: null });
    const withUndef = buildStaticIdentity('opus', {});

    assert.ok(!withNull.includes('角色叠加'), 'null packBlocks should not inject masks');
    assert.ok(!withNull.includes('硬约束'), 'null packBlocks should not inject guardrails');
    assert.ok(!withUndef.includes('角色叠加'), 'undefined packBlocks should not inject masks');
    assert.ok(!withUndef.includes('硬约束'), 'undefined packBlocks should not inject guardrails');
  });

  test('F129: partial packBlocks only inject present fields', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      packBlocks: {
        packName: 'partial-pack',
        guardrailBlock: '## ONLY_GUARDRAILS_HERE',
        defaultsBlock: null,
        masksBlock: null,
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    assert.ok(prompt.includes('ONLY_GUARDRAILS_HERE'), 'Should inject the one present block');
    assert.ok(!prompt.includes('角色叠加'), 'Should not inject null masks');
    assert.ok(!prompt.includes('默认行为'), 'Should not inject null defaults');
  });
});
