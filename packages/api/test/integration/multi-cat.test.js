/**
 * Multi-Cat Integration Tests (CLI mode)
 * 测试真实 CLI 调用的集成测试
 *
 * IMPORTANT: 这些测试需要真实的 CLI 工具已登录，默认跳过
 * 运行方式:
 *   RUN_INTEGRATION_TESTS=true node --test test/integration/multi-cat.test.js
 *
 * 前提条件:
 *   - `claude` CLI 已安装并登录 (Max plan)
 *   - `codex` CLI 已安装并登录 (ChatGPT Plus/Pro)
 *   - `gemini` CLI 已安装并登录 (Google AI)
 *
 * 不再需要 API keys — CLI 使用订阅额度。
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { migrateRouterOpts } from '../helpers/agent-registry-helpers.js';

// Check if integration tests should run
const shouldRunIntegrationTests = process.env.RUN_INTEGRATION_TESTS === 'true';

// Check for CLI availability (not API keys)
function hasCli(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasClaude = hasCli('claude');
const hasCodex = hasCli('codex');
const hasGemini = hasCli('gemini');

// Helper to conditionally skip tests
const itOrSkip = shouldRunIntegrationTests ? test : test.skip;

// Log status at startup
if (!shouldRunIntegrationTests) {
  console.log('\n[multi-cat.test.js] Skipping integration tests (RUN_INTEGRATION_TESTS not set)\n');
} else {
  console.log(`\n[multi-cat.test.js] CLI availability: claude=${hasClaude} codex=${hasCodex} gemini=${hasGemini}\n`);
}

/** Create a fully wired router with real services (no mock) */
async function createRealRouter() {
  const { ClaudeAgentService } = await import(
    '../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
  );
  const { CodexAgentService } = await import('../../dist/domains/cats/services/agents/providers/CodexAgentService.js');
  const { GeminiAgentService } = await import(
    '../../dist/domains/cats/services/agents/providers/GeminiAgentService.js'
  );
  const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');

  return new AgentRouter(
    await migrateRouterOpts({
      claudeService: new ClaudeAgentService(),
      codexService: new CodexAgentService(),
      geminiService: new GeminiAgentService(),
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
    }),
  );
}

describe('Multi-Cat Integration Tests', { skip: !shouldRunIntegrationTests }, () => {
  /**
   * Test: Default routing to Claude (opus)
   * 无提及时默认路由到布偶猫
   */
  itOrSkip('routes to Claude (opus) when no @ mention is present', { skip: !hasClaude, timeout: 60_000 }, async () => {
    const router = await createRealRouter();

    const messages = [];
    for await (const msg of router.route('test-user-1', 'Say "hello" in exactly one word')) {
      messages.push(msg);
    }

    // Verify we got messages from opus
    assert.ok(messages.length > 0, 'Should receive at least one message');
    assert.ok(
      messages.some((m) => m.catId === 'opus'),
      'Messages should be from opus',
    );
    assert.ok(
      messages.some((m) => m.type === 'text'),
      'Should have text response',
    );
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'Should have done message',
    );

    // Verify session was created
    const sessionInit = messages.find((m) => m.type === 'session_init');
    assert.ok(sessionInit, 'Should have session_init message');
    assert.ok(sessionInit.sessionId, 'Should have session ID');
  });

  /**
   * Test: Routing to Codex via @缅因猫
   * @缅因 路由到缅因猫 (Codex)
   */
  itOrSkip('routes to Codex when @缅因 is mentioned', { skip: !hasCodex, timeout: 60_000 }, async () => {
    const router = await createRealRouter();

    const messages = [];
    for await (const msg of router.route('test-user-2', '@缅因 说 "你好"')) {
      messages.push(msg);
    }

    // Verify we got messages from codex
    assert.ok(messages.length > 0, 'Should receive at least one message');
    assert.ok(
      messages.some((m) => m.catId === 'codex'),
      'Messages should be from codex',
    );
    assert.ok(
      messages.some((m) => m.type === 'text'),
      'Should have text response',
    );
  });

  /**
   * Test: Routing to Gemini via @暹罗猫
   * @暹罗 路由到暹罗猫 (Gemini)
   */
  itOrSkip('routes to Gemini when @暹罗 is mentioned', { skip: !hasGemini, timeout: 60_000 }, async () => {
    const router = await createRealRouter();

    const messages = [];
    for await (const msg of router.route('test-user-3', '@暹罗 说 "你好"')) {
      messages.push(msg);
    }

    // Verify we got messages from gemini
    assert.ok(messages.length > 0, 'Should receive at least one message');
    assert.ok(
      messages.some((m) => m.catId === 'gemini'),
      'Messages should be from gemini',
    );
    assert.ok(
      messages.some((m) => m.type === 'text'),
      'Should have text response',
    );
  });

  /**
   * Test: Multi-cat serial invocation
   * 多猫串行调用 - @opus 和 @codex 按顺序执行
   */
  itOrSkip(
    'executes multiple cats in order for multi-mention',
    { skip: !hasClaude || !hasCodex, timeout: 120_000 },
    async () => {
      const router = await createRealRouter();

      const messages = [];
      for await (const msg of router.route('test-user-4', '@opus say "hello", then @codex say "world"')) {
        messages.push(msg);
      }

      // Verify we got messages from both cats
      const opusMessages = messages.filter((m) => m.catId === 'opus');
      const codexMessages = messages.filter((m) => m.catId === 'codex');

      assert.ok(opusMessages.length > 0, 'Should have opus messages');
      assert.ok(codexMessages.length > 0, 'Should have codex messages');

      // Verify opus text comes before codex text
      const opusTextIndex = messages.findIndex((m) => m.catId === 'opus' && m.type === 'text');
      const codexTextIndex = messages.findIndex((m) => m.catId === 'codex' && m.type === 'text');

      assert.ok(opusTextIndex >= 0, 'Should have opus text');
      assert.ok(codexTextIndex >= 0, 'Should have codex text');
      assert.ok(opusTextIndex < codexTextIndex, 'Opus text should come before codex text');
    },
  );

  /**
   * Test: Three-cat serial invocation
   * 三猫串行调用
   */
  itOrSkip(
    'executes all three cats in order',
    { skip: !hasClaude || !hasCodex || !hasGemini, timeout: 180_000 },
    async () => {
      const router = await createRealRouter();

      const messages = [];
      for await (const msg of router.route('test-user-5', '@布偶 say "one", @缅因 say "two", @暹罗 say "three"')) {
        messages.push(msg);
      }

      // Verify we got text from all three cats
      const textMessages = messages.filter((m) => m.type === 'text');
      const catIds = [...new Set(textMessages.map((m) => m.catId))];

      assert.ok(catIds.includes('opus'), 'Should have opus text');
      assert.ok(catIds.includes('codex'), 'Should have codex text');
      assert.ok(catIds.includes('gemini'), 'Should have gemini text');

      // Verify order: opus -> codex -> gemini
      const opusTextIndex = textMessages.findIndex((m) => m.catId === 'opus');
      const codexTextIndex = textMessages.findIndex((m) => m.catId === 'codex');
      const geminiTextIndex = textMessages.findIndex((m) => m.catId === 'gemini');

      assert.ok(opusTextIndex < codexTextIndex, 'Opus should come before codex');
      assert.ok(codexTextIndex < geminiTextIndex, 'Codex should come before gemini');
    },
  );

  /**
   * Test: Session persistence (Claude only)
   * 验证 Claude session 在多次调用间保持
   * Note: Gemini UUID resume 兼容性由 provider/invocation 层单测覆盖，
   * 本集成用例只验证 Claude 的跨调用保持。
   */
  itOrSkip('maintains Claude session across multiple calls', { skip: !hasClaude, timeout: 120_000 }, async () => {
    const router = await createRealRouter();

    // First call - should create session
    const messages1 = [];
    for await (const msg of router.route('test-user-6', 'Remember the word "banana"')) {
      messages1.push(msg);
    }

    const sessionInit1 = messages1.find((m) => m.type === 'session_init');
    assert.ok(sessionInit1, 'First call should have session_init');
    const firstSessionId = sessionInit1.sessionId;
    assert.ok(firstSessionId, 'First call should create session ID');

    // Second call - should reuse session
    const messages2 = [];
    for await (const msg of router.route('test-user-6', 'What word did I ask you to remember?')) {
      messages2.push(msg);
    }

    const sessionInit2 = messages2.find((m) => m.type === 'session_init');
    assert.ok(sessionInit2, 'Second call should have session_init');

    // The session ID should be the same (session was resumed)
    assert.equal(sessionInit2.sessionId, firstSessionId, 'Second call should reuse the same session ID');
  });
});

describe('Individual Service Integration Tests', { skip: !shouldRunIntegrationTests }, () => {
  /**
   * Test: ClaudeAgentService direct invocation
   */
  itOrSkip('ClaudeAgentService responds to prompt', { skip: !hasClaude, timeout: 60_000 }, async () => {
    const { ClaudeAgentService } = await import(
      '../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
    );

    const service = new ClaudeAgentService();
    const messages = [];

    for await (const msg of service.invoke('Say "test" in one word')) {
      messages.push(msg);
    }

    assert.ok(messages.length > 0, 'Should receive messages');
    assert.ok(
      messages.some((m) => m.type === 'session_init'),
      'Should have session_init',
    );
    assert.ok(
      messages.some((m) => m.type === 'text'),
      'Should have text response',
    );
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'Should have done message',
    );
  });

  /**
   * Test: CodexAgentService direct invocation
   */
  itOrSkip('CodexAgentService responds to prompt', { skip: !hasCodex, timeout: 60_000 }, async () => {
    const { CodexAgentService } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAgentService.js'
    );

    const service = new CodexAgentService();
    const messages = [];

    for await (const msg of service.invoke('Say "test" in one word')) {
      messages.push(msg);
    }

    assert.ok(messages.length > 0, 'Should receive messages');
    assert.ok(
      messages.some((m) => m.type === 'text' || m.type === 'done' || m.type === 'error'),
      'Should have some response',
    );
  });

  /**
   * Test: GeminiAgentService direct invocation
   */
  itOrSkip('GeminiAgentService responds to prompt', { skip: !hasGemini, timeout: 60_000 }, async () => {
    const { GeminiAgentService } = await import(
      '../../dist/domains/cats/services/agents/providers/GeminiAgentService.js'
    );

    const service = new GeminiAgentService();
    const messages = [];

    for await (const msg of service.invoke('Say "test" in one word')) {
      messages.push(msg);
    }

    assert.ok(messages.length > 0, 'Should receive messages');
    assert.ok(
      messages.some((m) => m.type === 'session_init'),
      'Should have session_init',
    );
    assert.ok(
      messages.some((m) => m.type === 'text'),
      'Should have text response',
    );
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'Should have done message',
    );
  });
});
