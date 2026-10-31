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

    it('covers Kimi aliases reported by the client plus raw API ids', () => {
      // clowder-ai#1197: keys must match metadata.model as reported by the
      // client — OAuth aliases (kimi-code/*) and API-key pass-through ids.
      for (const model of [
        'kimi-code/k3',
        'kimi-code/k3-256k',
        'kimi-code/kimi-for-coding',
        'kimi-code/kimi-for-coding-highspeed',
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.6',
      ]) {
        const pricing = getModelPricing(model);
        assert.ok(pricing, `missing pricing for ${model}`);
        assert.ok(pricing.source, `missing source url for ${model}`);
        assert.ok(pricing.verifiedAt, `missing verification date for ${model}`);
      }
    });

    it('maps kimi-for-coding alias to the Kimi K2.7 Code price card', () => {
      const alias = getModelPricing('kimi-code/kimi-for-coding');
      const raw = getModelPricing('kimi-k2.7-code');
      assert.ok(alias && raw);
      assert.equal(alias.inputPerMillion, raw.inputPerMillion);
      assert.equal(alias.cachedInputPerMillion, raw.cachedInputPerMillion);
      assert.equal(alias.outputPerMillion, raw.outputPerMillion);
    });

    it('returns undefined for unverified Kimi aliases (no guessing)', () => {
      assert.equal(getModelPricing('kimi-code/kimi-for-coding-v1'), undefined);
      assert.equal(getModelPricing('kimi-code/unknown-future-alias'), undefined);
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

    it('calculates Kimi K3 cost with cache split', () => {
      // 1M total input, 500k cached, 500k fresh; 100k output
      // fresh: 500k × $3.00/M = $1.50
      // cached: 500k × $0.30/M = $0.15
      // output: 100k × $15.00/M = $1.50
      // total = $3.15
      const cost = estimateCostFromTokens('kimi-code/k3', 1_000_000, 100_000, 500_000);
      assert.equal(cost, 3.15);
    });

    it('calculates Kimi K2.7 Code (kimi-for-coding) cost with no cache', () => {
      // 200k input × $0.95/M + 50k output × $4.00/M = $0.19 + $0.2 = $0.39
      const cost = estimateCostFromTokens('kimi-code/kimi-for-coding', 200_000, 50_000);
      assert.equal(cost, 0.39);
    });

    it('returns null for unverified Kimi alias', () => {
      const cost = estimateCostFromTokens('kimi-code/kimi-for-coding-v1', 100_000, 5_000);
      assert.equal(cost, null);
    });
  });
});
