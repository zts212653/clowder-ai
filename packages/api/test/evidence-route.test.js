/**
 * Evidence Search Route Tests
 * Covers: normal return, default tagsMatch, degraded fallback, limit validation.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { evidenceRoutes } from '../dist/routes/evidence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Create a mock HindsightClient */
function createMockClient(overrides = {}) {
  return {
    recall: async () => [],
    retain: async () => {},
    reflect: async () => '',
    ensureBank: async () => {},
    isHealthy: async () => true,
    ...overrides,
  };
}

describe('GET /api/evidence/search', () => {
  let app;

  async function setup(clientOverrides = {}, docsRoot, freshnessProvider, reimportTriggerProvider) {
    app = Fastify();
    const hindsightClient = createMockClient(clientOverrides);
    await app.register(evidenceRoutes, {
      hindsightClient,
      sharedBank: 'cat-cafe-shared',
      ...(docsRoot ? { docsRoot } : {}),
      ...(freshnessProvider ? { freshnessProvider } : {}),
      ...(reimportTriggerProvider ? { reimportTriggerProvider } : {}),
    });
    await app.ready();
  }

  it('returns freshness=stale when sync watermark commit mismatches HEAD (MVP #71)', async () => {
    await setup(
      { recall: async () => [] },
      undefined,
      async () => ({
        status: 'stale',
        checkedAt: '2026-02-14T12:34:56.000Z',
        headCommit: 'head1234',
        watermarkCommit: 'old9999',
        reason: 'commit_mismatch',
      }),
      async () => ({
        status: 'skipped',
        reason: 'test_stub',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=freshness',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.freshness?.status, 'stale');
    assert.equal(body.freshness?.headCommit, 'head1234');
    assert.equal(body.freshness?.watermarkCommit, 'old9999');
  });

  it('falls back to freshness=unknown when freshness provider throws', async () => {
    await setup({ recall: async () => [] }, undefined, async () => {
      throw new Error('freshness provider failure');
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=freshness',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.freshness?.status, 'unknown');
    assert.equal(body.freshness?.reason, 'head_unavailable');
  });

  it('fail-closes on stale freshness before recall and falls back to docs search', async () => {
    let recallCalls = 0;
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => {
          recallCalls += 1;
          return [
            {
              content: 'stale hindsight result',
              metadata: { anchor: 'docs/decisions/005-hindsight-integration-decisions.md' },
              score: 0.95,
            },
          ];
        },
      },
      docsRoot,
      async () => ({
        status: 'stale',
        checkedAt: '2026-02-14T12:34:56.000Z',
        headCommit: 'head1234',
        watermarkCommit: 'old9999',
        reason: 'commit_mismatch',
      }),
      async () => ({
        status: 'triggered',
        reason: 'stale_detected',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=phase',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'freshness_stale_fail_closed');
    assert.equal(body.reimportTrigger?.status, 'triggered');
    assert.equal(recallCalls, 0);
    assert.ok(body.results.length > 0, 'docs fallback should still return results');
  });

  it('marks stale fail-closed with trigger error when reimport provider throws', async () => {
    let recallCalls = 0;
    await setup(
      {
        recall: async () => {
          recallCalls += 1;
          return [];
        },
      },
      undefined,
      async () => ({
        status: 'stale',
        checkedAt: '2026-02-14T12:34:56.000Z',
        headCommit: 'head1234',
        watermarkCommit: 'old9999',
        reason: 'commit_mismatch',
      }),
      async () => {
        throw new Error('trigger spawn failed');
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=phase',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'freshness_stale_fail_closed');
    assert.equal(body.reimportTrigger?.status, 'failed');
    assert.equal(recallCalls, 0);
  });

  it('returns results from Hindsight', async () => {
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => [
          {
            content: 'ADR-005 decided single bank strategy for Hindsight integration',
            metadata: { anchor: 'docs/decisions/005-hindsight-integration-decisions.md', author: 'opus' },
            score: 0.92,
          },
          {
            content: 'Phase 4 completed with 460 tests',
            metadata: { anchor: 'docs/phases/phase-4.0-direction.md' },
            score: 0.75,
          },
        ],
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=hindsight+bank',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].sourceType, 'decision');
    assert.equal(body.results[0].confidence, 'high');
    assert.equal(body.results[1].sourceType, 'phase');
    assert.equal(body.results[1].confidence, 'mid');
  });

  it('passes default tagsMatch=all_strict and origin:git to Hindsight', async () => {
    let capturedOptions;
    await setup({
      recall: async (_bank, _query, options) => {
        capturedOptions = options;
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    assert.equal(capturedOptions.tagsMatch, 'all_strict');
    assert.deepEqual(capturedOptions.tags, ['project:cat-cafe', 'origin:git']);
    assert.deepEqual(capturedOptions.types, ['world', 'experience']);
    assert.equal(capturedOptions.budget, 'mid');
    assert.equal(capturedOptions.limit, 5);
  });

  it('ensures project:cat-cafe is present even when user provides custom tags', async () => {
    let capturedOptions;
    await setup({
      recall: async (_bank, _query, options) => {
        capturedOptions = options;
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&tags=kind:decision,origin:callback',
    });

    assert.ok(capturedOptions.tags.includes('project:cat-cafe'), 'project:cat-cafe must always be present');
    assert.ok(capturedOptions.tags.includes('kind:decision'));
    assert.ok(capturedOptions.tags.includes('origin:callback'));
  });

  it('uses runtime-configured recall defaults when query omits params', async () => {
    const prevBudget = process.env.HINDSIGHT_RECALL_DEFAULT_BUDGET;
    const prevTagsMatch = process.env.HINDSIGHT_RECALL_DEFAULT_TAGS_MATCH;
    const prevLimit = process.env.HINDSIGHT_RECALL_DEFAULT_LIMIT;
    process.env.HINDSIGHT_RECALL_DEFAULT_BUDGET = 'high';
    process.env.HINDSIGHT_RECALL_DEFAULT_TAGS_MATCH = 'any';
    process.env.HINDSIGHT_RECALL_DEFAULT_LIMIT = '7';

    let capturedOptions;
    await setup({
      recall: async (_bank, _query, options) => {
        capturedOptions = options;
        return [];
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test',
    });

    if (prevBudget === undefined) delete process.env.HINDSIGHT_RECALL_DEFAULT_BUDGET;
    else process.env.HINDSIGHT_RECALL_DEFAULT_BUDGET = prevBudget;
    if (prevTagsMatch === undefined) delete process.env.HINDSIGHT_RECALL_DEFAULT_TAGS_MATCH;
    else process.env.HINDSIGHT_RECALL_DEFAULT_TAGS_MATCH = prevTagsMatch;
    if (prevLimit === undefined) delete process.env.HINDSIGHT_RECALL_DEFAULT_LIMIT;
    else process.env.HINDSIGHT_RECALL_DEFAULT_LIMIT = prevLimit;

    assert.equal(res.statusCode, 200);
    assert.equal(capturedOptions.budget, 'high');
    assert.equal(capturedOptions.tagsMatch, 'any');
    assert.equal(capturedOptions.limit, 7);
  });

  it('passes custom parameters to Hindsight', async () => {
    let capturedOptions;
    await setup({
      recall: async (_bank, _query, options) => {
        capturedOptions = options;
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&limit=10&budget=high&tagsMatch=any',
    });

    assert.equal(capturedOptions.limit, 10);
    assert.equal(capturedOptions.budget, 'high');
    assert.equal(capturedOptions.tagsMatch, 'any');
  });

  it('splits comma-separated tags from query into strict tag array', async () => {
    let capturedOptions;
    await setup({
      recall: async (_bank, _query, options) => {
        capturedOptions = options;
        return [];
      },
    });

    await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=test&tags=project:cat-cafe,kind:decision',
    });

    assert.deepEqual(capturedOptions.tags, ['project:cat-cafe', 'kind:decision']);
    assert.equal(capturedOptions.tagsMatch, 'all_strict');
  });

  it('degrades when Hindsight is unavailable', async () => {
    // Use project docs/ as fallback
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=phase',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'hindsight_unavailable_fallback_docs_search');
    // Should find at least some docs with "phase" in them
    assert.ok(body.results.length > 0, 'degraded search should find docs');
  });

  it('degrades to docs fallback when HINDSIGHT_ENABLED=false and skips recall', async () => {
    const previous = process.env.HINDSIGHT_ENABLED;
    process.env.HINDSIGHT_ENABLED = 'false';

    let recallCalls = 0;
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => {
          recallCalls += 1;
          return [
            {
              content: 'unexpected hindsight result',
              metadata: { anchor: 'docs/decisions/005-hindsight-integration-decisions.md' },
              score: 0.95,
            },
          ];
        },
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=phase',
    });

    if (previous === undefined) delete process.env.HINDSIGHT_ENABLED;
    else process.env.HINDSIGHT_ENABLED = previous;

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'hindsight_disabled_fallback_docs_search');
    assert.equal(recallCalls, 0);
    assert.ok(body.results.length > 0, 'disabled mode should still provide docs fallback');
  });

  it('returns 502 when Hindsight fails with non-availability error', async () => {
    await setup({
      recall: async () => {
        throw new Error('invalid response schema');
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=phase',
    });

    assert.equal(res.statusCode, 502);
    const body = res.json();
    assert.equal(body.error, 'Evidence search unavailable');
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

  it('returns empty results for no matches', async () => {
    await setup({ recall: async () => [] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=nonexistent_topic_xyz',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.equal(body.results.length, 0);
  });

  it('downgrades confidence to low when docs anchor file is missing', async () => {
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => [
          {
            content: 'A memory with a missing anchor file',
            metadata: { anchor: 'docs/decisions/999-nonexistent.md' },
            score: 0.95,
          },
        ],
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=nonexistent',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 1);
    // Score 0.95 → would be 'high', but anchor validation downgrades to 'low'
    assert.equal(body.results[0].confidence, 'low');
  });

  it('preserves confidence when docs anchor file exists', async () => {
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => [
          {
            content: 'ADR-005 hindsight decisions',
            metadata: { anchor: 'docs/decisions/005-hindsight-integration-decisions.md' },
            score: 0.95,
          },
        ],
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=hindsight',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].confidence, 'high');
  });

  it('skips anchor validation for non-docs anchors', async () => {
    await setup({
      recall: async () => [
        {
          content: 'A commit-anchored memory',
          metadata: { anchor: 'commit:abc123' },
          score: 0.85,
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=commit',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 1);
    // Non-docs anchor → no validation → score-based confidence preserved
    assert.equal(body.results[0].confidence, 'high');
  });

  it('downgrades confidence for docs anchors that escape docs root', async () => {
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => [
          {
            content: 'Traversal-like anchor should not be trusted',
            metadata: { anchor: 'docs/../package.json' },
            score: 0.95,
          },
        ],
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=package',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].confidence, 'low');
  });

  it('respects limit parameter', async () => {
    await setup({
      recall: async (_b, _q, opts) => {
        // Return as many as limit allows
        return Array.from({ length: opts.limit }, (_, i) => ({
          content: `Memory ${i}`,
          score: 0.9 - i * 0.1,
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

  it('degraded search classifies source types correctly', async () => {
    const docsRoot = join(__dirname, '..', '..', '..', 'docs');
    await setup(
      {
        recall: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      docsRoot,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=hindsight&limit=20',
    });

    const body = res.json();
    assert.equal(body.degraded, true);

    // Check source type classification
    for (const r of body.results) {
      assert.ok(
        ['decision', 'phase', 'discussion', 'commit'].includes(r.sourceType),
        `Invalid sourceType: ${r.sourceType}`,
      );
      if (r.anchor.includes('decisions')) assert.equal(r.sourceType, 'decision');
      if (r.anchor.includes('phases')) assert.equal(r.sourceType, 'phase');
    }
  });
});
