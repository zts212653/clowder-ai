import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateCostFromTokens, getModelPricing } from '../../dist/config/model-pricing.js';

describe('model-pricing', () => {
  describe('getModelPricing', () => {
    it('returns pricing for known models', () => {
      const pricing = getModelPricing('gpt-5.3-codex');
      assert.ok(pricing);
      assert.equal(pricing.inputPerMillion, 1.75);
      assert.equal(pricing.cachedInputPerMillion, 0.175);
      assert.equal(pricing.outputPerMillion, 14.0);
    });

    it('returns undefined for unknown models', () => {
      assert.equal(getModelPricing('unknown-model-xyz'), undefined);
    });

    it('covers all expected Codex variants including long-context', () => {
      for (const model of [
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-long',
        'gpt-5.5',
        'gpt-5.5-long',
      ]) {
        assert.ok(getModelPricing(model), `missing pricing for ${model}`);
      }
    });

    it('long-context variants have higher rates than standard', () => {
      const std54 = getModelPricing('gpt-5.4');
      const long54 = getModelPricing('gpt-5.4-long');
      assert.ok(std54 && long54);
      assert.ok(long54.inputPerMillion > std54.inputPerMillion, 'long-context input should be more expensive');
      assert.ok(long54.outputPerMillion > std54.outputPerMillion, 'long-context output should be more expensive');
    });
  });

  describe('estimateCostFromTokens', () => {
    it('calculates cost for gpt-5.3-codex with no cache', () => {
      // 100k input × $1.75/M + 5k output × $14/M = $0.175 + $0.07 = $0.245
      const cost = estimateCostFromTokens('gpt-5.3-codex', 100_000, 5_000);
      assert.equal(cost, 0.245);
    });

    it('splits cached vs fresh input tokens', () => {
      // 100k total input, 80k cached, 20k fresh
      // freshInput: 20k × $1.75/M = $0.035
      // cached: 80k × $0.175/M = $0.014
      // output: 5k × $14/M = $0.07
      // total = $0.119
      const cost = estimateCostFromTokens('gpt-5.3-codex', 100_000, 5_000, 80_000);
      assert.equal(cost, 0.119);
    });

    it('returns null for unknown model', () => {
      const cost = estimateCostFromTokens('unknown-model', 100_000, 5_000);
      assert.equal(cost, null);
    });

    it('handles zero tokens', () => {
      const cost = estimateCostFromTokens('gpt-5.3-codex', 0, 0);
      assert.equal(cost, 0);
    });

    it('handles cacheReadTokens > inputTokens gracefully', () => {
      // Edge case: cacheReadTokens reported higher than inputTokens
      // freshInput should clamp to 0
      const cost = estimateCostFromTokens('gpt-5.3-codex', 50_000, 1_000, 80_000);
      assert.ok(cost != null);
      assert.ok(cost >= 0, 'cost should never be negative');
      // cached: 80k × $0.175/M = $0.014; output: 1k × $14/M = $0.014; fresh: 0
      assert.equal(cost, 0.028);
    });

    it('calculates correctly for gpt-5.5 (most expensive)', () => {
      // 200k input × $5/M + 10k output × $30/M = $1.0 + $0.3 = $1.3
      const cost = estimateCostFromTokens('gpt-5.5', 200_000, 10_000);
      assert.equal(cost, 1.3);
    });

    it('rounds to 6 decimal places', () => {
      // Verify no floating-point noise
      const cost = estimateCostFromTokens('gpt-5.3-codex', 1, 1);
      assert.ok(cost != null);
      const decimals = cost.toString().split('.')[1]?.length ?? 0;
      assert.ok(decimals <= 6, `too many decimals: ${cost}`);
    });
  });
});
