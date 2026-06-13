/**
 * Context Window Sizes Fallback Table Tests
 * F24: Hardcoded model → context window mapping.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('getContextWindowFallback', () => {
  let getContextWindowFallback;
  let CONTEXT_WINDOW_SIZES;

  test('setup', async () => {
    const mod = await import('../dist/config/context-window-sizes.js');
    getContextWindowFallback = mod.getContextWindowFallback;
    CONTEXT_WINDOW_SIZES = mod.CONTEXT_WINDOW_SIZES;
  });

  test('returns exact match for known models', async () => {
    assert.equal(getContextWindowFallback('claude-opus-4-6'), 200_000);
    assert.equal(getContextWindowFallback('claude-sonnet-4-5'), 200_000);
    assert.equal(getContextWindowFallback('gpt-5.3'), 128_000);
    assert.equal(getContextWindowFallback('gemini-2.5-pro'), 1_000_000);
    assert.equal(getContextWindowFallback('gemini-3-pro'), 1_000_000);
    assert.equal(getContextWindowFallback('gemini-3.1-pro-preview'), 1_000_000);
  });

  test('returns prefix match for versioned models', async () => {
    assert.equal(getContextWindowFallback('claude-opus-4-6-20260101'), 200_000);
    assert.equal(getContextWindowFallback('gpt-5.3-turbo'), 128_000);
    assert.equal(getContextWindowFallback('gemini-2.5-pro-exp'), 1_000_000);
  });

  test('returns undefined for unknown models', async () => {
    assert.equal(getContextWindowFallback('unknown-model'), undefined);
    assert.equal(getContextWindowFallback(''), undefined);
  });

  // clowder#915 R2 cloud P1: opencode (and any provider routed through
  // CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE in the account routing path) propagates
  // a `safeProvider/model` form as `metadata.model`. Before this fix, those
  // strings missed the table entirely and F24 context_health was silently
  // skipped → handoff bypassed for the production opencode invocation path.
  test('clowder#915: strips provider prefix for account-routing model IDs', async () => {
    // Exact match after strip
    assert.equal(getContextWindowFallback('anthropic/claude-opus-4-6'), 200_000);
    assert.equal(getContextWindowFallback('anthropic/claude-sonnet-4-5'), 200_000);
    assert.equal(getContextWindowFallback('openai-compat/gpt-5.3'), 128_000);
    assert.equal(getContextWindowFallback('openai-compat/gpt-5.1-codex'), 400_000);
    assert.equal(getContextWindowFallback('google/gemini-2.5-pro'), 1_000_000);
    // Prefix match after strip (versioned model behind provider prefix)
    assert.equal(getContextWindowFallback('anthropic/claude-opus-4-6-20260101'), 200_000);
    assert.equal(getContextWindowFallback('openai-compat/gpt-5.3-turbo'), 128_000);
    // Unknown model behind prefix still returns undefined
    assert.equal(getContextWindowFallback('anthropic/unknown-model'), undefined);
  });

  test('clowder#915: handles multi-segment prefix defensively (last segment wins)', async () => {
    // Defensive against hypothetical `provider/subgroup/model` shapes
    assert.equal(getContextWindowFallback('openai-compat/v1/gpt-5.3'), 128_000);
    assert.equal(getContextWindowFallback('anthropic/v1/claude-opus-4-6'), 200_000);
  });

  test('covers all expected model families', async () => {
    const keys = Object.keys(CONTEXT_WINDOW_SIZES);
    // Claude
    assert.ok(keys.some((k) => k.startsWith('claude-opus')));
    assert.ok(keys.some((k) => k.startsWith('claude-sonnet')));
    assert.ok(keys.some((k) => k.startsWith('claude-haiku')));
    // GPT
    assert.ok(keys.some((k) => k.startsWith('gpt-')));
    // Gemini
    assert.ok(keys.some((k) => k.startsWith('gemini-')));
  });

  test('gpt-5.1-codex has 400k window', async () => {
    assert.equal(getContextWindowFallback('gpt-5.1-codex'), 400_000);
  });

  test('o3 model returns correct window', async () => {
    assert.equal(getContextWindowFallback('o3'), 200_000);
  });
});
