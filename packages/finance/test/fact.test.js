import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFinanceFact, createSnapshotId, QueryFrequencyTracker } from '../dist/index.js';

describe('finance fact envelope', () => {
  it('creates stable snapshot ids independent of object key order', () => {
    const left = createSnapshotId({
      provider: 'ttfund',
      source: 'FUND_SEARCH',
      asOf: '2026-06-03',
      query: { search_type: 'fund', query: '沪深300' },
      data: { b: 2, a: 1 },
    });
    const right = createSnapshotId({
      provider: 'ttfund',
      source: 'FUND_SEARCH',
      asOf: '2026-06-03',
      query: { query: '沪深300', search_type: 'fund' },
      data: { a: 1, b: 2 },
    });

    assert.equal(left, right);
    assert.match(left, /^fin_[a-f0-9]{24}$/);
  });

  it('normalizes source metadata, presentation hints, and query frequency', () => {
    const tracker = new QueryFrequencyTracker({
      now: () => new Date('2026-06-03T10:00:00.000Z'),
    });
    tracker.record('fund:000001', new Date('2026-05-30T10:00:00.000Z'));
    tracker.record('fund:000001', new Date('2026-06-02T10:00:00.000Z'));

    const fact = createFinanceFact({
      provider: 'ttfund',
      source: 'FUND_NAV_INFO',
      sourceTier: 'official-gateway',
      asOf: '2026-06-03',
      fetchedAt: '2026-06-03T10:00:00.000Z',
      confidence: 'high',
      query: { symbol: 'fund:000001' },
      data: { nav: 1.234 },
      frequencyTracker: tracker,
      frequencyKey: 'fund:000001',
    });

    assert.equal(fact.source, 'FUND_NAV_INFO');
    assert.equal(fact.sourceTier, 'official-gateway');
    assert.equal(fact.confidence, 'high');
    assert.equal(fact.queriesInLast7Days, 3);
    assert.deepEqual(fact.presentationHint, {
      detailLevel: 'compact',
      compactSummary: true,
      avoidWords: ['紧急', '立刻', '马上买', '马上卖'],
    });
    assert.equal(fact.query.symbol, 'fund:000001');
    assert.equal(fact.data.nav, 1.234);
  });
});
