/**
 * F33 Phase 2: Session Strategy — backward compat + config override priority
 * Split from session-strategy.test.js to stay under 350 lines.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadStrategyModule() {
  return import('../dist/config/session-strategy.js');
}

async function loadConfigModule() {
  return import('../dist/config/cat-config-loader.js');
}

describe('session-strategy Phase 2', () => {
  // ── getSealConfig backward compat ──

  describe('getSealConfig() backward compat', () => {
    test('returns ContextHealthConfig with sealThreshold mapped from action', async () => {
      const { getSealConfig } = await loadStrategyModule();
      const config = getSealConfig('opus');
      assert.equal(typeof config.warnThreshold, 'number');
      assert.equal(typeof config.sealThreshold, 'number');
      assert.equal(config.sealThreshold, 0.9);
      assert.equal(config.warnThreshold, 0.8);
      assert.equal(config.turnBudget, 12_000);
      assert.equal(config.safetyMargin, 4_000);
    });

    test('codex getSealConfig matches strategy thresholds', async () => {
      const { getSealConfig } = await loadStrategyModule();
      const config = getSealConfig('codex');
      assert.equal(config.sealThreshold, 0.85);
      assert.equal(config.warnThreshold, 0.75);
    });
  });

  // ── shouldSeal backward compat ──

  describe('shouldSeal() backward compat', () => {
    test('returns true when fillRatio >= sealThreshold', async () => {
      const { shouldSeal, getSealConfig } = await loadStrategyModule();
      const config = getSealConfig('opus');
      assert.equal(shouldSeal(0.91, 200_000, 182_000, config), true);
    });

    test('returns false when below threshold with enough remaining', async () => {
      const { shouldSeal, getSealConfig } = await loadStrategyModule();
      const config = getSealConfig('opus');
      assert.equal(shouldSeal(0.8, 200_000, 160_000, config), false);
    });
  });

  // ── Config override priority (getConfigSessionStrategy) ──

  describe('config override priority (getConfigSessionStrategy)', () => {
    // Minimal mock CatCafeConfig with sessionStrategy configured
    function mockConfig(sessionStrategy) {
      return {
        version: 1,
        breeds: [
          {
            id: 'test-breed',
            catId: 'test-cat',
            name: 'Test Cat',
            displayName: 'Test Cat',
            avatar: '🐱',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@test-cat'],
            roleDescription: 'test',
            defaultVariantId: 'default-variant',
            variants: [
              {
                id: 'default-variant',
                provider: 'anthropic',
                defaultModel: 'test-model',
                mcpSupport: false,
                cli: { command: 'echo', outputFormat: 'json' },
              },
              {
                id: 'alt-variant',
                catId: 'test-alt',
                provider: 'anthropic',
                defaultModel: 'test-model-alt',
                mcpSupport: false,
                cli: { command: 'echo', outputFormat: 'json' },
              },
            ],
            features: { sessionStrategy },
          },
        ],
      };
    }

    test('returns sessionStrategy for breed catId', async () => {
      const { getConfigSessionStrategy } = await loadConfigModule();
      const config = mockConfig({
        strategy: 'hybrid',
        thresholds: { warn: 0.7, action: 0.8 },
        hybrid: { maxCompressions: 3 },
      });
      const result = getConfigSessionStrategy('test-cat', config);
      assert.ok(result);
      assert.equal(result.strategy, 'hybrid');
      assert.equal(result.thresholds.warn, 0.7);
      assert.equal(result.thresholds.action, 0.8);
      assert.equal(result.hybrid.maxCompressions, 3);
    });

    test('returns sessionStrategy for variant catId', async () => {
      const { getConfigSessionStrategy } = await loadConfigModule();
      const config = mockConfig({
        strategy: 'compress',
        compress: { trackPostCompression: true },
      });
      // 'test-alt' is the variant catId, should resolve to parent breed features
      const result = getConfigSessionStrategy('test-alt', config);
      assert.ok(result);
      assert.equal(result.strategy, 'compress');
      assert.equal(result.compress.trackPostCompression, true);
    });

    test('returns undefined for unknown catId', async () => {
      const { getConfigSessionStrategy } = await loadConfigModule();
      const config = mockConfig({ strategy: 'handoff' });
      const result = getConfigSessionStrategy('nonexistent-cat', config);
      assert.equal(result, undefined);
    });

    test('returns undefined when features.sessionStrategy not configured', async () => {
      const { getConfigSessionStrategy } = await loadConfigModule();
      // Config without sessionStrategy
      const config = {
        version: 1,
        breeds: [
          {
            id: 'plain-breed',
            catId: 'plain-cat',
            name: 'Plain',
            displayName: 'Plain',
            avatar: '🐱',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@plain-cat'],
            roleDescription: 'test',
            defaultVariantId: 'v1',
            variants: [
              {
                id: 'v1',
                provider: 'anthropic',
                defaultModel: 'm',
                mcpSupport: false,
                cli: { command: 'echo', outputFormat: 'json' },
              },
            ],
            features: { sessionChain: true },
          },
        ],
      };
      const result = getConfigSessionStrategy('plain-cat', config);
      assert.equal(result, undefined);
    });

    test('config override merges with provider base (priority chain)', async () => {
      const { mergeStrategyConfig } = await loadStrategyModule();
      // Simulate: anthropic base (warn=0.8, action=0.9) + config override (action=0.88 only)
      const anthropicBase = {
        strategy: 'handoff',
        thresholds: { warn: 0.8, action: 0.9 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
      };
      const configOverride = {
        thresholds: { action: 0.88 },
      };
      const merged = mergeStrategyConfig(anthropicBase, configOverride);
      // Config override's action wins, base's warn preserved
      assert.equal(merged.thresholds.action, 0.88);
      assert.equal(merged.thresholds.warn, 0.8);
      assert.equal(merged.strategy, 'handoff');
    });

    test('config override can change strategy from handoff to hybrid', async () => {
      const { mergeStrategyConfig } = await loadStrategyModule();
      const base = {
        strategy: 'handoff',
        thresholds: { warn: 0.8, action: 0.9 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
      };
      const configOverride = {
        strategy: 'hybrid',
        hybrid: { maxCompressions: 2 },
        turnBudget: 20_000,
      };
      const merged = mergeStrategyConfig(base, configOverride);
      assert.equal(merged.strategy, 'hybrid');
      assert.equal(merged.hybrid.maxCompressions, 2);
      assert.equal(merged.turnBudget, 20_000);
      // Preserved from base
      assert.equal(merged.thresholds.warn, 0.8);
      assert.equal(merged.safetyMargin, 4_000);
    });
  });
});
