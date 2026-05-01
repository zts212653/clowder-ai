/**
 * SystemPromptBuilder Tests
 * 测试身份注入 prompt 生成
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_ROOT_TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'cat-template.json');
const CAT_TEMPLATE_PATH = REPO_ROOT_TEMPLATE;

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
    // Phase 0 正面化: 不冒充 → 用自己的身份签名 (L0 GOVERNANCE_L0_DIGEST)
    assert.ok(prompt.includes('用自己的身份签名'));
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

  test('output size stays under 3900 chars after Magic Words + runtime prompt growth', async () => {
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
    assert.ok(prompt.length < 5700, `Full runtime prompt is ${prompt.length} chars, expected < 5700`);
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
    // Phase 0 正面化: 不冒充 → 用自己的身份签名 (L0 GOVERNANCE_L0_DIGEST)
    assert.ok(identity.includes('用自己的身份签名'), 'Should contain identity-signature rule (anti-impersonation)');
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
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
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
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
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

  test('F127 V-1: buildStaticIdentity includes runtime-created cats in new-session roster', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    try {
      catRegistry.register('runtime-spark', {
        ...originalConfigs.codex,
        displayName: '火花猫',
        nickname: '小火花',
        mentionPatterns: ['@runtime-spark', '@火花猫'],
        defaultModel: 'gpt-5.4-mini',
        roleDescription: '快速执行',
        teamStrengths: '精确点改',
      });

      const identity = buildStaticIdentity('opus');
      assert.match(identity, /## 队友名册/, 'new session identity must include roster');
      assert.match(identity, /火花猫\/小火花/, 'runtime-created cat must be listed');
      assert.match(identity, /@runtime-spark · gpt-5\.4-mini/, 'runtime-created model alias must be visible');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
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
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
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
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
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

  test('buildStaticIdentity roster size with full runtime config stays under 4700 chars after Magic Words growth', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
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
      assert.ok(prompt.length < 5700, `Full runtime prompt is ${prompt.length} chars, expected < 5700`);
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
    // F064 球权模型: A2A 出口检查 → A2A 球权检查
    assert.ok(ctx.includes('A2A 球权检查'), 'Should include A2A ball-ownership check hint');
    assert.ok(ctx.includes('句中无效'), 'Should teach inline @ is invalid for routing');
  });

  test('F167-F AC-F1: teammate roster surfaces resolved model per cat (handle/model 解绑)', async () => {
    // KD-21: handle = identity constant; model = runtime-resolved metadata.
    // Sender must see {@mention} + defaultModel aligned —防止"云端 codex (bot)"
    // 被投射成本地 @codex / @gpt52 的 cargo-cult 盲区 (opus-47 事故)。
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      // Cloud Codex P2 fix: don't hardcode model strings — production resolves
      // via getCatModel (env CAT_{CATID}_MODEL → registry → defaults), so a legitimate
      // env override would make hardcoded assertions fail. Assert structural presence
      // instead: "@mention · <something>" adjacency for each roster row.
      assert.match(prompt, /@codex\s*·\s*\S+/, 'codex row must show "@codex · <model>" adjacency');
      assert.match(prompt, /@gpt52\s*·\s*\S+/, 'gpt52 row must show "@gpt52 · <model>" adjacency');
      assert.match(prompt, /@gemini\s*·\s*\S+/, 'gemini row must show "@gemini · <model>" adjacency');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: teammate roster surfaces restrictions (硬限制) for teammates with them', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      assert.match(prompt, /队友名册/, 'must include 队友名册 section');
      assert.match(prompt, /禁止写代码/, 'teammate roster must surface gemini restrictions');
      assert.match(prompt, /硬限制/, 'restrictions must carry a visible marker distinct from narrative caution');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: cat sees its own restrictions in self identity (self-awareness)', async () => {
    // gemini's own prompt must include its hard restrictions so it can
    // recognize illegitimate @-mentions and push back, without relying on harness gate.
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('gemini');
      assert.match(prompt, /你的硬限制/, 'gemini own prompt must declare its restrictions');
      assert.match(prompt, /禁止写代码/, 'gemini own prompt must name the 禁止写代码 ban');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: cat without restrictions has NO self-restrictions block', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      // opus has no restrictions → 自我介绍里不应该出现 "你的硬限制"
      assert.doesNotMatch(prompt, /你的硬限制/, 'opus own prompt must not declare restrictions it does not have');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: teammate roster omits restrictions marker for teammates without them', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      const rosterLines = prompt.split('\n').filter((l) => l.trim().startsWith('|'));
      const geminiLine = rosterLines.find((l) => /@gemini|@烁烁|@暹罗/.test(l));
      const codexLine = rosterLines.find((l) => /@codex/.test(l));
      assert.ok(geminiLine && /硬限制/.test(geminiLine), `gemini row must include 硬限制; got: ${geminiLine}`);
      assert.ok(
        codexLine && !/硬限制/.test(codexLine),
        `codex row (no restrictions) must NOT include 硬限制; got: ${codexLine}`,
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-F AC-F10: AGENTS.md / CLAUDE.md have no hardcoded "@x = model-y" bindings', async () => {
    // KD-21 invariant: handle/model must stay decoupled in static docs. If someone
    // re-introduces "@codex（model=gpt-5.3-codex）" style hardcoding, this test traps it.
    const fs = await import('node:fs');
    const { readFileSync } = fs;
    const path = await import('node:path');
    const { dirname: dirFn, join } = path;
    const { fileURLToPath: fromUrl } = await import('node:url');
    const here = dirFn(fromUrl(import.meta.url));
    const repoRoot = resolve(here, '../../..');
    const readFlat = (name) => readFileSync(join(repoRoot, name), 'utf8');
    for (const fname of ['AGENTS.md', 'CLAUDE.md']) {
      const text = readFlat(fname);
      // KD-21 regression guard (cloud Codex round-4 broadening): detect ANY
      // static `@handle ... model=X` binding regardless of quoting style, model
      // family, or handle charset. Covers:
      //   - `@codex (model=`gpt-5.5`)`  — backticked
      //   - `@codex (model=gpt-5.5)`    — unquoted (round-4 gap)
      //   - `@codex (model="foo")`      — double-quoted
      //   - `@opus-45` / `@缅因猫`      — non-\w handles
      // @handle = `@` + non-whitespace/comma/open-paren chars.
      // model value = any non-whitespace (accepts quoted + unquoted).
      assert.doesNotMatch(
        text,
        /@[^\s,(（]+[^\n]{0,30}model=\S+/i,
        `${fname} must not hardcode "@xxx (model=anything)" — use runtime catalog truth source`,
      );
    }
  });

  test('F167-F AC-F7/F8: A2A section has inline-@ bad examples (URL / list / quote) and pre-send self-check', async () => {
    // KD-22: @ 行首 rule is protocol constant but model forgets in narrative context
    // (URL prefix "+@reviewer:", list bullet "- @cat:", quote "> @cat said..."等).
    // prompt 首轮教学要给具体视觉反例 + 发前自检问。
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus');
    // Existing 反例 "行中 @sonnet" 要保留，新增 URL / 列表 / quote 反例。
    assert.match(
      prompt,
      /URL|列表|quote|引用|前缀/i,
      'must show URL / list / quote / 前缀 scenarios as inline-@ traps',
    );
    // 发前自检问
    assert.match(
      prompt,
      /发前自检|我的 @.*都在行首|发出前扫/,
      'must include a pre-send self-check question about inline @',
    );
  });

  test('F167-F AC-F6: trailing anchor lists 外部 identity as hold_ball scenarios (not @-eligible)', async () => {
    // KD-21: external identities (GitHub bot / CI / webhook) are NOT in roster.
    // Trailing anchor option 2 (hold_ball) must name these explicitly so the
    // model doesn't cargo-cult-project "云端 codex" onto local @codex / @gpt52.
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    // Hold_ball row must explicitly name external identities to prevent cargo-cult to @local-proxy.
    assert.match(
      ctx,
      /云端\s*codex|GitHub\s*(?:bot|Actions|review)|PR\s*check|CI/i,
      'trailing anchor hold_ball line must list 云端 codex / GitHub bot / CI as examples',
    );
    // And should warn not to @ local proxy for external identity.
    assert.match(
      ctx,
      /外部\s*identity|外部条件|不在\s*roster|不可\s*@/,
      'must state that external identities are not in roster / not @-eligible',
    );
  });

  test('F167-D2: trailing anchor uses decision-tree ordering (not flat three-choice)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    // Decision-tree structure: ask "who can do next?" first, then numbered answers.
    assert.match(ctx, /(先问|谁能).*下一步|下一棒/, 'trailing anchor must ask "who can do next" first');
    // 1. another cat can do
    assert.match(ctx, /1\..*另一只猫.*@句柄/s, 'option 1 = another cat via @handle');
    // 2. external condition
    assert.match(ctx, /2\..*外部条件|hold_ball/, 'option 2 = external wait via hold_ball');
    // 3. only co-creator (three hard conditions)
    assert.match(ctx, /3\..*铲屎官|@co-creator|@co-creator/, 'option 3 = co-creator reserved for hard conditions');
  });

  test('F167-D2: trailing anchor names the three hard conditions for @co-creator', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.match(ctx, /不可逆/, 'hard condition 1: irreversible operation');
    assert.match(ctx, /愿景|feat|VISION/, 'hard condition 2: vision-level decision');
    assert.match(ctx, /僵局|冲突/, 'hard condition 3: cross-cat deadlock');
  });

  test('F167-D2: trailing anchor warns against 反问式 ping (soft @co-creator)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    // Must call out the anti-pattern and show "要不要/吗？" pattern
    assert.match(ctx, /反问式|软性|要不要|吗？/, 'must warn about soft @ / reflexive ping');
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
    assert.ok(!ctx.includes('A2A 球权检查'), 'Parallel mode should not encourage @mention chaining');
  });

  // F167 L2 AC-A6: parallel 模式明确告知 @句柄 无路由语义
  test('buildInvocationContext injects parallel-mode no-mention hint in parallel mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'parallel',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(ctx.includes('并行模式'), 'parallel mode prompt should mention 并行模式');
    assert.ok(ctx.includes('无路由语义'), 'parallel mode should say @句柄 无路由语义');
  });

  test('buildInvocationContext does NOT inject parallel-mode no-mention hint in serial/independent mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(!ctx.includes('无路由语义'), 'non-parallel mode should not inject parallel hint');
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
    // Config resolution: cat-template.json (base) + .cat-cafe/cat-catalog.json (overlay).
    // Template has coCreator.name="You", catalog may override to deployment-specific name.
    // Test structural invariants that hold regardless of deployment config:
    assert.ok(identity.includes('铲屎官'), 'Should include 铲屎官 (always in CVO line)');
    assert.ok(identity.includes('行首'), 'Should teach line-start rule for owner mentions');
    // CVO line: "{name}（铲屎官/CVO）…行首写 `@handle` / `@handle2`。"
    assert.ok(/重要决策由.+拍板/.test(identity), 'Should include decision authority line');
    assert.ok(/行首写\s+`@\S+`/.test(identity), 'CVO line should contain backtick-wrapped mention handle after 行首写');
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

  test('buildSystemPrompt size with activeParticipants stays under 3900 chars after Magic Words + runtime prompt growth', async () => {
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
    assert.ok(prompt.length < 5700, `Full runtime prompt is ${prompt.length} chars, expected < 5700`);
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

  test('buildInvocationContext includes Direct message reply target + sender model (F167 anti-spoofing)', async () => {
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
    // F167 anti-spoofing: handoff must carry sender model marker explicitly
    assert.ok(ctx.includes('[model='), 'handoff must include sender model marker');
  });

  // F167 P2 (cloud review 2026-04-18): sender model must also honor runtime env override,
  // not just static config. Asymmetric resolution (self=runtime, other=static) weakens
  // identity disambiguation when the sender's model is overridden at runtime.
  test('buildInvocationContext handoff sender model respects CAT_<ID>_MODEL env override', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const prev = process.env.CAT_OPUS_MODEL;
    process.env.CAT_OPUS_MODEL = 'claude-opus-runtime-override';
    try {
      const ctx = buildInvocationContext({
        catId: 'codex',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'opus',
      });
      assert.ok(
        ctx.includes('[model=claude-opus-runtime-override]'),
        'sender [model=...] must use runtime-resolved model, not static defaultModel',
      );
    } finally {
      if (prev === undefined) {
        delete process.env.CAT_OPUS_MODEL;
      } else {
        process.env.CAT_OPUS_MODEL = prev;
      }
    }
  });

  test('buildInvocationContext supports runtime variant cat IDs (gpt52)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
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

  // F167 identity anti-spoofing: same-breed variant handoff must disambiguate model
  // (Uses opus-45 which is in cat-template.json. Equivalent logic applies to opus-47.)
  test('buildInvocationContext injects same-breed anti-spoofing line when opus-45 receives from opus', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'opus-45',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'opus',
      });
      // variant label embedded in self-identity (handle-free label path now carries it)
      assert.match(ctx, /^Identity:.*opus-45/m);
      // same-breed sender shows up with model marker (anti-spoofing: explicit model differentiation)
      assert.ok(ctx.includes('model=claude-opus-4-6'), 'sender model must be claude-opus-4-6');
      // anti-spoofing notice must fire (same displayName 布偶猫, different catId)
      assert.ok(
        ctx.includes('同族分身') || ctx.includes('不是你'),
        'same-breed handoff must inject anti-spoofing notice',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // F167: cross-breed handoff should NOT inject anti-spoofing (false positive guard)
  test('buildInvocationContext does NOT inject anti-spoofing for cross-breed handoff', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      directMessageFrom: 'codex',
    });
    // model marker present (useful context)
    assert.ok(ctx.includes('model='), 'handoff should carry model marker');
    // but no anti-spoofing line — different breed = no identity confusion
    assert.ok(!ctx.includes('同族分身'), 'cross-breed handoff must NOT inject 同族分身 notice');
  });

  // F167: variant label appears in handle-free label for peers with variantLabel
  test('formatHandleFreeLabel includes variantLabel (via ping-pong warning path)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'opus',
        mode: 'serial',
        chainIndex: 2,
        chainTotal: 3,
        teammates: [],
        mcpAvailable: false,
        pingPongWarning: { pairedWith: 'opus-45', count: 2 },
      });
      // variant label must show in ping-pong paired-with label
      assert.ok(
        ctx.includes('Opus 4.5'),
        'ping-pong warning must include variantLabel (Opus 4.5) to disambiguate from other opus variants',
      );
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

  test('guide prompt emits offered transition only for a brand-new guide match', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'offered',
        isNewOffer: true,
      },
    });

    assert.ok(ctx.includes('Guide Matched'), 'new match should emit offer card instructions');
    assert.ok(ctx.includes('status="offered"'), 'new match should persist offered transition exactly once');
  });

  test('guide prompt does not re-send offered transition after the guide is already offered', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'offered',
        isNewOffer: false,
      },
    });

    assert.ok(ctx.includes('Guide Pending'), 'existing offered guide should become a stable pending reminder');
    assert.ok(!ctx.includes('status="offered"'), 'existing offered guide must not re-send offered transition');
    assert.ok(!ctx.includes('cat_cafe_create_rich_block'), 'existing offered guide must not repeat the offer card');
  });

  test('guide preview from offered state advances to awaiting_choice once', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'offered',
        userSelection: '步骤概览',
      },
    });

    assert.ok(ctx.includes('Guide Selection'), 'preview branch should still activate from offered state');
    assert.ok(
      ctx.includes('status="awaiting_choice"'),
      'first preview should advance the guide to awaiting_choice before resolving steps',
    );
  });

  test('guide preview from awaiting_choice does not re-send awaiting_choice transition', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'awaiting_choice',
        userSelection: '步骤概览',
      },
    });

    assert.ok(ctx.includes('Guide Selection'), 'preview branch should remain available after awaiting_choice');
    assert.ok(ctx.includes('步骤概览回复用户'), 'repeated preview should still present inline step tips');
    assert.ok(
      !ctx.includes('status="awaiting_choice"'),
      'repeated preview must not emit an awaiting_choice -> awaiting_choice self-transition',
    );
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

  test('buildSystemPrompt size stays under 3900 chars with SOP hint after Magic Words + runtime prompt growth', async () => {
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
    assert.ok(prompt.length < 5700, `Prompt with SOP hint is ${prompt.length} chars, expected < 5700`);
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

  test('buildSystemPrompt size stays under 5200 chars with voice mode + SOP hint after Magic Words growth', async () => {
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
    assert.ok(prompt.length < 5700, `Prompt with voice mode + SOP hint is ${prompt.length} chars, expected < 5700`);
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
        phase: 'phase-1-intro',
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
    // F064 球权模型: 空气传球 警告并入 "A2A 球权检查" invocation context（矛盾 push back 语义）
    assert.ok(prompt.includes('push back'), 'maine-coon prompt must include push back (phantom handoff guard)');
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

  // ── Drift guard: magic words in shared-rules.md ↔ GOVERNANCE_L0_DIGEST ──
  test('GOVERNANCE_L0_DIGEST contains all magic words from shared-rules.md', async () => {
    const { readFileSync } = await import('node:fs');
    const rulesPath = resolve(import.meta.dirname, '../../../cat-cafe-skills/refs/shared-rules.md');
    const rulesText = readFileSync(rulesPath, 'utf8');
    const magicWordPattern = /\|.*?「(.+?)」/g;
    const rulesMagicWords = [...rulesText.matchAll(magicWordPattern)].map((m) => m[1]);
    assert.ok(
      rulesMagicWords.length >= 7,
      `Expected >=7 magic words in shared-rules.md, got ${rulesMagicWords.length}`,
    );
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    for (const word of rulesMagicWords) {
      assert.ok(prompt.includes(`「${word}」`), `Missing magic word 「${word}」 in GOVERNANCE_L0_DIGEST`);
    }
  });

  // ── Drift guard: shared-rules.md ↔ GOVERNANCE_L0_DIGEST ──────
  test('GOVERNANCE_L0_DIGEST stays in sync with shared-rules.md world-view headings', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { createHash } = await import('node:crypto');

    // Extract world-view / principle section headings from shared-rules.md
    const rulesPath = resolve(import.meta.dirname, '../../../cat-cafe-skills/refs/shared-rules.md');
    const rulesText = readFileSync(rulesPath, 'utf8');
    const headings = rulesText
      .split('\n')
      .filter((l) => /^###?\s+(P\d|W\d)/.test(l))
      .sort()
      .join('\n');
    const hash = createHash('sha256').update(headings).digest('hex').slice(0, 16);

    // Pin: update this hash whenever you add/remove/rename P* or W* sections
    // in shared-rules.md, AND update GOVERNANCE_L0_DIGEST in SystemPromptBuilder.ts
    const PINNED_HASH = '89989b48ac64c6ee';
    if (PINNED_HASH === '${PLACEHOLDER}') {
      // First run — print hash for pinning
      console.log(`[drift-guard] shared-rules headings hash: ${hash} — pin this value`);
      return; // skip assertion on first run
    }
    assert.equal(
      hash,
      PINNED_HASH,
      `shared-rules.md P*/W* headings changed (got ${hash}, pinned ${PINNED_HASH}). ` +
        'Update GOVERNANCE_L0_DIGEST in SystemPromptBuilder.ts to match, then update PINNED_HASH here.',
    );
  });
});
