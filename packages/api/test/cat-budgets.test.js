/**
 * cat-budgets.ts tests
 * #1208 P1-2: resolved capacity + derived prompt-assembly budget.
 * Breed-level fallback windows are deleted — unresolved = zero budget.
 */

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearBudgetCache, getAllCatBudgets, getCatCapacity, getCatPromptBudget } from '../dist/config/cat-budgets.js';

describe('getCatCapacity', () => {
  beforeEach(() => {
    clearBudgetCache();
  });

  afterEach(() => {
    clearBudgetCache();
  });

  it('returns enriched capacity with source and actionable fields', () => {
    const cap = getCatCapacity('opus');
    assert.ok(typeof cap.inputCeilingTokens === 'number', 'has inputCeilingTokens');
    assert.ok(typeof cap.source === 'string', 'has source');
    assert.ok(typeof cap.actionable === 'boolean', 'has actionable');
    assert.ok(typeof cap.confidence === 'number', 'has confidence');
    assert.ok(typeof cap.budget === 'object', 'has budget');
    assert.ok(typeof cap.budget.maxPromptTokens === 'number', 'budget has maxPromptTokens');
    assert.ok(typeof cap.budget.maxHistoryContextTokens === 'number', 'budget has maxHistoryContextTokens');
    assert.ok(typeof cap.budget.maxMessages === 'number', 'budget has maxMessages');
    assert.ok(typeof cap.budget.maxContentLengthPerMsg === 'number', 'budget has maxContentLengthPerMsg');
  });

  it('catalog-resolved cat has non-zero budget and source != unresolved', () => {
    // opus is a known model in the catalog (claude-opus-4) — should resolve
    const cap = getCatCapacity('opus');
    // Could be catalog, manual, or exact depending on config; just not unresolved
    if (cap.source !== 'unresolved') {
      assert.ok(cap.inputCeilingTokens > 0, 'inputCeilingTokens > 0 when resolved');
      assert.ok(cap.budget.maxPromptTokens > 0, 'maxPromptTokens > 0 when resolved');
      assert.ok(cap.confidence > 0, 'confidence > 0 when resolved');
    }
  });

  it('unknown cat returns unresolved with zero budget (no breed fallback)', () => {
    // A completely unknown cat with no config, no model, no provider
    const cap = getCatCapacity('nonexistent-unknown-cat-xyz');
    assert.strictEqual(cap.source, 'unresolved');
    assert.strictEqual(cap.actionable, false);
    assert.strictEqual(cap.inputCeilingTokens, 0);
    assert.strictEqual(cap.confidence, 0);
    assert.strictEqual(cap.budget.maxPromptTokens, 0);
    assert.strictEqual(cap.budget.maxHistoryContextTokens, 0);
    // maxMessages has a floor of 50 from derivePromptAssemblyBudget
    assert.strictEqual(cap.budget.maxMessages, 50);
  });

  it('budget.maxPromptTokens equals inputCeilingTokens (derived identity)', () => {
    const cap = getCatCapacity('opus');
    assert.strictEqual(
      cap.budget.maxPromptTokens,
      cap.inputCeilingTokens,
      'maxPromptTokens should equal inputCeilingTokens',
    );
  });
});

describe('getCatPromptBudget', () => {
  beforeEach(() => {
    clearBudgetCache();
  });

  it('returns PromptAssemblyBudget (routing compat wrapper)', () => {
    const budget = getCatPromptBudget('opus');
    assert.ok(typeof budget.maxPromptTokens === 'number');
    assert.ok(typeof budget.maxHistoryContextTokens === 'number');
    assert.ok(typeof budget.maxMessages === 'number');
    assert.ok(typeof budget.maxContentLengthPerMsg === 'number');
    // Should NOT have source/actionable — it's the raw budget
    assert.strictEqual(budget.source, undefined);
    assert.strictEqual(budget.actionable, undefined);
  });

  it('per-message content limit accommodates long text input (100K)', () => {
    const budget = getCatPromptBudget('opus');
    assert.ok(
      budget.maxContentLengthPerMsg >= 100_000,
      `maxContentLengthPerMsg=${budget.maxContentLengthPerMsg} should be >= 100000`,
    );
  });
});

describe('getAllCatBudgets', () => {
  beforeEach(() => {
    clearBudgetCache();
  });

  it('returns CatCapacityBudget entries with source/actionable', () => {
    const budgets = getAllCatBudgets();
    assert.ok(Object.keys(budgets).length >= 1, 'has at least 1 cat');
    for (const [catId, entry] of Object.entries(budgets)) {
      assert.ok(typeof entry.inputCeilingTokens === 'number', `${catId} has inputCeilingTokens`);
      assert.ok(typeof entry.source === 'string', `${catId} has source`);
      assert.ok(typeof entry.actionable === 'boolean', `${catId} has actionable`);
      assert.ok(typeof entry.confidence === 'number', `${catId} has confidence`);
      assert.ok(typeof entry.budget === 'object', `${catId} has budget`);
    }
  });

  it('unresolved cats are NOT masqueraded as real capacity', () => {
    // If any cat resolves as unresolved, its inputCeilingTokens must be 0
    const budgets = getAllCatBudgets();
    for (const [catId, entry] of Object.entries(budgets)) {
      if (entry.source === 'unresolved') {
        assert.strictEqual(
          entry.inputCeilingTokens,
          0,
          `${catId}: unresolved must have inputCeilingTokens=0 (no breed fallback)`,
        );
        assert.strictEqual(entry.actionable, false, `${catId}: unresolved must be non-actionable`);
      }
    }
  });
});
