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
    assert.equal(getContextWindowFallback('MiniMax-M3'), 1_000_000);
    assert.equal(getContextWindowFallback('minimax-m3'), 1_000_000);
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
    assert.equal(getContextWindowFallback('minimax/MiniMax-M3'), 1_000_000);
    assert.equal(getContextWindowFallback('minimax/minimax-m3'), 1_000_000);
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

// F24 known-min floor: stale CLI window reports (e.g. CLI 2.1.177 reporting
// 200K for claude-fable-5, natively 1M) outrank the fallback table, so the
// table alone can't correct them. Floors are applied as max(reported, floor).
// Production evidence: sessions 59a48070/6b8d4b5f consumed 303K/307K input
// tokens in a single turn while windowTokens claimed 200000 → premature
// budget_exhausted seal with 80% of the real window unused.
describe('getKnownMinContextWindow / resolveContextWindow', () => {
  let getContextWindowFallback;
  let getKnownMinContextWindow;
  let resolveContextWindow;

  test('setup', async () => {
    const mod = await import('../dist/config/context-window-sizes.js');
    getContextWindowFallback = mod.getContextWindowFallback;
    getKnownMinContextWindow = mod.getKnownMinContextWindow;
    resolveContextWindow = mod.resolveContextWindow;
  });

  test('knows claude-fable-5 native 1M window (exact, versioned, provider-prefixed)', async () => {
    assert.equal(getKnownMinContextWindow('claude-fable-5'), 1_000_000);
    assert.equal(getKnownMinContextWindow('claude-fable-5-20260601'), 1_000_000);
    assert.equal(getKnownMinContextWindow('anthropic/claude-fable-5'), 1_000_000);
  });

  test('treats the CLI [1m] directive as a 1M floor', async () => {
    assert.equal(getKnownMinContextWindow('claude-opus-4-6[1m]'), 1_000_000);
    assert.equal(getKnownMinContextWindow('claude-opus-4-8[1m]'), 1_000_000);
    assert.equal(getKnownMinContextWindow('claude-sonnet-4-6[1m]'), 1_000_000);
  });

  test('returns undefined when no authoritative floor is known', async () => {
    assert.equal(getKnownMinContextWindow('claude-opus-4-6'), undefined);
    assert.equal(getKnownMinContextWindow('claude-sonnet-4-5'), undefined);
    assert.equal(getKnownMinContextWindow('gpt-5.3'), undefined);
    assert.equal(getKnownMinContextWindow(''), undefined);
  });

  test('fallback table gained claude-fable-5 (non-Claude-CLI provider paths)', async () => {
    assert.equal(getContextWindowFallback('claude-fable-5'), 1_000_000);
  });

  test('resolveContextWindow corrects a stale CLI report upward (the fable-5 seal bug)', async () => {
    assert.equal(resolveContextWindow(200_000, 'claude-fable-5'), 1_000_000);
    assert.equal(resolveContextWindow(200_000, 'claude-opus-4-8[1m]'), 1_000_000);
  });

  test('resolveContextWindow never shrinks a CLI report', async () => {
    // CLI catches up → floor is a no-op
    assert.equal(resolveContextWindow(1_000_000, 'claude-fable-5'), 1_000_000);
    // window grows beyond our floor → trust the CLI
    assert.equal(resolveContextWindow(2_000_000, 'claude-fable-5'), 2_000_000);
    // no floor known → passthrough
    assert.equal(resolveContextWindow(200_000, 'claude-opus-4-6'), 200_000);
  });

  test('resolveContextWindow falls back to the table; floor still applies', async () => {
    assert.equal(resolveContextWindow(undefined, 'claude-opus-4-6'), 200_000);
    // Without the floor, the [1m] form would prefix-match to the bare
    // model's 200K table entry — the floor corrects it to 1M.
    assert.equal(resolveContextWindow(undefined, 'claude-opus-4-6[1m]'), 1_000_000);
    assert.equal(resolveContextWindow(undefined, 'claude-fable-5'), 1_000_000);
    assert.equal(resolveContextWindow(undefined, 'unknown-model'), undefined);
  });
});
