import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FredProvider, QueryFrequencyTracker, TTFundProvider } from '../dist/index.js';

describe('finance provider adapters', () => {
  it('wraps ttfund gateway responses without leaking credentials', async () => {
    const seen = {};
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async (url, init) => {
        seen.url = String(url);
        seen.headers = Object.fromEntries(init.headers.entries());
        seen.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              raw_result: {
                status_code: 200,
                body: { success: true, data: { items: [{ fund_code: '000001' }] } },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const fact = await provider.query({
      skillId: 'FUND_SEARCH',
      payload: { query: '沪深300', search_type: 'fund' },
      asOf: '2026-06-03',
      frequencyKey: 'search:沪深300',
    });

    assert.equal(seen.body.skill_id, 'FUND_SEARCH');
    assert.equal(seen.body._skill_version, '1.0.0');
    assert.equal(seen.headers['x-api-key'], 'secret-token');
    assert.equal(fact.provider, 'ttfund');
    assert.equal(fact.source, 'FUND_SEARCH');
    assert.equal(fact.sourceTier, 'official-gateway');
    assert.equal(fact.query.apiKey, undefined);
    assert.equal(JSON.stringify(fact).includes('secret-token'), false);
  });

  it('counts ttfund queries even when callers omit frequencyKey', async () => {
    const tracker = new QueryFrequencyTracker({
      now: () => new Date('2026-06-03T10:00:00.000Z'),
    });
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      frequencyTracker: tracker,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 0, message: 'success', data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const request = {
      skillId: 'FUND_SEARCH',
      payload: { query: '沪深300', search_type: 'fund' },
      asOf: '2026-06-03',
      fetchedAt: '2026-06-03T10:00:00.000Z',
    };

    const first = await provider.query(request);
    const second = await provider.query(request);

    assert.equal(first.queriesInLast7Days, 1);
    assert.equal(second.queriesInLast7Days, 2);
  });

  it('rejects credential-like ttfund payload fields before provider calls or fact metadata', async () => {
    let called = false;
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    await assert.rejects(
      provider.query({
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300', apiKey: 'payload-secret' },
        asOf: '2026-06-03',
      }),
      /credential-like field: apiKey/,
    );
    assert.equal(called, false);
  });

  it('rejects common credential aliases in nested ttfund payload fields', async () => {
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async () => {
        throw new Error('provider must reject credential-like payload aliases before fetch');
      },
    });

    for (const payload of [
      { query: '沪深300', 'x-api-key': 'payload-secret' },
      { query: '沪深300', bearer_token: 'payload-secret' },
      { query: '沪深300', refreshToken: 'payload-secret' },
      { query: '沪深300', nested: { client_secret: 'payload-secret' } },
    ]) {
      await assert.rejects(
        provider.query({
          skillId: 'FUND_SEARCH',
          payload,
          asOf: '2026-06-03',
        }),
        /credential-like field/,
      );
    }
  });

  it('rejects ttfund application-level failures returned inside HTTP 200 envelopes', async () => {
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 10001,
            message: 'not entitled',
            data: {
              raw_result: {
                status_code: 200,
                body: { success: false },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await assert.rejects(
      provider.query({
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300' },
        asOf: '2026-06-03',
      }),
      /TTFund gateway application failure.*10001.*not entitled/,
    );
  });

  it('rejects ttfund responses without explicit top-level success code', async () => {
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'success', data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await assert.rejects(
      provider.query({
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300' },
        asOf: '2026-06-03',
      }),
      /TTFund gateway response missing explicit success code/,
    );
  });

  it('rejects ttfund raw_result failures instead of creating high-confidence facts', async () => {
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              raw_result: {
                status_code: 500,
                body: { message: 'upstream source down' },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await assert.rejects(
      provider.query({
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300' },
        asOf: '2026-06-03',
      }),
      /TTFund raw_result failure.*500/,
    );
  });

  it('requires caller-provided source asOf for ttfund facts', async () => {
    let called = false;
    const provider = new TTFundProvider({
      apiKey: 'secret-token',
      fetchImpl: async () => {
        called = true;
        return new Response(JSON.stringify({ code: 0, message: 'success', data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await assert.rejects(
      provider.query({
        skillId: 'FUND_SEARCH',
        payload: { query: '沪深300' },
      }),
      /TTFund query requires source asOf/,
    );
    assert.equal(called, false);
  });

  it('wraps FRED observations with official source metadata', async () => {
    const provider = new FredProvider({
      apiKey: 'fred-key',
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        assert.equal(parsed.searchParams.get('series_id'), 'CPIAUCSL');
        assert.equal(parsed.searchParams.get('api_key'), 'fred-key');
        return new Response(
          JSON.stringify({
            observations: [
              { date: '2026-03-01', value: '330.123' },
              { date: '2026-04-01', value: '332.407' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const fact = await provider.query({ seriesId: 'CPIAUCSL' });

    assert.equal(fact.provider, 'fred');
    assert.equal(fact.source, 'FRED:CPIAUCSL');
    assert.equal(fact.sourceTier, 'official');
    assert.equal(fact.asOf, '2026-04-01');
    assert.equal(fact.data.latest.value, 332.407);
    assert.equal(JSON.stringify(fact).includes('fred-key'), false);
  });

  it('rejects FRED queries before fetch when api key is missing', async () => {
    let called = false;
    const provider = new FredProvider({
      apiKey: '',
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    await assert.rejects(provider.query({ seriesId: 'CPIAUCSL' }), /FRED_API_KEY is required/);
    assert.equal(called, false);
  });
});
