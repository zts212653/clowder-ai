/**
 * F33: Session Strategy — shouldTakeAction() + getSessionStrategy()
 * Unit tests for the pure strategy decision function.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadModule() {
  return import('../dist/config/session-strategy.js');
}

describe('session-strategy', () => {
  // ── shouldTakeAction() ──

  describe('shouldTakeAction()', () => {
    // Common test config factory
    function makeStrategy(overrides = {}) {
      return {
        strategy: 'handoff',
        thresholds: { warn: 0.75, action: 0.85 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
        ...overrides,
      };
    }

    // -- Budget exhausted --

    describe('budget exhausted', () => {
      test('seals when remaining < turnBudget + safetyMargin (handoff)', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy();
        // 200k window, 185k used → 15k remaining < 16k (12k+4k)
        const action = shouldTakeAction(0.8, 200_000, 185_000, 0, strategy);
        assert.equal(action.type, 'seal');
        assert.equal(action.reason, 'budget_exhausted');
      });

      test('allows compress for compress strategy even when budget exhausted', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'compress' });
        // compress = CLI handles compression, server should not pre-emptively seal
        const action = shouldTakeAction(0.8, 200_000, 185_000, 0, strategy);
        assert.equal(action.type, 'allow_compress');
      });

      test('seals for hybrid strategy when budget exhausted AND max compressions reached', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({
          strategy: 'hybrid',
          hybrid: { maxCompressions: 3 },
        });
        // hybrid with max reached → seal
        const action = shouldTakeAction(0.8, 200_000, 185_000, 3, strategy);
        assert.equal(action.type, 'seal');
        assert.equal(action.reason, 'budget_exhausted');
      });

      test('allows compress for hybrid strategy when budget exhausted but compressions remain', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({
          strategy: 'hybrid',
          hybrid: { maxCompressions: 3 },
        });
        // hybrid with compressions left → allow compress (CLI will free up space)
        const action = shouldTakeAction(0.8, 200_000, 185_000, 1, strategy);
        assert.equal(action.type, 'allow_compress');
      });
    });

    // -- Below action threshold --

    describe('below action threshold', () => {
      test('returns none when fillRatio below warn', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy();
        const action = shouldTakeAction(0.5, 200_000, 100_000, 0, strategy);
        assert.equal(action.type, 'none');
      });

      test('returns warn when fillRatio at warn but below action', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy();
        const action = shouldTakeAction(0.8, 200_000, 160_000, 0, strategy);
        assert.equal(action.type, 'warn');
      });

      test('returns warn at exact warn threshold', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy();
        const action = shouldTakeAction(0.75, 200_000, 150_000, 0, strategy);
        assert.equal(action.type, 'warn');
      });
    });

    // -- handoff strategy --

    describe('handoff strategy', () => {
      test('seals at action threshold', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'handoff' });
        const action = shouldTakeAction(0.85, 200_000, 170_000, 0, strategy);
        assert.equal(action.type, 'seal');
        assert.equal(action.reason, 'threshold');
      });

      test('seals above action threshold', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'handoff' });
        const action = shouldTakeAction(0.91, 200_000, 182_000, 0, strategy);
        assert.equal(action.type, 'seal');
        assert.equal(action.reason, 'threshold');
      });

      test('ignores compressionCount (not relevant for handoff)', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'handoff' });
        const action = shouldTakeAction(0.85, 200_000, 170_000, 5, strategy);
        assert.equal(action.type, 'seal');
        assert.equal(action.reason, 'threshold');
      });
    });

    // -- compress strategy --

    describe('compress strategy', () => {
      test('allows compress at action threshold', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'compress' });
        const action = shouldTakeAction(0.85, 200_000, 170_000, 0, strategy);
        assert.equal(action.type, 'allow_compress');
      });

      test('allows compress above action threshold', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'compress' });
        const action = shouldTakeAction(0.92, 200_000, 184_000, 0, strategy);
        assert.equal(action.type, 'allow_compress');
      });

      test('allows compress regardless of compressionCount', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'compress' });
        const action = shouldTakeAction(0.85, 200_000, 170_000, 10, strategy);
        assert.equal(action.type, 'allow_compress');
      });
    });

    // -- hybrid strategy --

    describe('hybrid strategy', () => {
      function hybridStrategy(maxCompressions = 2) {
        return makeStrategy({
          strategy: 'hybrid',
          hybrid: { maxCompressions },
        });
      }

      test('allows compress when compressionCount < max', async () => {
        const { shouldTakeAction } = await loadModule();
        const action = shouldTakeAction(0.85, 200_000, 170_000, 0, hybridStrategy(2));
        assert.equal(action.type, 'allow_compress');
      });

      test('allows compress at max-1', async () => {
        const { shouldTakeAction } = await loadModule();
        const action = shouldTakeAction(0.85, 200_000, 170_000, 1, hybridStrategy(2));
        assert.equal(action.type, 'allow_compress');
      });

      test('seals after compress when compressionCount == max', async () => {
        const { shouldTakeAction } = await loadModule();
        const action = shouldTakeAction(0.85, 200_000, 170_000, 2, hybridStrategy(2));
        assert.equal(action.type, 'seal_after_compress');
        assert.equal(action.reason, 'max_compressions');
      });

      test('seals after compress when compressionCount > max', async () => {
        const { shouldTakeAction } = await loadModule();
        const action = shouldTakeAction(0.85, 200_000, 170_000, 5, hybridStrategy(2));
        assert.equal(action.type, 'seal_after_compress');
        assert.equal(action.reason, 'max_compressions');
      });

      test('uses default maxCompressions=2 when hybrid config missing', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'hybrid' });
        // No hybrid config → defaults to 2
        const action0 = shouldTakeAction(0.85, 200_000, 170_000, 0, strategy);
        assert.equal(action0.type, 'allow_compress');
        const action2 = shouldTakeAction(0.85, 200_000, 170_000, 2, strategy);
        assert.equal(action2.type, 'seal_after_compress');
      });

      test('maxCompressions=1 allows exactly 1 compression', async () => {
        const { shouldTakeAction } = await loadModule();
        const action0 = shouldTakeAction(0.85, 200_000, 170_000, 0, hybridStrategy(1));
        assert.equal(action0.type, 'allow_compress');
        const action1 = shouldTakeAction(0.85, 200_000, 170_000, 1, hybridStrategy(1));
        assert.equal(action1.type, 'seal_after_compress');
      });
    });

    // -- Edge cases --

    describe('edge cases', () => {
      test('fillRatio exactly at action boundary', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'handoff' });
        const action = shouldTakeAction(0.85, 200_000, 170_000, 0, strategy);
        assert.equal(action.type, 'seal');
      });

      test('fillRatio just below action boundary', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy({ strategy: 'handoff' });
        const action = shouldTakeAction(0.8499, 200_000, 170_000, 0, strategy);
        assert.equal(action.type, 'warn');
      });

      test('remaining exactly at turnBudget + safetyMargin boundary', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy();
        // 200k - 184k = 16k = exactly 12k+4k → NOT exhausted (need strictly less)
        const action = shouldTakeAction(0.8, 200_000, 184_000, 0, strategy);
        assert.equal(action.type, 'warn');
      });

      test('zero window tokens → budget exhausted', async () => {
        const { shouldTakeAction } = await loadModule();
        const strategy = makeStrategy();
        const action = shouldTakeAction(0, 0, 0, 0, strategy);
        assert.equal(action.type, 'seal');
        assert.equal(action.reason, 'budget_exhausted');
      });
    });
  });

  // ── getSessionStrategy() ──

  describe('getSessionStrategy()', () => {
    test('returns anthropic defaults for opus', async () => {
      const { getSessionStrategy } = await loadModule();
      const config = getSessionStrategy('opus');
      assert.equal(config.strategy, 'handoff');
      assert.equal(config.thresholds.warn, 0.8);
      assert.equal(config.thresholds.action, 0.9);
    });

    test('returns openai defaults for codex', async () => {
      const { getSessionStrategy } = await loadModule();
      const config = getSessionStrategy('codex');
      assert.equal(config.strategy, 'handoff');
      assert.equal(config.thresholds.warn, 0.75);
      assert.equal(config.thresholds.action, 0.85);
    });

    test('returns google defaults for gemini', async () => {
      const { getSessionStrategy } = await loadModule();
      const config = getSessionStrategy('gemini');
      assert.equal(config.strategy, 'handoff');
      assert.equal(config.thresholds.warn, 0.55);
      assert.equal(config.thresholds.action, 0.65);
    });

    test('returns global default for unknown cat', async () => {
      const { getSessionStrategy } = await loadModule();
      const config = getSessionStrategy('unknown-cat-42');
      assert.equal(config.strategy, 'handoff');
      assert.equal(config.thresholds.warn, 0.75);
      assert.equal(config.thresholds.action, 0.85);
    });

    test('all strategies have turnBudget and safetyMargin', async () => {
      const { getSessionStrategy } = await loadModule();
      for (const cat of ['opus', 'codex', 'gemini', 'unknown']) {
        const config = getSessionStrategy(cat);
        assert.equal(config.turnBudget, 12_000, `${cat} turnBudget`);
        assert.equal(config.safetyMargin, 4_000, `${cat} safetyMargin`);
      }
    });
  });

  // ── mergeStrategyConfig() ──

  describe('mergeStrategyConfig()', () => {
    function baseConfig() {
      return {
        strategy: 'handoff',
        thresholds: { warn: 0.75, action: 0.85 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
      };
    }

    test('partial thresholds override preserves other threshold fields', async () => {
      const { mergeStrategyConfig } = await loadModule();
      const merged = mergeStrategyConfig(baseConfig(), {
        thresholds: { action: 0.88 },
      });
      assert.equal(merged.thresholds.action, 0.88);
      assert.equal(merged.thresholds.warn, 0.75, 'warn should be preserved');
    });

    test('strategy override replaces strategy', async () => {
      const { mergeStrategyConfig } = await loadModule();
      const merged = mergeStrategyConfig(baseConfig(), {
        strategy: 'hybrid',
        hybrid: { maxCompressions: 1 },
      });
      assert.equal(merged.strategy, 'hybrid');
      assert.equal(merged.hybrid.maxCompressions, 1);
      assert.equal(merged.thresholds.warn, 0.75, 'thresholds preserved');
    });

    test('turnBudget override preserves other top-level fields', async () => {
      const { mergeStrategyConfig } = await loadModule();
      const merged = mergeStrategyConfig(baseConfig(), {
        turnBudget: 20_000,
      });
      assert.equal(merged.turnBudget, 20_000);
      assert.equal(merged.safetyMargin, 4_000, 'safetyMargin preserved');
      assert.equal(merged.strategy, 'handoff', 'strategy preserved');
    });

    test('empty override returns base unchanged', async () => {
      const { mergeStrategyConfig } = await loadModule();
      const base = baseConfig();
      const merged = mergeStrategyConfig(base, {});
      assert.deepStrictEqual(merged.thresholds, base.thresholds);
      assert.equal(merged.strategy, base.strategy);
    });
  });

  // Phase 2 tests (backward compat + config override) → session-strategy-phase2.test.js
});
