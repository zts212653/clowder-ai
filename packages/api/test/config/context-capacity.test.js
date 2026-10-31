/**
 * context-capacity resolver tests
 * clowder-ai#1208: verify the unified context capacity resolution chain.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const TEST_CAT_ID = 'test-cap-cat';

/** Minimal CatConfig for testing contextWindow resolution. */
function makeCatConfig(overrides = {}) {
  return {
    id: TEST_CAT_ID,
    name: 'test-cap',
    displayName: 'Test Cap Cat',
    avatar: '🐱',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: ['@test-cap'],
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-20250918',
    mcpSupport: false,
    roleDescription: 'test',
    personality: 'test',
    ...overrides,
  };
}

describe('context-capacity resolver', () => {
  let mod;
  let savedConfigs;

  before(async () => {
    mod = await import('../../dist/config/context-capacity.js');
    savedConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
  });

  afterEach(() => {
    catRegistry.reset();
  });

  after(() => {
    for (const [id, config] of Object.entries(savedConfigs)) {
      catRegistry.register(id, config);
    }
  });

  describe('getMemberWindowSetting', () => {
    it('returns undefined when no cat registered', () => {
      assert.equal(mod.getMemberWindowSetting('nonexistent'), undefined);
    });

    it('returns undefined when contextWindow not set (Auto mode)', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig());
      assert.equal(mod.getMemberWindowSetting(TEST_CAT_ID), undefined);
    });

    it('returns the configured window when contextWindow is set (Manual mode)', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 500_000 }));
      assert.equal(mod.getMemberWindowSetting(TEST_CAT_ID), 500_000);
    });

    it('compat-reads legacy cli.contextWindow when top-level absent', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ cli: { command: 'codex', outputFormat: 'json', contextWindow: 256_000 } }),
      );
      assert.equal(mod.getMemberWindowSetting(TEST_CAT_ID), 256_000);
    });

    it('top-level contextWindow takes precedence over cli.contextWindow', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({
          contextWindow: 400_000,
          cli: { command: 'codex', outputFormat: 'json', contextWindow: 256_000 },
        }),
      );
      assert.equal(mod.getMemberWindowSetting(TEST_CAT_ID), 400_000);
    });
  });

  describe('getMemberOutputReserve', () => {
    it('returns a positive number (internal derivation)', () => {
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(typeof reserve, 'number');
      assert.ok(reserve > 0, 'output reserve must be positive');
    });
  });

  // ─── resolveContextCapacity ──────────────────────────────────────

  describe('resolveContextCapacity', () => {
    it('returns unresolved when no data available', () => {
      const result = mod.resolveContextCapacity({ catId: 'unknown-cat' });
      assert.equal(result.source, 'unresolved');
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 0);
      assert.equal('confidence' in result, false);
      assert.equal('bindingKey' in result, false);
      assert.equal('fingerprint' in result, false);
      assert.equal('observedAt' in result, false);
    });

    it('keeps unresolved lifecycle state but gives prompt assembly a conservative non-zero ceiling', () => {
      const result = mod.resolveContextCapacity({ catId: 'unknown-auto-cat', model: 'vendor/unknown-model' });

      assert.equal(result.source, 'unresolved');
      assert.equal(result.actionable, false);
      assert.equal(result.inputCeilingTokens, 0);
      assert.equal(mod.resolvePromptInputCeilingTokens(result), 100_000);
    });

    it('uses CLI-reported window as reported source in Auto mode', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig());
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 1_000_000,
        model: 'claude-opus-4-20250918',
      });
      assert.equal(result.source, 'reported');
      assert.equal(result.actionable, true);
      assert.ok(result.windowTokens > 0);
    });

    it('falls back to model catalog — NOT actionable without a manual setting', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ defaultModel: 'claude-opus-4-6' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6',
      });
      assert.equal(result.source, 'catalog');
      // catalog alone is NOT actionable — must not masquerade as exact
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 1_000_000);
    });

    it('OpenCode with known model uses catalog, not 128K default', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6', // 1M in catalog
      });
      assert.equal(result.source, 'catalog');
      // catalog without a manual setting = NOT actionable
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 1_000_000);
    });

    it('OpenCode with unknown model remains unresolved instead of fabricating 128K', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'custom-vendor/mystery-model-v3', // NOT in catalog
      });
      assert.equal(result.source, 'unresolved');
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 0);
    });

    it('manual value is authoritative even when the catalog has a different value', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({
          clientId: 'opencode',
          contextWindow: 128_000,
        }),
      );
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6', // 1M in catalog
      });
      assert.equal(result.source, 'manual');
      assert.equal(result.actionable, true);
      assert.equal(result.windowTokens, 128_000);
    });

    it('OpenCode with CLI-reported window uses the reported value in Auto mode', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 200_000,
        model: 'claude-opus-4-20250918',
      });
      assert.equal(result.source, 'reported');
      assert.equal(result.actionable, true);
      assert.ok(result.windowTokens >= 200_000);
    });

    it('uses the smaller manual cap when a trusted runtime report is larger', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 128_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 200_000,
        model: 'claude-opus-4-20250918',
      });
      assert.equal(result.source, 'manual');
      assert.equal(result.windowTokens, 128_000);
      assert.equal(result.actionable, true);
    });

    it('uses the smaller trusted runtime limit when the manual value is larger', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 1_000_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 200_000,
        model: 'custom-provider/model-with-runtime-limit',
      });
      assert.equal(result.windowTokens, 200_000);
      assert.equal(result.source, 'reported');
      assert.equal(result.actionable, true);
    });

    it('manual setting is the sole source when no discovery is available', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 300_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
      });
      assert.equal(result.source, 'manual');
      assert.equal(result.windowTokens, 300_000);
      assert.equal(result.actionable, true);
    });

    it('legacy cli.contextWindow works as a manual setting', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ cli: { command: 'codex', outputFormat: 'json', contextWindow: 150_000 } }),
      );
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 500_000,
        model: 'some-model',
      });
      assert.equal(result.windowTokens, 150_000);
      assert.equal(result.source, 'manual');
    });

    it('inputCeilingTokens is window minus output reserve', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const result = mod.resolveContextCapacity({ catId: TEST_CAT_ID });
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(result.inputCeilingTokens, result.windowTokens - reserve);
    });

    it('does not silently clamp an explicit value to the model catalog', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 2_000_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6', // 1M in catalog
      });
      assert.equal(result.source, 'manual');
      assert.equal(result.windowTokens, 2_000_000);
      assert.equal(result.actionable, true);
    });
  });

  describe('retired capacity state', () => {
    it('does not expose session pins, binding fingerprints, or numeric confidence', () => {
      assert.equal('applySessionPin' in mod, false);
      assert.equal('computeBindingFingerprint' in mod, false);
      assert.equal('CONFIDENCE_SCORES' in mod, false);
    });
  });

  describe('legacy four-field prompt budget retirement', () => {
    it('does not export a renamed four-field runtime policy', () => {
      assert.equal('derivePromptAssemblyBudget' in mod, false);
    });
  });

  // ─── #1208 Denominator Fix: fillRatio uses inputCeiling ─────────

  describe('#1208 denominator fix', () => {
    it('fillRatio denominator is inputCeiling (window - output reserve), not raw window', () => {
      // Scenario: 200K manual setting → window=200K, inputCeiling=184K (200K - 16K reserve).
      // usedTokens=160K → fillRatio should be 160K/184K ≈ 0.8696, NOT 160K/200K = 0.8.
      // This matters: at 0.85 action threshold, the old wrong denominator (0.8) says "safe"
      // while the correct denominator (0.87) says "action" → the fix prevents overflow.
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const capacity = mod.resolveContextCapacity({ catId: TEST_CAT_ID });
      const outputReserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(capacity.windowTokens, 200_000);
      assert.equal(capacity.inputCeilingTokens, 200_000 - outputReserve);
      // Verify the correct denominator for fillRatio computation
      const usedTokens = 160_000;
      const correctFillRatio = usedTokens / capacity.inputCeilingTokens;
      const wrongFillRatio = usedTokens / capacity.windowTokens;
      // Correct: 160000/184000 = 0.8696 (above typical 0.85 action threshold)
      assert.ok(
        correctFillRatio > 0.85,
        `correct fillRatio ${correctFillRatio.toFixed(4)} should exceed 0.85 action threshold`,
      );
      // Wrong: 160000/200000 = 0.8 (below 0.85 action threshold → overflow!)
      assert.ok(wrongFillRatio < 0.85, `wrong fillRatio ${wrongFillRatio.toFixed(4)} would miss the threshold`);
    });

    it('inputCeilingTokens equals windowTokens minus output reserve', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 202_752 }));
      const capacity = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'unknown-gateway-model',
      });
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(capacity.inputCeilingTokens, 202_752 - reserve);
      // The input ceiling is the correct denominator for lifecycle decisions
      assert.ok(
        capacity.inputCeilingTokens < capacity.windowTokens,
        'inputCeiling must be strictly less than window (output reserve > 0)',
      );
    });
  });
});
