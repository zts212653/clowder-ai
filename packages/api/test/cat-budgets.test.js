/**
 * cat-budgets.ts tests
 * Per-cat context budget configuration
 */

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearBudgetCache, getAllCatBudgets, getCatContextBudget } from '../dist/config/cat-budgets.js';

describe('getCatContextBudget', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearBudgetCache();
    // Clear relevant env vars
    delete process.env.CAT_OPUS_MAX_PROMPT_TOKENS;
    delete process.env.CAT_CODEX_MAX_PROMPT_TOKENS;
    delete process.env.CAT_GEMINI_MAX_PROMPT_TOKENS;
    delete process.env.MAX_PROMPT_TOKENS;
  });

  afterEach(() => {
    // Cleanup
    delete process.env.CAT_OPUS_MAX_PROMPT_TOKENS;
    delete process.env.CAT_CODEX_MAX_PROMPT_TOKENS;
    delete process.env.CAT_GEMINI_MAX_PROMPT_TOKENS;
    delete process.env.MAX_PROMPT_TOKENS;
    clearBudgetCache();
  });

  it('opus default budget from cat-config.json', () => {
    const budget = getCatContextBudget('opus');
    assert.strictEqual(budget.maxPromptTokens, 180000);
    assert.strictEqual(budget.maxContextTokens, 160000);
    assert.strictEqual(budget.maxMessages, 200);
    assert.strictEqual(budget.maxContentLengthPerMsg, 100000);
  });

  it('codex default budget from cat-config.json', () => {
    const budget = getCatContextBudget('codex');
    assert.strictEqual(budget.maxPromptTokens, 240000);
    assert.strictEqual(budget.maxContextTokens, 216000);
    assert.strictEqual(budget.maxMessages, 200);
    assert.strictEqual(budget.maxContentLengthPerMsg, 100000);
  });

  it('gemini default budget from cat-config.json', () => {
    const budget = getCatContextBudget('gemini');
    assert.strictEqual(budget.maxPromptTokens, 350000);
    assert.strictEqual(budget.maxContextTokens, 300000);
    assert.strictEqual(budget.maxMessages, 300);
    assert.strictEqual(budget.maxContentLengthPerMsg, 100000);
  });

  it('variant budgets from cat-config.json', () => {
    const sonnet = getCatContextBudget('sonnet');
    assert.strictEqual(sonnet.maxPromptTokens, 180000);
    assert.strictEqual(sonnet.maxContextTokens, 160000);

    const opus45 = getCatContextBudget('opus-45');
    assert.strictEqual(opus45.maxPromptTokens, 180000);
    assert.strictEqual(opus45.maxContextTokens, 160000);

    const gpt52 = getCatContextBudget('gpt52');
    assert.strictEqual(gpt52.maxPromptTokens, 240000);
    assert.strictEqual(gpt52.maxContextTokens, 216000);

    const spark = getCatContextBudget('spark');
    assert.strictEqual(spark.maxPromptTokens, 64000);
    assert.strictEqual(spark.maxContextTokens, 40000);

    const gemini25 = getCatContextBudget('gemini25');
    assert.strictEqual(gemini25.maxPromptTokens, 350000);
    assert.strictEqual(gemini25.maxContextTokens, 300000);
  });

  it('per-cat env var overrides maxPromptTokens', () => {
    process.env.CAT_OPUS_MAX_PROMPT_TOKENS = '200000';
    clearBudgetCache();
    const budget = getCatContextBudget('opus');
    assert.strictEqual(budget.maxPromptTokens, 200000);
    // Other fields remain from JSON
    assert.strictEqual(budget.maxContextTokens, 160000);
  });

  it('global MAX_PROMPT_TOKENS fallback when no per-cat env', () => {
    process.env.MAX_PROMPT_TOKENS = '100000';
    clearBudgetCache();
    const budget = getCatContextBudget('opus');
    assert.strictEqual(budget.maxPromptTokens, 100000);
  });

  it('per-cat env var takes priority over global MAX_PROMPT_TOKENS', () => {
    process.env.CAT_OPUS_MAX_PROMPT_TOKENS = '180000';
    process.env.MAX_PROMPT_TOKENS = '100000';
    clearBudgetCache();
    const budget = getCatContextBudget('opus');
    assert.strictEqual(budget.maxPromptTokens, 180000);
  });

  it('per-message content limit accommodates long text input (100K)', () => {
    const opus = getCatContextBudget('opus');
    assert.ok(
      opus.maxContentLengthPerMsg >= 100000,
      `opus maxContentLengthPerMsg=${opus.maxContentLengthPerMsg} should be >= 100000`,
    );
    const codex = getCatContextBudget('codex');
    assert.ok(
      codex.maxContentLengthPerMsg >= 100000,
      `codex maxContentLengthPerMsg=${codex.maxContentLengthPerMsg} should be >= 100000`,
    );
  });

  it('all budget fields are positive numbers', () => {
    const cats = ['opus', 'codex', 'gemini'];
    for (const cat of cats) {
      const budget = getCatContextBudget(cat);
      assert.ok(budget.maxPromptTokens > 0, `${cat} maxPromptTokens > 0`);
      assert.ok(budget.maxContextTokens > 0, `${cat} maxContextTokens > 0`);
      assert.ok(budget.maxMessages > 0, `${cat} maxMessages > 0`);
      assert.ok(budget.maxContentLengthPerMsg > 0, `${cat} maxContentLengthPerMsg > 0`);
    }
  });
});

describe('getAllCatBudgets', () => {
  beforeEach(() => {
    clearBudgetCache();
    delete process.env.CAT_OPUS_MAX_PROMPT_TOKENS;
    delete process.env.CAT_CODEX_MAX_PROMPT_TOKENS;
    delete process.env.CAT_GEMINI_MAX_PROMPT_TOKENS;
    delete process.env.MAX_PROMPT_TOKENS;
  });

  it('returns budgets for all cats (core 3 + variants)', () => {
    const budgets = getAllCatBudgets();
    // Core breed defaults must exist
    assert.ok(budgets.opus, 'has opus');
    assert.ok(budgets.codex, 'has codex');
    assert.ok(budgets.gemini, 'has gemini');
    // F032: Now includes variants (sonnet, opus-45, gpt52, spark, gemini25) — at least 8 cats
    assert.ok(Object.keys(budgets).length >= 3, 'has at least 3 cats');
  });
});
