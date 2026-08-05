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

  describe('getMemberWindowCap', () => {
    it('returns undefined when no cat registered', () => {
      assert.equal(mod.getMemberWindowCap('nonexistent'), undefined);
    });

    it('returns undefined when contextWindow not set (Auto mode)', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig());
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), undefined);
    });

    it('returns the configured cap when contextWindow is set (Manual mode)', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 500_000 }));
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), 500_000);
    });

    it('compat-reads legacy cli.contextWindow when top-level absent', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ cli: { command: 'codex', outputFormat: 'json', contextWindow: 256_000 } }),
      );
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), 256_000);
    });

    it('top-level contextWindow takes precedence over cli.contextWindow', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({
          contextWindow: 400_000,
          cli: { command: 'codex', outputFormat: 'json', contextWindow: 256_000 },
        }),
      );
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), 400_000);
    });
  });

  describe('getMemberOutputReserve', () => {
    it('returns a positive number (internal derivation)', () => {
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(typeof reserve, 'number');
      assert.ok(reserve > 0, 'output reserve must be positive');
    });
  });

  describe('resolveContextCapacity', () => {
    it('returns unresolved when no data available', () => {
      const result = mod.resolveContextCapacity({ catId: 'unknown-cat' });
      assert.equal(result.source, 'unresolved');
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 0);
    });

    it('uses CLI-reported window as exact source', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig());
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 1_000_000,
        model: 'claude-opus-4-20250918',
      });
      assert.equal(result.source, 'exact');
      assert.equal(result.actionable, true);
      assert.ok(result.windowTokens > 0);
    });

    it('falls back to model catalog for non-OpenCode providers', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ defaultModel: 'claude-opus-4-6' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6',
        // No provider — direct Claude CLI
      });
      // Model catalog should resolve opus-4-6 to 1M
      assert.equal(result.source, 'catalog');
      assert.equal(result.actionable, true);
      assert.equal(result.windowTokens, 1_000_000);
    });

    it('OpenCode with known model uses catalog, not 128K default', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        provider: 'opencode',
        model: 'claude-opus-4-6', // 1M in catalog
      });
      // Known model catalog value wins over blanket OpenCode default
      assert.equal(result.source, 'catalog');
      assert.equal(result.actionable, true);
      assert.equal(result.windowTokens, 1_000_000);
    });

    it('OpenCode with unknown model falls back to 128K default', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        provider: 'opencode',
        model: 'custom-vendor/mystery-model-v3', // NOT in catalog
      });
      // Unknown model → OpenCode 128K last-resort default
      assert.equal(result.source, 'default');
      assert.equal(result.actionable, true);
      assert.equal(result.windowTokens, 128_000);
    });

    it('OpenCode with known model but manual cap limits to gateway cap', () => {
      // User sets contextWindow=128000 to reflect their OpenCode gateway cap
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({
          clientId: 'opencode',
          contextWindow: 128_000,
        }),
      );
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        provider: 'opencode',
        model: 'claude-opus-4-6', // 1M in catalog
      });
      // Manual cap (128K) limits the catalog value (1M)
      assert.equal(result.actionable, true);
      assert.equal(result.windowTokens, 128_000);
      assert.ok(result.provenance.includes('capped'), 'provenance should mention capping');
    });

    it('OpenCode with CLI-reported window uses exact value', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 200_000,
        provider: 'opencode',
        model: 'claude-opus-4-20250918',
      });
      // CLI-reported always wins over provider default
      assert.equal(result.source, 'exact');
      assert.ok(result.windowTokens >= 200_000);
    });

    it('manual cap limits discovered window', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 1_000_000,
        model: 'claude-opus-4-20250918',
      });
      assert.ok(result.windowTokens <= 200_000, `window ${result.windowTokens} should be <= 200K cap`);
      assert.equal(result.actionable, true);
      assert.ok(result.provenance.includes('capped'), 'provenance should mention capping');
    });

    it('manual cap is sole source when no discovery available', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 300_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        // No reportedWindowSize, no model, no provider
      });
      assert.equal(result.source, 'manual');
      assert.equal(result.windowTokens, 300_000);
      assert.equal(result.actionable, true);
    });

    it('legacy cli.contextWindow works as manual cap', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ cli: { command: 'codex', outputFormat: 'json', contextWindow: 150_000 } }),
      );
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 500_000,
        model: 'some-model',
      });
      assert.ok(result.windowTokens <= 150_000, `legacy cap should limit to 150K, got ${result.windowTokens}`);
    });

    it('inputCeilingTokens is window minus output reserve', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const result = mod.resolveContextCapacity({ catId: TEST_CAT_ID });
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(result.inputCeilingTokens, result.windowTokens - reserve);
    });
  });

  describe('derivePromptAssemblyBudget', () => {
    it('produces sensible limits from input ceiling', () => {
      const budget = mod.derivePromptAssemblyBudget(100_000);
      assert.equal(budget.maxPromptTokens, 100_000);
      assert.ok(budget.maxHistoryContextTokens < 100_000, 'history < total');
      assert.ok(budget.maxHistoryContextTokens > 50_000, 'history reasonable');
      assert.ok(budget.maxMessages >= 50, 'at least 50 messages');
      assert.ok(budget.maxContentLengthPerMsg > 0, 'positive content limit');
    });

    it('scales message count with ceiling', () => {
      const small = mod.derivePromptAssemblyBudget(50_000);
      const large = mod.derivePromptAssemblyBudget(500_000);
      assert.ok(large.maxMessages >= small.maxMessages, 'larger ceiling = more messages');
    });
  });
});
