import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('computeRecencyDecay', () => {
  let computeRecencyDecay;

  it('loads module', async () => {
    const mod = await import(`../../dist/domains/memory/recency-decay.js?v=${Date.now()}`);
    computeRecencyDecay = mod.computeRecencyDecay;
    assert.ok(computeRecencyDecay);
  });

  it('constitutional doc (adr): no decay regardless of age', () => {
    const r = computeRecencyDecay(365, 'adr');
    assert.equal(r.factor, 1.0);
    assert.equal(r.halfLife, null);
  });

  it('feature doc (T=90): 90d old → factor 0.5', () => {
    const r = computeRecencyDecay(90, 'feature');
    assert.equal(r.factor, 0.5);
    assert.equal(r.halfLife, 90);
  });

  it('thread doc (T=14): 14d old → factor 0.5', () => {
    const r = computeRecencyDecay(14, 'thread');
    assert.equal(r.factor, 0.5);
    assert.equal(r.halfLife, 14);
  });

  it('365d old feature doc: fractional long tail ≈ 0.198', () => {
    const r = computeRecencyDecay(365, 'feature');
    assert.ok(Math.abs(r.factor - 90 / (90 + 365)) < 0.001, `expected ~${90 / 455}, got ${r.factor}`);
  });

  it('0d old doc: factor = 1.0', () => {
    const r = computeRecencyDecay(0, 'discussion');
    assert.equal(r.factor, 1.0);
  });

  it('unknown kind defaults to T=45', () => {
    const r = computeRecencyDecay(45, 'some-unknown');
    assert.equal(r.factor, 0.5);
    assert.equal(r.halfLife, 45);
  });

  it('lesson doc: constitutional, no decay', () => {
    const r = computeRecencyDecay(1000, 'lesson');
    assert.equal(r.factor, 1.0);
  });
});
