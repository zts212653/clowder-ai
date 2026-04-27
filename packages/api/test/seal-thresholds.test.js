/**
 * Seal Threshold Config + shouldSeal() Tests
 * F24 Phase B: Per-cat seal threshold configuration.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('seal-thresholds', () => {
  async function loadModule() {
    // F33 Phase 2: seal-thresholds.ts merged into session-strategy.ts
    return import('../dist/config/session-strategy.js');
  }

  describe('getSealConfig()', () => {
    test('opus: warnThreshold=0.80, sealThreshold=0.90', async () => {
      const { getSealConfig } = await loadModule();
      const config = getSealConfig('opus');
      assert.equal(config.warnThreshold, 0.8);
      assert.equal(config.sealThreshold, 0.9);
      assert.equal(config.turnBudget, 12_000);
      assert.equal(config.safetyMargin, 4_000);
    });

    test('codex: warnThreshold=0.75, sealThreshold=0.85', async () => {
      const { getSealConfig } = await loadModule();
      const config = getSealConfig('codex');
      assert.equal(config.warnThreshold, 0.75);
      assert.equal(config.sealThreshold, 0.85);
    });

    test('gemini: warnThreshold=0.55, sealThreshold=0.65', async () => {
      const { getSealConfig } = await loadModule();
      const config = getSealConfig('gemini');
      assert.equal(config.warnThreshold, 0.55);
      assert.equal(config.sealThreshold, 0.65);
    });
  });

  describe('shouldSeal()', () => {
    test('returns true when fillRatio >= sealThreshold', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('opus');
      assert.equal(shouldSeal(0.91, 200_000, 182_000, config), true);
    });

    test('returns true when fillRatio == sealThreshold (boundary)', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('opus');
      assert.equal(shouldSeal(0.9, 200_000, 180_000, config), true);
    });

    test('returns false when fillRatio below threshold and enough remaining', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('opus');
      // 80% = 160k used, 40k remaining > 16k (turnBudget + safetyMargin)
      assert.equal(shouldSeal(0.8, 200_000, 160_000, config), false);
    });

    test('returns true when remaining < turnBudget + safetyMargin', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('opus');
      // 185k used, 15k remaining < 16k (12k + 4k)
      assert.equal(shouldSeal(0.89, 200_000, 185_000, config), true);
    });

    test('returns false when just above turnBudget + safetyMargin', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('opus');
      // 183k used, 17k remaining > 16k
      assert.equal(shouldSeal(0.89, 200_000, 183_000, config), false);
    });

    test('works with codex thresholds (lower seal point)', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('codex');
      // 128k window, 85% = 108.8k
      assert.equal(shouldSeal(0.85, 128_000, 108_800, config), true);
      assert.equal(shouldSeal(0.84, 128_000, 107_520, config), false);
    });

    test('works with gemini thresholds (low seal point)', async () => {
      const { shouldSeal, getSealConfig } = await loadModule();
      const config = getSealConfig('gemini');
      // 1M window, 65% = 650k
      assert.equal(shouldSeal(0.65, 1_000_000, 650_000, config), true);
      assert.equal(shouldSeal(0.6, 1_000_000, 600_000, config), false);
    });
  });
});
