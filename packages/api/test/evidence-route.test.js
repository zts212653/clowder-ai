/**
 * Evidence Search Route Tests
 * Covers: normal return, degraded fallback, limit validation.
 * F102 Phase D1: SQLite-only — no Hindsight paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { evidenceRoutes } from '../dist/routes/evidence.js';

/** Create a mock IEvidenceStore */
function createMockEvidenceStore(overrides = {}) {
  return {
    search: async () => [],
    health: async () => true,
    initialize: async () => {},
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    ...overrides,
  };
}

describe('GET /api/evidence/search', () => {
  let app;

  async function setup(storeOverrides = {}, routeOverrides = {}) {
    app = Fastify();
    const evidenceStore = createMockEvidenceStore(storeOverrides);
    await app.register(evidenceRoutes, { evidenceStore, ...routeOverrides });
    await app.ready();
  }

  it('fails closed when a resolver returns evidence outside the exact thread filter', async () => {
    let resolverOptions;
    const knowledgeResolver = {
      resolve: async (_query, options) => {
        resolverOptions = options;
        return {
          query: 'needle',
          sources: ['project'],
          results: [
            {
              anchor: 'thread-thread_other',
              kind: 'thread',
              status: 'active',
              title: 'Unrelated historical thread',
              summary: 'This result must not escape an exact thread filter.',
              updatedAt: '2026-07-15T00:00:00Z',
            },
          ],
        };
      },
    };
    await setup({}, { knowledgeResolver });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=needle&scope=threads&threadId=thread_target&include_expansion=false',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(resolverOptions.threadId, 'thread_target', 'route must propagate the structured filter');
    const body = res.json();
    assert.deepEqual(body.results, [], 'response boundary must reject evidence from every other thread');
    assert.deepEqual(body.filterExecution, {
      requestedThreadId: 'thread_target',
      executedThreadId: 'thread_target',
      outcome: 'authoritative_empty',
    });
  });

  it('does not emit unscoped expansion hints for an exact thread search', async () => {
    let expansionSearches = 0;
    const target = {
      anchor: 'thread-thread_target',
      kind: 'thread',
      status: 'active',
      title: 'Target thread',
      summary: 'Needle lives in the requested thread.',
      keywords: ['global-noise'],
      updatedAt: '2026-07-15T00:00:00Z',
    };
    const knowledgeResolver = {
      resolve: async () => ({ query: 'needle', sources: ['project'], results: [target] }),
    };
    await setup(
      {
        searchWithMeta: async () => {
          expansionSearches += 1;
          return {
            items: [
              {
                anchor: 'F167',
                kind: 'feature',
                status: 'active',
                title: 'Unscoped related direction',
                updatedAt: '2026-07-15T00:00:00Z',
              },
            ],
            meta: { degraded: false },
          };
        },
      },
      { knowledgeResolver },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=needle&scope=threads&threadId=thread_target',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(
      body.results.map((item) => item.anchor),
      ['thread-thread_target'],
    );
    assert.equal(body.expansionHints, undefined, 'exact thread responses must not contain global related directions');
    assert.equal(expansionSearches, 0, 'thread filter must stop unscoped expansion searches');
    assert.equal(body.filterExecution.outcome, 'matched');
    assert.equal(body.expansionMeta?.eligible, false);
    assert.equal(body.expansionMeta?.gateReason, 'exact_thread_filter');
    assert.equal(body.expansionMeta?.attempted, false);
  });

  it('records an explicit no-results gate in the expansion health funnel', async () => {
    await setup({ searchWithMeta: async () => ({ items: [], meta: { degraded: false } }) });

    const res = await app.inject({ method: 'GET', url: '/api/evidence/search?q=missing' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.results, []);
    assert.equal(body.expansionMeta?.eligible, false);
    assert.equal(body.expansionMeta?.gateReason, 'no_results');
    assert.equal(body.expansionMeta?.attempted, false);
    assert.equal(body.expansionMeta?.sourceRevision, 'f256-health-v2');
  });

  it('records expansion failures instead of swallowing the health-funnel dropout', async () => {
    let calls = 0;
    await setup({
      searchWithMeta: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            items: [
              {
                anchor: 'F256',
                kind: 'feature',
                status: 'active',
                title: 'Memory Search Strategy',
                keywords: ['related'],
                updatedAt: '2026-08-04T00:00:00Z',
              },
            ],
            meta: { degraded: false },
          };
        }
        throw new Error('expansion sub-search failed');
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/evidence/search?q=F256' });

    assert.equal(res.statusCode, 200, 'expansion remains fail-open for the search result');
    const body = res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.expansionMeta?.eligible, true);
    assert.equal(body.expansionMeta?.gateReason, 'expansion_error');
    assert.equal(body.expansionMeta?.attempted, true);
    assert.equal(body.expansionMeta?.presented, 0);
  });

  it('returns results from evidence store', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'docs/decisions/005-hindsight-integration-decisions.md',
          kind: 'decision',
          status: 'active',
          title: 'ADR-005 Hindsight Integration',
          summary: 'ADR-005 decided single bank strategy for Hindsight integration',
          updatedAt: '2026-01-01T00:00:00Z',
          authority: 'validated',
          retrievalScore: 0.92,
        },
        {
          anchor: 'docs/phases/phase-4.0-direction.md',
          kind: 'plan',
          status: 'active',
          title: 'Phase 4 Direction',
          summary: 'Phase 4 completed with 460 tests',
          updatedAt: '2026-01-01T00:00:00Z',
          authority: 'candidate',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=hindsight+bank',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].sourceType, 'decision');
    // F263: matchRank = f(rank), independent from retrieval score and authority.
    assert.equal(body.results[0].matchRank, 'high');
    assert.equal(body.results[0].confidence, undefined);
    assert.equal(body.results[0].retrievalScore, 0.92);
    assert.equal(body.results[0].updatedAt, '2026-01-01T00:00:00Z');
    assert.equal(body.results[0].status, 'active');
    assert.equal(body.results[0].authority, 'validated');
    assert.equal(body.results[1].sourceType, 'phase');
    // Phase E: rank 1 of 2 → high
    assert.equal(body.results[1].matchRank, 'high');
    assert.equal(body.results[1].updatedAt, '2026-01-01T00:00:00Z');
    assert.equal(body.results[1].authority, 'candidate');
  });

  it('explicitly opts the manual search surface into pull-only candidates', async () => {
    let receivedOptions;
    await setup({
      search: async (_query, options) => {
        receivedOptions = options;
        return [];
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/evidence/search?q=reflection' });

    assert.equal(res.statusCode, 200);
    assert.equal(receivedOptions.includePullOnly, true);
  });

  it('attaches suggested cross-post action for non-current thread hits', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread:cross-feature',
          kind: 'thread',
          status: 'active',
          title: 'Cross-feature discussion',
          summary: 'Important finding from another thread',
          updatedAt: '2026-01-01T00:00:00Z',
          passages: [
            {
              passageId: 'p1',
              content: 'finding',
              threadId: 'thread-other',
              messageId: 'msg-1',
            },
          ],
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=finding&scope=threads&currentThreadId=thread-current',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.results[0].suggestedAction, {
      type: 'cross_post',
      threadId: 'thread-other',
      reason: 'Search result came from another thread; dispatch relevant findings back to that thread.',
      source: 'search_evidence',
    });
  });

  it('does not attach cross-post action for current-thread hits', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread:same-feature',
          kind: 'thread',
          status: 'active',
          title: 'Same-thread discussion',
          summary: 'Already in current thread',
          updatedAt: '2026-01-01T00:00:00Z',
          passages: [{ passageId: 'p1', content: 'finding', threadId: 'thread-current' }],
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=finding&scope=threads&currentThreadId=thread-current',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results[0].suggestedAction, undefined);
  });

  it('normalizes synthetic thread anchors before attaching evidence cross-post action', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread-default',
          kind: 'thread',
          status: 'active',
          title: 'Default thread',
          summary: 'Indexed thread without passage metadata',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=finding&scope=threads&currentThreadId=thread-current',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results[0].suggestedAction.threadId, 'default');
  });

  it('suppresses current-thread evidence action after normalizing synthetic anchors', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread-default',
          kind: 'thread',
          status: 'active',
          title: 'Default thread',
          summary: 'Indexed current thread without passage metadata',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=finding&scope=threads&currentThreadId=default',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results[0].suggestedAction, undefined);
  });

  it('does not use synthetic thread anchor fallback for non-thread evidence', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread-looking-feature-anchor',
          kind: 'feature',
          status: 'active',
          title: 'Feature doc with thread-looking anchor',
          summary: 'Non-thread evidence should stay inert without explicit thread metadata',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=finding&currentThreadId=thread-current',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results[0].suggestedAction, undefined);
  });

  it('F263: matchRank reflects rank position, not authority', async () => {
    await setup({
      search: async () =>
        Array.from({ length: 6 }, (_, i) => ({
          anchor: `doc-${i}`,
          kind: 'feature',
          status: 'active',
          title: `Doc ${i}`,
          summary: `Summary ${i}`,
          updatedAt: '2026-01-01T00:00:00Z',
          authority: 'constitutional',
        })),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.equal(body.results[0].matchRank, 'high');
    assert.equal(body.results[1].matchRank, 'high');
    assert.equal(body.results[2].matchRank, 'mid');
    assert.equal(body.results[4].matchRank, 'mid');
    assert.equal(body.results[5].matchRank, 'low');
    // all have same authority despite different match rank
    for (const r of body.results) {
      assert.equal(r.authority, 'constitutional');
    }
  });

  it('passes query and limit to evidence store', async () => {
    let capturedArgs;
    await setup({
      search: async (query, opts) => {
        capturedArgs = { query, opts };
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=10',
    });

    assert.equal(capturedArgs.query, 'test');
    assert.equal(capturedArgs.opts.limit, 10);
  });

  it('defaults limit to 5 when omitted', async () => {
    let capturedOpts;
    await setup({
      search: async (_q, opts) => {
        capturedOpts = opts;
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    assert.equal(capturedOpts.limit, 5);
  });

  it('degrades with an explicit filter outcome when exact-thread retrieval throws', async () => {
    await setup({
      search: async () => {
        throw new Error('SQLite error');
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&scope=threads&threadId=thread_target',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'evidence_store_error');
    assert.deepEqual(body.results, []);
    assert.deepEqual(body.filterExecution, {
      requestedThreadId: 'thread_target',
      executedThreadId: 'thread_target',
      outcome: 'degraded_empty',
    });
  });

  // ── F209 Phase A: raw non-lexical modes degrade only when passage vectors are unavailable ──
  it('returns degraded=false for depth=raw + mode=hybrid when store reports raw hybrid execution', async () => {
    await setup({
      searchWithMeta: async () => ({
        items: [
          {
            anchor: 'thread-1',
            kind: 'thread',
            status: 'active',
            title: 'Thread 1',
            summary: 'A thread',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        meta: {
          degraded: false,
        },
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=hybrid',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.degradeReason, undefined);
    assert.equal(body.effectiveMode, undefined);
    assert.equal(body.results.length, 1);
  });

  it('returns passage_embedding_unavailable when raw semantic falls back to lexical', async () => {
    await setup({
      searchWithMeta: async () => ({
        items: [],
        meta: {
          degraded: true,
          degradeReason: 'passage_embedding_unavailable',
          effectiveMode: 'lexical',
        },
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=semantic',
    });

    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'passage_embedding_unavailable');
    assert.equal(body.effectiveMode, 'lexical');
  });

  it('returns passage_vector_search_error when raw hybrid vector search fails open', async () => {
    await setup({
      searchWithMeta: async () => ({
        items: [],
        meta: {
          degraded: true,
          degradeReason: 'passage_vector_search_error',
          effectiveMode: 'lexical',
        },
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=hybrid',
    });

    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'passage_vector_search_error');
    assert.equal(body.effectiveMode, 'lexical');
  });

  it('returns raw_lexical_only when legacy stores lack searchWithMeta for raw semantic', async () => {
    await setup({
      search: async () => [
        {
          anchor: 'thread-legacy',
          kind: 'thread',
          status: 'active',
          title: 'Legacy thread hit',
          summary: 'Legacy store lexical-only result',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=semantic',
    });

    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'raw_lexical_only');
    assert.equal(body.effectiveMode, 'lexical');
    assert.equal(body.results.length, 1);
  });

  it('returns degraded=false for depth=raw + mode=lexical (no degradation)', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&depth=raw&mode=lexical',
    });

    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.effectiveMode, undefined);
  });

  it('returns degraded=false when depth is not raw', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&mode=semantic',
    });

    const body = res.json();
    assert.equal(body.degraded, false);
  });

  it('returns 400 for missing q parameter', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search',
    });

    assert.equal(res.statusCode, 400);
  });

  it('F263: accepts a query at the 2,000-character contract boundary', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: `/api/evidence/search?q=${'q'.repeat(2_000)}`,
    });

    assert.equal(res.statusCode, 200);
  });

  it('F263: rejects a query above the 2,000-character contract boundary', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: `/api/evidence/search?q=${'q'.repeat(2_001)}`,
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for limit out of range', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=50',
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for limit=0', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=0',
    });

    assert.equal(res.statusCode, 400);
  });

  it('F263: coverage honors scope and mode while using a fixed bounded candidate envelope', async () => {
    const calls = [];
    await setup({
      searchWithMeta: async (_query, options) => {
        calls.push(options);
        return { items: [], meta: { degraded: false } };
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=wide&intent=coverage&scope=threads&mode=hybrid&limit=15',
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      calls.map((options) => options.scope),
      ['threads'],
    );
    assert.equal(calls[0].limit, 50, 'coverage discovery must use one fixed bounded candidate envelope');
    assert.equal(calls[0].mode, 'hybrid');
    assert.ok(calls[0].signal instanceof AbortSignal, 'route coverage must propagate a cancellation signal');
    assert.ok(Number.isFinite(calls[0].deadlineAt), 'route coverage must propagate an absolute deadline');
    assert.deepEqual(res.json().contract.executed.scopes, ['threads']);
    assert.equal(res.json().contract.latency.budgetMs, 15_000);
    assert.equal(typeof res.json().contract.latency.eventLoopLagMaxMs, 'number');
    assert.equal(typeof res.json().contract.latency.abortPropagated, 'boolean');
  });

  it('F263: coverage rejects scopes it cannot execute instead of silently broadening them', async () => {
    await setup({ searchWithMeta: async () => ({ items: [], meta: { degraded: false } }) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&intent=coverage&scope=memory',
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /coverage scope/i);
  });

  it('returns empty results for no matches', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=nonexistent_topic_xyz',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.results.length, 0);
  });

  it('respects limit parameter', async () => {
    await setup({
      search: async (_q, opts) => {
        return Array.from({ length: opts.limit }, (_, i) => ({
          anchor: `F${i}`,
          kind: 'feature',
          status: 'active',
          title: `Feature ${i}`,
          summary: `Summary ${i}`,
          updatedAt: '2026-01-01T00:00:00Z',
        }));
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=3',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 3);
  });

  // ── F163: variantId + boostSource in response ─────────────────────
  it('F163: response includes variantId (12-char hex)', async () => {
    await setup({ search: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.ok(body.variantId, 'variantId should be present');
    assert.equal(body.variantId.length, 12);
    assert.match(body.variantId, /^[0-9a-f]{12}$/);
  });

  it('F163: each result has boostSource array with legacy when flags off', async () => {
    // Ensure all F163 flags are off
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    await setup({
      search: async () => [
        {
          anchor: 'test-1',
          kind: 'lesson',
          status: 'active',
          title: 'Test',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.ok(body.results[0].boostSource);
    assert.ok(Array.isArray(body.results[0].boostSource));
    assert.deepEqual(body.results[0].boostSource, ['legacy']);
  });

  it('F163: degraded response also has variantId', async () => {
    await setup({
      search: async () => {
        throw new Error('db error');
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.ok(body.variantId, 'degraded response should still have variantId');
    assert.equal(body.variantId.length, 12);
  });

  it('maps evidence kinds to source types correctly', async () => {
    await setup({
      search: async () => [
        { anchor: 'A1', kind: 'decision', status: 'active', title: 'D', updatedAt: '2026-01-01T00:00:00Z' },
        { anchor: 'A2', kind: 'plan', status: 'active', title: 'P', updatedAt: '2026-01-01T00:00:00Z' },
        { anchor: 'A3', kind: 'feature', status: 'active', title: 'F', updatedAt: '2026-01-01T00:00:00Z' },
        { anchor: 'A4', kind: 'session', status: 'active', title: 'S', updatedAt: '2026-01-01T00:00:00Z' },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    const body = res.json();
    assert.equal(body.results[0].sourceType, 'decision');
    assert.equal(body.results[1].sourceType, 'phase');
    assert.equal(body.results[2].sourceType, 'feature');
    assert.equal(body.results[3].sourceType, 'discussion');
  });
});

// ── GET /api/evidence/status (AC-D8) ──────────────────────────────────
describe('GET /api/evidence/status', () => {
  it('returns status with doc/edge counts from store with getDb()', async () => {
    const app = Fastify();
    const mockDb = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 42 };
          if (sql.includes('edges') && sql.includes('count')) return { c: 10 };
          if (sql.includes('max(updated_at)')) return { t: '2026-03-17T00:00:00Z' };
          return {};
        },
      }),
    };
    const evidenceStore = {
      ...createMockEvidenceStore(),
      getDb: () => mockDb,
    };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, true);
    assert.equal(body.docs_count, 42);
    assert.equal(body.edges_count, 10);
    assert.equal(body.last_rebuild_at, '2026-03-17T00:00:00Z');
  });

  it('returns healthy=false when getDb is unavailable', async () => {
    const app = Fastify();
    const evidenceStore = createMockEvidenceStore(); // no getDb
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, false);
    assert.equal(body.reason, 'no_db');
  });

  it('returns healthy=false on query error', async () => {
    const app = Fastify();
    const evidenceStore = {
      ...createMockEvidenceStore(),
      getDb: () => ({
        prepare: () => {
          throw new Error('db locked');
        },
      }),
    };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, false);
    assert.equal(body.reason, 'query_error');
  });

  it('exposes passage_vectors_count for embedding warm-up (F209)', async () => {
    const app = Fastify();
    const mockDb = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('passage_vectors')) return { c: 2368 };
          if (sql.includes('evidence_passages')) return { c: 8608 };
          if (sql.includes("kind = 'thread'")) return { c: 12 };
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 42 };
          if (sql.includes('edges')) return { c: 10 };
          if (sql.includes('max(updated_at)')) return { t: '2026-05-25T00:00:00Z' };
          if (sql.includes('embedding_meta')) return { value: 'test-model' };
          return {};
        },
      }),
    };
    const evidenceStore = { ...createMockEvidenceStore(), getDb: () => mockDb };
    await app.register(evidenceRoutes, { evidenceStore, embeddingService: { isReady: () => true } });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.passages_count, 8608);
    assert.equal(body.passage_vectors_count, 2368, 'status should expose embedded passage-vector count');
    assert.equal(body.passage_vectors_supported, true, 'vec table present → supported');
  });

  it('reports passage_vectors_supported=false when embedding is disabled even if vec table exists (F209)', async () => {
    const app = Fastify();
    const mockDb = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('passage_vectors')) return { c: 2368 };
          if (sql.includes('evidence_passages')) return { c: 8608 };
          if (sql.includes("kind = 'thread'")) return { c: 12 };
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 42 };
          if (sql.includes('edges')) return { c: 10 };
          if (sql.includes('max(updated_at)')) return { t: '2026-05-25T00:00:00Z' };
          if (sql.includes('embedding_meta')) return { value: 'test-model' };
          return {};
        },
      }),
    };
    const evidenceStore = { ...createMockEvidenceStore(), getDb: () => mockDb };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.passages_count, 8608);
    assert.equal(body.passage_vectors_count, 2368);
    assert.equal(body.passage_vectors_supported, false, 'vec table alone is not runtime embedding support');
  });

  it('reports passage_vectors_supported=false when embedding service is not ready even if vec table exists (F209)', async () => {
    const app = Fastify();
    const mockDb = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('passage_vectors')) return { c: 2368 };
          if (sql.includes('evidence_passages')) return { c: 8608 };
          if (sql.includes("kind = 'thread'")) return { c: 12 };
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 42 };
          if (sql.includes('edges')) return { c: 10 };
          if (sql.includes('max(updated_at)')) return { t: '2026-05-25T00:00:00Z' };
          if (sql.includes('embedding_meta')) return { value: 'test-model' };
          return {};
        },
      }),
    };
    const evidenceStore = { ...createMockEvidenceStore(), getDb: () => mockDb };
    await app.register(evidenceRoutes, { evidenceStore, embeddingService: { isReady: () => false } });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.passages_count, 8608);
    assert.equal(body.passage_vectors_count, 2368);
    assert.equal(body.passage_vectors_supported, false, 'embedding service must be ready to support warm-up');
  });

  it('reports passage_vectors_supported=false when the vec table is absent (F209 — codex P2)', async () => {
    const app = Fastify();
    const mockDb = {
      prepare: (sql) => {
        if (sql.includes('passage_vectors')) {
          return {
            get: () => {
              throw new Error('no such table: passage_vectors');
            },
          };
        }
        return {
          get: () => {
            if (sql.includes('evidence_passages')) return { c: 8608 };
            if (sql.includes("kind = 'thread'")) return { c: 12 };
            if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 42 };
            if (sql.includes('edges')) return { c: 10 };
            if (sql.includes('max(updated_at)')) return { t: '2026-05-25T00:00:00Z' };
            if (sql.includes('embedding_meta')) return { value: 'test-model' };
            return {};
          },
        };
      },
    };
    const evidenceStore = { ...createMockEvidenceStore(), getDb: () => mockDb };
    await app.register(evidenceRoutes, { evidenceStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.healthy, true, 'missing vec table must not break status');
    assert.equal(body.passages_count, 8608);
    assert.equal(body.passage_vectors_supported, false, 'missing vec table → unsupported, not 0-and-warming');
    assert.equal(body.passage_vectors_count, 0);
  });
});

// ── POST /api/evidence/reindex (AC-D11/D12/D19) ──────────────────
describe('POST /api/evidence/reindex', () => {
  it('calls incrementalUpdate and returns ok', async () => {
    const app = Fastify();
    let capturedPaths;
    const mockIndexBuilder = {
      incrementalUpdate: async (paths) => {
        capturedPaths = paths;
      },
      rebuild: async () => ({ docsIndexed: 0, docsSkipped: 0, durationMs: 0 }),
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };
    const evidenceStore = createMockEvidenceStore();
    await app.register(evidenceRoutes, { evidenceStore, indexBuilder: mockIndexBuilder });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/reindex',
      payload: { paths: ['docs/features/F042.md'] },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(capturedPaths, ['docs/features/F042.md']);
  });

  it('returns 400 for invalid body', async () => {
    const app = Fastify();
    const mockIndexBuilder = {
      incrementalUpdate: async () => {},
      rebuild: async () => ({ docsIndexed: 0, docsSkipped: 0, durationMs: 0 }),
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
    };
    const evidenceStore = createMockEvidenceStore();
    await app.register(evidenceRoutes, { evidenceStore, indexBuilder: mockIndexBuilder });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/reindex',
      payload: { paths: [] },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 503 when indexBuilder unavailable', async () => {
    const app = Fastify();
    const evidenceStore = createMockEvidenceStore();
    await app.register(evidenceRoutes, { evidenceStore }); // no indexBuilder
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/reindex',
      payload: { paths: ['docs/features/F042.md'] },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 503);
  });
});
