/**
 * ContextAssembler Tests
 * 测试历史 context 组装和消息格式化
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

/** Helper: create a mock StoredMessage */
function mockMsg(overrides) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'test message',
    mentions: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('formatMessage', () => {
  test('formats user message with 铲屎官', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({ content: '你好', timestamp: new Date('2026-02-07T14:02:00').getTime() });
    const result = formatMessage(msg);
    assert.ok(result.includes('14:02'));
    assert.ok(result.includes('铲屎官'));
    assert.ok(result.includes('你好'));
  });

  test('formats cat message with display name', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({ catId: 'opus', content: '喵', timestamp: new Date('2026-02-07T14:03:00').getTime() });
    const result = formatMessage(msg);
    assert.ok(result.includes('14:03'));
    assert.ok(result.includes('布偶猫'));
    assert.ok(result.includes('喵'));
  });

  test('formats codex cat message', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({ catId: 'codex', content: 'review done' });
    const result = formatMessage(msg);
    assert.ok(result.includes('缅因猫'));
  });

  test('formats gemini cat message', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({ catId: 'gemini', content: 'design ready' });
    const result = formatMessage(msg);
    assert.ok(result.includes('暹罗猫'));
  });

  test('truncates long content with head+tail preservation', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const longContent = `${'A'.repeat(300)}CONCLUSION_HERE`;
    const msg = mockMsg({ content: longContent });
    const result = formatMessage(msg, { truncate: 100 });
    // Should contain truncation marker with char count
    assert.ok(/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(result), 'should have truncation marker with char count');
    // Should preserve the tail (conclusion)
    assert.ok(result.includes('CONCLUSION_HERE'), 'should preserve tail with conclusion');
    // Total content length should be approximately the truncate limit
    assert.ok(result.length <= 200, 'formatted output should be bounded');
  });

  test('does not truncate when content is within limit', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({ content: 'short' });
    const result = formatMessage(msg, { truncate: 100 });
    assert.ok(result.includes('short'));
    assert.ok(!result.includes('...'));
  });

  test('does not truncate when no truncate option', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const longContent = 'B'.repeat(1000);
    const msg = mockMsg({ content: longContent });
    const result = formatMessage(msg);
    assert.ok(result.includes(longContent));
  });
});

describe('assembleContext', () => {
  test('returns empty for no messages', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const result = assembleContext([]);
    assert.equal(result.contextText, '');
    assert.equal(result.messageCount, 0);
  });

  test('formats single message', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const result = assembleContext([mockMsg({ content: '你好世界' })]);
    assert.ok(result.contextText.includes('[对话历史 - 最近 1 条]'));
    assert.ok(result.contextText.includes('铲屎官'));
    assert.ok(result.contextText.includes('你好世界'));
    assert.ok(result.contextText.endsWith('[/对话历史]'));
    assert.equal(result.messageCount, 1);
  });

  test('formats mixed user and cat messages', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = [
      mockMsg({ catId: null, content: '@布偶 你好', timestamp: 1000 }),
      mockMsg({ catId: 'opus', content: '你好铲屎官', timestamp: 2000 }),
      mockMsg({ catId: 'codex', content: '我也在', timestamp: 3000 }),
    ];
    const result = assembleContext(msgs);
    assert.ok(result.contextText.includes('铲屎官'));
    assert.ok(result.contextText.includes('布偶猫'));
    assert.ok(result.contextText.includes('缅因猫'));
    assert.equal(result.messageCount, 3);
  });

  test('truncates to maxMessages', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = Array.from({ length: 25 }, (_, i) => mockMsg({ content: `msg-${i}`, timestamp: i * 1000 }));
    const result = assembleContext(msgs, { maxMessages: 5 });
    assert.equal(result.messageCount, 5);
    // Should include the last 5 (msg-20 through msg-24)
    assert.ok(result.contextText.includes('msg-24'));
    assert.ok(result.contextText.includes('msg-20'));
    assert.ok(!result.contextText.includes('msg-19'));
  });

  test('truncates long message content with head+tail', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const longContent = `${'X'.repeat(500)}TAIL_DATA`;
    const msgs = [mockMsg({ content: longContent })];
    const result = assembleContext(msgs, { maxContentLength: 100 });
    assert.ok(
      /\[\.\.\.truncated \d+ chars\.\.\.\]/.test(result.contextText),
      'should have truncation marker with char count',
    );
    assert.ok(result.contextText.includes('TAIL_DATA'), 'should preserve tail');
  });

  test('includes user messages starting with "Error:" (no false-positive filtering)', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = [
      mockMsg({ catId: null, content: 'Error: Cannot find module "foo"', timestamp: 1000 }),
      mockMsg({ catId: null, content: '正常消息', timestamp: 2000 }),
      mockMsg({ catId: 'opus', content: '猫猫回复', timestamp: 3000 }),
    ];
    const result = assembleContext(msgs);
    assert.equal(result.messageCount, 3);
    assert.ok(result.contextText.includes('Error: Cannot find module'));
    assert.ok(result.contextText.includes('正常消息'));
    assert.ok(result.contextText.includes('猫猫回复'));
  });

  test('excludes userId=system messages from prompt context (error badge pollution)', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = [
      mockMsg({ catId: null, userId: 'user-1', content: '你好', timestamp: 1000 }),
      mockMsg({ catId: null, userId: 'system', content: 'Error: stream_idle_stall: Gemini stopped', timestamp: 2000 }),
      mockMsg({ catId: 'opus', userId: 'user-1', content: '猫猫回复', timestamp: 3000 }),
    ];
    const result = assembleContext(msgs);
    assert.equal(result.messageCount, 2, 'system error should be excluded from count');
    assert.ok(result.contextText.includes('你好'), 'user message should be included');
    assert.ok(result.contextText.includes('猫猫回复'), 'cat message should be included');
    assert.ok(!result.contextText.includes('stream_idle_stall'), 'system error should NOT enter prompt');
    assert.ok(!result.contextText.includes('铲屎官] Error:'), 'system error must not appear as 铲屎官');
  });

  test('uses default maxMessages=20 and maxContentLength=1500', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = Array.from({ length: 25 }, (_, i) => mockMsg({ content: `m${i}`, timestamp: i * 1000 }));
    const result = assembleContext(msgs);
    assert.equal(result.messageCount, 20);
    assert.ok(result.contextText.includes('最近 20 条'));
  });

  test('default maxContentLength=1500 does not truncate 600-char messages', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const content = 'A'.repeat(600);
    const msgs = [mockMsg({ content })];
    const result = assembleContext(msgs);
    // 600 chars < 1500 default, so should NOT be truncated
    assert.ok(result.contextText.includes(content), 'should contain full 600 chars');
    assert.ok(!result.contextText.includes('...'), 'should not have truncation marker');
  });

  test('respects MAX_CONTEXT_MSG_CHARS env var override', async () => {
    process.env.MAX_CONTEXT_MSG_CHARS = '200';
    try {
      // Re-import to pick up env var (assembleContext reads env at call time)
      const { assembleContext: ac } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
      const msgs = [mockMsg({ content: 'B'.repeat(300) })];
      const result = ac(msgs);
      // 300 chars > 200 env limit, should be truncated with marker
      assert.ok(/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(result.contextText), 'should truncate at env limit');
    } finally {
      delete process.env.MAX_CONTEXT_MSG_CHARS;
    }
  });

  test('maxTotalChars (deprecated) still works as token budget via fallback', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    // Create 10 messages each ~12-15 tokens formatted (timestamp + sender + content)
    const msgs = Array.from({ length: 10 }, (_, i) =>
      mockMsg({ content: `message-content-${i}-padding`, timestamp: i * 1000 }),
    );
    // Tight token budget — only a few messages should fit
    const result = assembleContext(msgs, { maxTotalChars: 50 });
    assert.ok(result.messageCount < 10, `expected fewer than 10, got ${result.messageCount}`);
    assert.ok(result.messageCount > 0, 'should include at least 1 message');
    assert.ok(result.estimatedTokens <= 60, `tokens should be near budget, got ${result.estimatedTokens}`);
  });

  test('maxTotalChars large enough includes all messages', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = Array.from({ length: 5 }, (_, i) => mockMsg({ content: `short${i}`, timestamp: i * 1000 }));
    const result = assembleContext(msgs, { maxTotalChars: 10000 });
    assert.equal(result.messageCount, 5);
  });

  test('maxTotalChars=0 returns empty context', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = [mockMsg({ content: 'hello' })];
    const result = assembleContext(msgs, { maxTotalChars: 0 });
    assert.equal(result.contextText, '');
    assert.equal(result.messageCount, 0);
  });

  test('maxContentLength truncates before maxTotalChars budget check', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    // One very long message that would be 600 chars raw
    const msgs = [mockMsg({ content: 'Z'.repeat(600) })];
    // maxContentLength=100 truncates to ~100 chars, then maxTotalChars budget allows it
    const result = assembleContext(msgs, { maxContentLength: 100, maxTotalChars: 300 });
    assert.equal(result.messageCount, 1);
    assert.ok(/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(result.contextText), 'should truncate with marker');
  });
});

describe('formatMessage — head+tail truncation (#91 regression)', () => {
  test('preserves conclusion at end of long message', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    // Simulate: long work log + conclusion at end (the exact bug scenario)
    const workLog = 'Phase 1 completed. Phase 2 in progress. '.repeat(50);
    const conclusion = '\n\n## Review 请求\n请确认修复是否正确，确认后将执行合入。\n@缅因猫';
    const msg = mockMsg({ content: workLog + conclusion });
    const result = formatMessage(msg, { truncate: 1500 });

    assert.ok(/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(result), 'should have truncation marker with char count');
    assert.ok(result.includes('@缅因猫'), 'should preserve @mention at end');
    assert.ok(result.includes('Review 请求'), 'should preserve review request');
    assert.ok(result.includes('Phase 1'), 'should preserve beginning context');
  });

  test('head gets 40%, tail gets 60% of budget', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const head = 'H'.repeat(500);
    const tail = 'T'.repeat(500);
    const msg = mockMsg({ content: head + tail });
    const result = formatMessage(msg, { truncate: 200 });

    // marker is '\n\n[...truncated N chars...]\n\n' (dynamic), available = 200 - marker.length
    // head = 40% of 180 = 72, tail = 60% of 180 = 108
    const headContent = result.match(/H+/)?.[0] ?? '';
    const tailContent = result.match(/T+/)?.[0] ?? '';
    assert.ok(headContent.length > 0, 'should have head content');
    assert.ok(tailContent.length > 0, 'should have tail content');
    assert.ok(tailContent.length > headContent.length, 'tail should be larger than head');
  });

  test('does not truncate when content is within limit', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({ content: 'short message' });
    const result = formatMessage(msg, { truncate: 1500 });
    assert.ok(!/\[\.\.\.truncated \d+ chars\.\.\.\]/.test(result), 'should not truncate short messages');
    assert.ok(result.includes('short message'));
  });
});

describe('cross-post sender variant: distinguish same-family cats', () => {
  before(async () => {
    const { catRegistry } = await import('../node_modules/@cat-cafe/shared/dist/index.js');
    // Register variant cats that exist in cat-config.json but not in static CAT_CONFIGS
    if (!catRegistry.has('sonnet')) {
      catRegistry.register('sonnet', {
        id: 'sonnet',
        name: 'sonnet',
        displayName: '布偶猫',
        nickname: '宪宪',
        avatar: '/avatars/sonnet.png',
        color: { primary: '#e0c9a0', secondary: '#f5ede0' },
        mentionPatterns: ['@sonnet'],
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        mcpSupport: false,
        roleDescription: '',
        personality: '',
        breedId: 'ragdoll',
        variantLabel: 'Sonnet',
        isDefaultVariant: false,
      });
    }
    if (!catRegistry.has('opus-45')) {
      catRegistry.register('opus-45', {
        id: 'opus-45',
        name: 'opus-45',
        displayName: '布偶猫',
        nickname: '宪宪',
        avatar: '/avatars/opus-45.png',
        color: { primary: '#e0c9a0', secondary: '#f5ede0' },
        mentionPatterns: ['@opus-45'],
        provider: 'anthropic',
        defaultModel: 'claude-opus-4-5-20251101',
        mcpSupport: false,
        roleDescription: '',
        personality: '',
        breedId: 'ragdoll',
        variantLabel: 'Opus 4.5',
        isDefaultVariant: false,
      });
    }
    if (!catRegistry.has('spark')) {
      catRegistry.register('spark', {
        id: 'spark',
        name: 'spark',
        displayName: '缅因猫 Spark',
        nickname: '砚砚',
        avatar: '/avatars/sliced-finial/codex_box.png',
        color: { primary: '#81C784', secondary: '#C8E6C9' },
        mentionPatterns: ['@spark'],
        provider: 'openai',
        defaultModel: 'gpt-5.3-codex-spark',
        mcpSupport: false,
        roleDescription: '',
        personality: '',
        breedId: 'maine-coon',
        variantLabel: 'Spark',
        isDefaultVariant: false,
      });
    }
  });

  after(async () => {
    const { catRegistry } = await import('../node_modules/@cat-cafe/shared/dist/index.js');
    catRegistry.reset();
  });

  test('formatMessage shows 布偶猫(Sonnet) for sonnet catId', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'sonnet',
      content: 'Hello from sonnet',
      extra: {
        crossPost: { sourceThreadId: 'thread-abc123' },
      },
    });
    const result = formatMessage(msg);
    // Should show family name + variant, not just raw catId
    assert.ok(result.includes('布偶猫'), `expected 布偶猫 family name, got: ${result}`);
    assert.ok(result.includes('Sonnet') || result.includes('sonnet'), `expected Sonnet variant, got: ${result}`);
    assert.ok(
      !/\[\d{2}:\d{2}\ssonnet(?:\s|←|\])/.test(result),
      `should not display raw catId 'sonnet' as sender, got: ${result}`,
    );
  });

  test('formatMessage shows 布偶猫(Opus 4.5) for opus-45 catId', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'opus-45',
      content: 'Hello from opus-45',
      extra: {
        crossPost: { sourceThreadId: 'thread-abc123' },
      },
    });
    const result = formatMessage(msg);
    assert.ok(result.includes('布偶猫'), `expected 布偶猫 family name, got: ${result}`);
    assert.ok(result.includes('Opus 4.5') || result.includes('opus-45'), `expected Opus 4.5 variant, got: ${result}`);
    assert.ok(
      !/\[\d{2}:\d{2}\sopus-45(?:\s|←|\])/.test(result),
      `should not display raw catId 'opus-45' as sender, got: ${result}`,
    );
  });

  test('formatMessage avoids duplicate variant label when displayName already includes it', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'spark',
      content: 'Hello from spark',
    });
    const result = formatMessage(msg);
    assert.ok(result.includes('缅因猫 Spark'), `expected displayName to be preserved, got: ${result}`);
    assert.ok(!result.includes('Spark(Spark)'), `should avoid duplicate variant label, got: ${result}`);
  });

  test('formatMessage for opus (main) still shows 布偶猫 without extra variant noise', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'opus',
      content: 'Hello from opus',
    });
    const result = formatMessage(msg);
    assert.ok(result.includes('布偶猫'), `should still show 布偶猫 for opus, got: ${result}`);
  });
});

describe('F052: cross-thread source annotation', () => {
  test('formatMessage adds source annotation for cross-thread messages', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'codex',
      content: 'Hello from another thread',
      extra: {
        crossPost: { sourceThreadId: 'source-thread-abc123' },
      },
    });
    const result = formatMessage(msg);
    assert.ok(
      result.includes('← from thread:source-t'),
      'should contain source thread annotation (truncated to 8 chars)',
    );
    assert.ok(result.includes('缅因猫'), 'should still show cat name');
  });

  test('formatMessage does NOT add annotation for local messages', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'codex',
      content: 'Hello local',
    });
    const result = formatMessage(msg);
    assert.ok(!result.includes('← from thread:'), 'local message should NOT have annotation');
  });

  test('formatMessage handles crossPost without sourceThreadId gracefully', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: 'codex',
      content: 'Hello',
      extra: { crossPost: {} },
    });
    const result = formatMessage(msg);
    assert.ok(!result.includes('← from thread:'), 'should not add annotation without sourceThreadId');
  });
});

describe('assembleContext — F8 token-based truncation', () => {
  test('returns estimatedTokens in result', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = [
      mockMsg({ content: 'Hello world', timestamp: 1000 }),
      mockMsg({ content: 'How are you?', timestamp: 2000 }),
    ];
    const result = assembleContext(msgs);
    assert.ok(
      typeof result.estimatedTokens === 'number',
      `estimatedTokens should be a number, got ${typeof result.estimatedTokens}`,
    );
    assert.ok(result.estimatedTokens > 0, 'estimatedTokens should be positive');
  });

  test('estimatedTokens=0 when no messages included', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const result = assembleContext([]);
    assert.equal(result.estimatedTokens, 0);
  });

  test('maxTotalTokens limits context by token count, not char count', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    // Chinese text: more tokens per char than ASCII
    // 10 messages of Chinese content (~2 tokens/char in cl100k_base)
    const chineseMsgs = Array.from({ length: 10 }, (_, i) =>
      mockMsg({ content: `你好世界测试消息内容填充${i}`, timestamp: i * 1000 }),
    );
    // 10 messages of ASCII content (~0.25 tokens/char)
    const asciiMsgs = Array.from({ length: 10 }, (_, i) =>
      mockMsg({ content: `hello world test message padding${i}`, timestamp: i * 1000 }),
    );

    // With a tight token budget, Chinese messages should fit fewer
    // than ASCII messages of similar char length (because Chinese = more tokens)
    const chineseResult = assembleContext(chineseMsgs, { maxTotalTokens: 150 });
    const asciiResult = assembleContext(asciiMsgs, { maxTotalTokens: 150 });

    assert.ok(
      chineseResult.messageCount < asciiResult.messageCount ||
        chineseResult.estimatedTokens > asciiResult.estimatedTokens * 0.7,
      `Token-based truncation should differentiate Chinese (${chineseResult.messageCount} msgs, ` +
        `${chineseResult.estimatedTokens} tokens) from ASCII (${asciiResult.messageCount} msgs, ` +
        `${asciiResult.estimatedTokens} tokens)`,
    );
  });

  test('maxTotalTokens=0 returns empty context', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msgs = [mockMsg({ content: 'hello' })];
    const result = assembleContext(msgs, { maxTotalTokens: 0 });
    assert.equal(result.contextText, '');
    assert.equal(result.messageCount, 0);
    assert.equal(result.estimatedTokens, 0);
  });

  test('F97: connector message uses source.label as sender name', async () => {
    const { formatMessage } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const msg = mockMsg({
      catId: null,
      content: 'GitHub Review 通知',
      timestamp: new Date('2026-02-25T10:00:00').getTime(),
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '🔔',
      },
    });
    const result = formatMessage(msg);
    assert.ok(result.includes('GitHub Review'), 'should use source.label instead of 铲屎官');
    assert.ok(!result.includes('铲屎官'), 'should NOT show 铲屎官 for connector messages');
    assert.ok(result.includes('GitHub Review 通知'));
  });
});
