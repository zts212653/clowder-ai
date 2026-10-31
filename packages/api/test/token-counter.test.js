/**
 * token-counter.ts tests
 * js-tiktoken based token estimation for context budget management
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateTokens, estimateTokensFromMessages } from '../dist/utils/token-counter.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('returns positive count for ASCII text', () => {
    const count = estimateTokens('Hello, world!');
    assert.ok(count > 0, 'should be positive');
    // "Hello, world!" is typically 4 tokens in cl100k_base
    assert.ok(count < 10, `expected < 10, got ${count}`);
  });

  it('returns higher token count for Chinese text vs same-length ASCII', () => {
    const chinese = '你好世界测试文本'; // 8 chars
    const ascii = 'abcdefgh'; // 8 chars
    const chineseTokens = estimateTokens(chinese);
    const asciiTokens = estimateTokens(ascii);
    // Chinese chars typically 1-2 tokens each vs ASCII ~4 chars/token
    assert.ok(chineseTokens > asciiTokens, `Chinese (${chineseTokens}) should > ASCII (${asciiTokens})`);
  });

  it('handles mixed Chinese-English text', () => {
    const mixed = 'Clowder AI 猫咖啡馆 is great!';
    const count = estimateTokens(mixed);
    assert.ok(count > 0, 'should be positive');
    assert.ok(count < 30, `expected < 30, got ${count}`);
  });

  it('handles long text within 2s', () => {
    const longText = 'hello world '.repeat(10000); // ~120k chars
    const start = Date.now();
    const count = estimateTokens(longText);
    const elapsed = Date.now() - start;
    assert.ok(count > 0, 'should be positive');
    assert.ok(elapsed < 2000, `took ${elapsed}ms, expected < 2000ms`);
  });

  // Regression for #591: js-tiktoken's default disallowedSpecial='all' would
  // throw on any GPT control-token literal embedded in user text, taking down
  // the entire routing pipeline. We use the encoder only for local budget
  // estimation, so special tokens must be counted as regular text.
  it('does not throw on text containing GPT special-token literals', () => {
    const sentinel = `<|${'endoftext'}|>`;
    const fimPrefix = `<|${'fim_prefix'}|>`;
    const message = `Discussion of prompt injection: ${sentinel} and ${fimPrefix} should be safe to count.`;

    let count = 0;
    assert.doesNotThrow(() => {
      count = estimateTokens(message);
    }, 'estimateTokens must not throw on special-token literals');
    assert.ok(count > 0, `expected positive token count, got ${count}`);
  });

  it('counts GPT special-token literals as ordinary text, not one control token', () => {
    const sentinel = `<|${'endoftext'}|>`;
    const count = estimateTokens(sentinel);

    assert.ok(count > 1, `special-token literal should be plain text count, got ${count}`);
  });
});

describe('estimateTokensFromMessages', () => {
  it('returns 0 for empty array', () => {
    assert.equal(estimateTokensFromMessages([], 5000), 0);
  });

  it('sums tokens across messages', () => {
    const messages = [{ content: 'Hello, world!' }, { content: 'How are you?' }];
    const total = estimateTokensFromMessages(messages, 5000);
    const individual = estimateTokens('Hello, world!') + estimateTokens('How are you?');
    assert.equal(total, individual);
  });

  it('truncates content exceeding maxContentLength before tokenizing', () => {
    const messages = [{ content: 'a'.repeat(200) }];
    const withLimit = estimateTokensFromMessages(messages, 50);
    const withoutLimit = estimateTokensFromMessages(messages, 5000);
    assert.ok(withLimit < withoutLimit, `limited (${withLimit}) should < unlimited (${withoutLimit})`);
  });

  it('handles messages with contentBlocks', () => {
    const messages = [
      {
        content: '',
        contentBlocks: [
          { type: 'text', text: 'Block one' },
          { type: 'text', text: 'Block two' },
        ],
      },
    ];
    const count = estimateTokensFromMessages(messages, 5000);
    assert.ok(count > 0, 'should count text blocks');
  });

  it('skips image contentBlocks', () => {
    const messages = [
      {
        content: 'text content',
        contentBlocks: [{ type: 'image', url: 'data:image/png;base64,...' }],
      },
    ];
    const count = estimateTokensFromMessages(messages, 5000);
    const textOnly = estimateTokens('text content');
    assert.equal(count, textOnly);
  });

  // Regression for #591: a single message containing a GPT control-token
  // literal would crash assembleIncrementalContext for an entire thread.
  it('does not throw when a message contains GPT special-token literals', () => {
    const sentinel = `<|${'endoftext'}|>`;
    const messages = [
      { content: `Hello ${sentinel} world` },
      {
        content: '',
        contentBlocks: [{ type: 'text', text: `Block with ${sentinel}` }],
      },
    ];
    let count = 0;
    assert.doesNotThrow(() => {
      count = estimateTokensFromMessages(messages, 5000);
    }, 'estimateTokensFromMessages must not throw on special-token literals');
    assert.ok(count > 0, `expected positive token count, got ${count}`);
  });
});
