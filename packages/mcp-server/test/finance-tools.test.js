import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('finance MCP tools', () => {
  it('rejects ttfund mutation-capable skills at the wrapper boundary', async () => {
    const { handleFinanceQuery } = await import('../dist/tools/finance-tools.js');
    const result = await handleFinanceQuery({
      provider: 'ttfund',
      ttfund: {
        skillId: 'MODEL_PORTFOLIO',
        payload: { action: 'bt_create' },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not allowed/i);
  });

  it('returns normalized envelope JSON through injected providers', async () => {
    const { createFinanceQueryHandler } = await import('../dist/tools/finance-tools.js');
    const handler = createFinanceQueryHandler({
      ttfundProvider: {
        query: async () => ({
          snapshot_id: 'fin_test',
          provider: 'ttfund',
          source: 'FUND_SEARCH',
          sourceTier: 'official-gateway',
          asOf: '2026-06-03',
          fetchedAt: '2026-06-03T10:00:00.000Z',
          confidence: 'high',
          query: { skillId: 'FUND_SEARCH' },
          data: { code: 0 },
          presentationHint: { detailLevel: 'compact', compactSummary: true, avoidWords: [] },
          queriesInLast7Days: 1,
        }),
      },
    });

    const result = await handler({
      provider: 'ttfund',
      ttfund: {
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300', search_type: 'fund' },
      },
    });

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.snapshot_id, 'fin_test');
    assert.equal(parsed.sourceTier, 'official-gateway');
  });

  it('derives frequency keys inside the wrapper instead of accepting caller overrides', async () => {
    const { createFinanceQueryHandler } = await import('../dist/tools/finance-tools.js');
    const seen = {};
    const handler = createFinanceQueryHandler({
      ttfundProvider: {
        query: async (request) => {
          seen.ttfund = request;
          return {
            snapshot_id: 'fin_test',
            provider: 'ttfund',
            source: 'FUND_SEARCH',
            sourceTier: 'official-gateway',
            asOf: '2026-06-03',
            fetchedAt: '2026-06-03T10:00:00.000Z',
            confidence: 'high',
            query: { skillId: 'FUND_SEARCH' },
            data: { code: 0 },
            presentationHint: { detailLevel: 'compact', compactSummary: true, avoidWords: [] },
            queriesInLast7Days: 2,
          };
        },
      },
      fredProvider: {
        query: async (request) => {
          seen.fred = request;
          return {
            snapshot_id: 'fin_fred',
            provider: 'fred',
            source: 'FRED:CPIAUCSL',
            sourceTier: 'official',
            asOf: '2026-04-01',
            fetchedAt: '2026-06-03T10:00:00.000Z',
            confidence: 'high',
            query: { seriesId: 'CPIAUCSL' },
            data: { latest: { date: '2026-04-01', value: 332.407 } },
            presentationHint: { detailLevel: 'compact', compactSummary: true, avoidWords: [] },
            queriesInLast7Days: 2,
          };
        },
      },
    });

    await handler({
      provider: 'ttfund',
      ttfund: {
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300', search_type: 'fund' },
        asOf: '2026-06-03',
        frequencyKey: 'attacker-controlled-key',
      },
    });
    await handler({
      provider: 'fred',
      fred: {
        seriesId: 'CPIAUCSL',
        frequencyKey: 'attacker-controlled-key',
      },
    });

    assert.equal(seen.ttfund.frequencyKey, undefined);
    assert.equal(seen.fred.frequencyKey, undefined);
  });
});
