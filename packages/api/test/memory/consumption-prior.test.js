import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('computeConsumptionPrior', () => {
  let computeConsumptionPrior;

  it('loads module', async () => {
    const mod = await import(`../../dist/domains/memory/consumption-prior.js?v=${Date.now()}`);
    computeConsumptionPrior = mod.computeConsumptionPrior;
    assert.ok(computeConsumptionPrior);
  });

  it('cold-start: exposure < 5 returns prior=0', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 2,
        exposureCount30d: 3,
        daysSinceLastConsumed: 1,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: Date.now() - 30 * 86_400_000,
      },
      { feature: 0.2 },
    );
    assert.equal(result.prior, 0);
    assert.equal(result.branch, 'cold-start');
  });

  it('low-sample: exposure 5-19 clamps to max(0, rawLift)', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 0,
        exposureCount30d: 10,
        daysSinceLastConsumed: null,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: Date.now() - 30 * 86_400_000,
      },
      { feature: 0.2 },
    );
    assert.equal(result.branch, 'low-sample');
    assert.ok(result.prior >= 0, 'low-sample should clamp negative to 0');
  });

  it('full-data: exposure >= 20 allows negative prior (centered lift)', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 1,
        exposureCount30d: 30,
        daysSinceLastConsumed: 5,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: Date.now() - 30 * 86_400_000,
      },
      { feature: 0.2 },
    );
    assert.equal(result.branch, 'full');
    // shrunk_ctr = (1+2)/(30+10) = 0.075, mean=0.2, lift negative
    assert.ok(result.prior < 0, `below-average CTR should produce negative prior, got ${result.prior}`);
  });

  it('full-data: above-average CTR produces positive prior', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 15,
        exposureCount30d: 25,
        daysSinceLastConsumed: 2,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: Date.now() - 30 * 86_400_000,
      },
      { feature: 0.2 },
    );
    assert.equal(result.branch, 'full');
    // shrunk_ctr = (15+2)/(25+10) = 0.486, mean=0.2 → positive lift
    assert.ok(result.prior > 0, `above-average CTR should produce positive prior, got ${result.prior}`);
  });

  it('constitutional anchor: always max(0, rawLift) regardless of exposure', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 0,
        exposureCount30d: 50,
        daysSinceLastConsumed: 90,
        docKind: 'decision',
        authority: 'constitutional',
        firstIndexedAt: Date.now() - 60 * 86_400_000,
      },
      { decision: 0.3 },
    );
    assert.equal(result.branch, 'constitutional');
    assert.ok(result.prior >= 0, 'constitutional should never have negative prior');
  });

  it('decision docKind is constitutional regardless of authority (R2-P5)', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 0,
        exposureCount30d: 40,
        daysSinceLastConsumed: 60,
        docKind: 'decision',
        authority: 'validated',
        firstIndexedAt: Date.now() - 60 * 86_400_000,
      },
      { decision: 0.3 },
    );
    assert.equal(result.branch, 'constitutional');
    assert.ok(result.prior >= 0);
  });

  it('lesson docKind is constitutional regardless of authority', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 0,
        exposureCount30d: 40,
        daysSinceLastConsumed: 60,
        docKind: 'lesson',
        authority: 'validated',
        firstIndexedAt: Date.now() - 60 * 86_400_000,
      },
      { lesson: 0.3 },
    );
    assert.equal(result.branch, 'constitutional');
    assert.ok(result.prior >= 0);
  });

  it('validated + feature docKind is NOT constitutional (P1-1 fix)', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 0,
        exposureCount30d: 40,
        daysSinceLastConsumed: 60,
        docKind: 'feature',
        authority: 'validated',
        firstIndexedAt: Date.now() - 60 * 86_400_000,
      },
      { feature: 0.3 },
    );
    assert.notEqual(result.branch, 'constitutional', 'validated+feature should NOT be constitutional');
  });

  it('grace period: first_indexed < 14d ago returns prior=0', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 10,
        exposureCount30d: 20,
        daysSinceLastConsumed: 1,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: Date.now() - 5 * 86_400_000, // 5 days ago
      },
      { feature: 0.2 },
    );
    assert.equal(result.prior, 0);
    assert.equal(result.branch, 'cold-start');
  });

  it('no grace period for firstIndexedAt=0 (pre-existing docs)', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 10,
        exposureCount30d: 25,
        daysSinceLastConsumed: 1,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: 0,
      },
      { feature: 0.2 },
    );
    assert.notEqual(result.branch, 'cold-start');
    assert.ok(result.prior > 0);
  });

  it('unknown docKind defaults to half_life=45', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 8,
        exposureCount30d: 25,
        daysSinceLastConsumed: 45,
        docKind: 'unknown-kind',
        authority: 'observed',
        firstIndexedAt: 0,
      },
      {},
    );
    // With T=45, daysSince=45 → recencyFactor = 45/(45+45) = 0.5
    assert.ok(Math.abs(result.recencyFactor - 0.5) < 0.01, `expected recencyFactor ~0.5, got ${result.recencyFactor}`);
  });

  it('null daysSinceLastConsumed defaults to recencyFactor=0.5', () => {
    const result = computeConsumptionPrior(
      {
        consumedCount30d: 10,
        exposureCount30d: 25,
        daysSinceLastConsumed: null,
        docKind: 'feature',
        authority: 'observed',
        firstIndexedAt: 0,
      },
      { feature: 0.2 },
    );
    assert.equal(result.recencyFactor, 0.5);
  });
});
