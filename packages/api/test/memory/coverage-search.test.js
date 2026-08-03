// F200 HW-1: Coverage Search Mode — TDD tests
// Plan: docs/plans/2026-06-19-f200-hw1-coverage-search.md

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** @typedef {import('../../src/domains/memory/interfaces.js').EvidenceItem} EvidenceItem */

// ── Test helpers ────────────────────────────────────────────────────

/**
 * Creates a mock evidence store that returns different results per scope.
 * @param {{ docs?: EvidenceItem[], threads?: EvidenceItem[] }} scopeResults
 */
function createMockEvidenceStore(scopeResults = {}) {
  return {
    async searchWithMeta(query, options = {}) {
      const scope = options.scope || 'docs';
      const items = scopeResults[scope] || [];
      const limit = options.limit || items.length;
      return {
        items: items.slice(0, limit),
        meta: { degraded: false },
      };
    },
  };
}

/**
 * Creates a minimal EvidenceItem for testing.
 * @param {Partial<EvidenceItem>} overrides
 * @returns {EvidenceItem}
 */
function makeItem(overrides) {
  return {
    anchor: overrides.anchor || 'test-anchor',
    kind: overrides.kind || 'feature',
    status: overrides.status || 'active',
    title: overrides.title || 'Test Item',
    summary: overrides.summary || '',
    sourcePath: overrides.sourcePath || '',
    updatedAt: overrides.updatedAt || '2026-06-19T00:00:00Z',
    ...overrides,
  };
}

// ── Task 1: Basic multi-scope coverage search ───────────────────────

describe('CoverageSearchService', () => {
  /** @type {import('../../dist/domains/memory/CoverageSearchService.js').CoverageSearchService} */
  let service;

  describe('Task 1: multi-scope direct hits', () => {
    it('returns coverage matrix with direct hits from docs and threads', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [
          makeItem({ anchor: 'F200', title: 'Memory Recall Eval', kind: 'feature', sourcePath: 'features/F200.md' }),
          makeItem({ anchor: 'F102', title: 'Memory Adapter', kind: 'feature', sourcePath: 'features/F102.md' }),
        ],
        threads: [makeItem({ anchor: 'thread-001', title: 'Discussion about memory', kind: 'thread' })],
      });
      service = new CoverageSearchService(store);
      const result = await service.search('memory recall');

      assert.ok(result.matrix.length > 0, 'matrix should have items');
      assert.equal(result.totalHits, result.matrix.length, 'totalHits matches matrix length');
      assert.ok(result.matrix.length <= 50, 'respects max 50 cap');

      // All items should be direct hits
      for (const item of result.matrix) {
        assert.equal(item.matchType, 'direct');
        assert.equal(item.confidence, undefined, 'legacy overloaded confidence must not be emitted');
      }

      // bySource counts are populated
      assert.ok(result.bySource.docs.count >= 0);
      assert.ok(result.bySource.threads.count >= 0);
      assert.equal(result.bySource.conventionGraph.count, 0, 'no convention graph hits without graph');
    });

    it('returns query in result', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({ docs: [makeItem({ anchor: 'A1' })] });
      service = new CoverageSearchService(store);
      const result = await service.search('test query');
      assert.equal(result.query, 'test query');
    });

    it('F263: directness comes from matchType without inventing a retrieval score', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'A1', retrievalScore: 0.42 }), makeItem({ anchor: 'A2' })],
      });
      service = new CoverageSearchService(store);
      const result = await service.search('direct semantics', { scope: 'docs' });

      assert.equal(result.matrix[0].matchType, 'direct');
      assert.equal(result.matrix[0].retrievalScore, 0.42);
      assert.equal(result.matrix[1].matchType, 'direct');
      assert.equal(result.matrix[1].retrievalScore, undefined, 'missing score must stay unknown, not default to 1');
      assert.equal(result.matrix[1].confidence, undefined);
    });

    it('handles empty search results gracefully', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({ docs: [], threads: [] });
      service = new CoverageSearchService(store);
      const result = await service.search('nonexistent topic');

      assert.equal(result.totalHits, 0);
      assert.equal(result.matrix.length, 0);
      assert.equal(result.bySource.docs.count, 0);
      assert.equal(result.bySource.threads.count, 0);
    });

    it('classifies items by source correctly', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'F200', kind: 'feature', sourcePath: 'features/F200.md' })],
        threads: [makeItem({ anchor: 'thread-001', kind: 'thread' })],
      });
      service = new CoverageSearchService(store);
      const result = await service.search('test');

      const docItems = result.matrix.filter((m) => m.source === 'docs');
      const threadItems = result.matrix.filter((m) => m.source === 'threads');
      assert.ok(docItems.length > 0, 'should have doc-sourced items');
      assert.ok(threadItems.length > 0, 'should have thread-sourced items');
    });
  });

  describe('Task 4: per-source quota + dedup', () => {
    it('enforces per-source quota (docs capped at 25)', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const manyDocs = Array.from({ length: 30 }, (_, i) =>
        makeItem({ anchor: `doc-${i}`, title: `Doc ${i}`, kind: 'feature', sourcePath: `features/doc-${i}.md` }),
      );
      const store = createMockEvidenceStore({ docs: manyDocs, threads: [] });
      service = new CoverageSearchService(store);
      const result = await service.search('test');

      assert.ok(result.bySource.docs.count <= 25, `docs count ${result.bySource.docs.count} should be <= 25`);
      assert.ok(result.matrix.length <= 50, 'total matrix <= 50');
    });

    it('enforces threads quota (capped at 20)', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const manyThreads = Array.from({ length: 25 }, (_, i) =>
        makeItem({ anchor: `thread-${i}`, title: `Thread ${i}`, kind: 'thread' }),
      );
      const store = createMockEvidenceStore({ docs: [], threads: manyThreads });
      service = new CoverageSearchService(store);
      const result = await service.search('test');

      assert.ok(result.bySource.threads.count <= 20, `threads count ${result.bySource.threads.count} should be <= 20`);
    });

    it('dedup prefers direct hits over duplicates from different scopes', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      // Same anchor appears in both docs and threads
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'F200', title: 'F200 as doc', kind: 'feature' })],
        threads: [makeItem({ anchor: 'F200', title: 'F200 as thread', kind: 'thread' })],
      });
      service = new CoverageSearchService(store);
      const result = await service.search('F200');

      const f200Items = result.matrix.filter((m) => m.anchor === 'F200');
      assert.equal(f200Items.length, 1, 'dedup should keep only one F200');
      // First occurrence (docs searched first) wins
      assert.equal(f200Items[0].source, 'docs', 'docs hit should win dedup');
    });

    it('enforces max 50 total cap across all sources', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const manyDocs = Array.from({ length: 25 }, (_, i) =>
        makeItem({ anchor: `doc-${i}`, title: `Doc ${i}`, kind: 'feature' }),
      );
      const manyThreads = Array.from({ length: 20 }, (_, i) =>
        makeItem({ anchor: `thread-${i}`, title: `Thread ${i}`, kind: 'thread' }),
      );
      const store = createMockEvidenceStore({ docs: manyDocs, threads: manyThreads });
      service = new CoverageSearchService(store);
      const result = await service.search('test');

      assert.ok(result.matrix.length <= 50, `matrix length ${result.matrix.length} should be <= 50`);
    });
  });

  describe('Task 3: convention graph (soft dep)', () => {
    it('falls back gracefully when convention graph is null', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'F200', kind: 'feature' })],
      });
      service = new CoverageSearchService(store, null);
      const result = await service.search('search_evidence');

      assert.equal(result.bySource.conventionGraph.count, 0);
      assert.ok(result.matrix.length > 0, 'should still have results from docs');
      // degraded note for unavailable graph
      assert.ok(
        result.degraded?.some((d) => d.source === 'convention-graph'),
        'should have degraded note for convention-graph',
      );
    });
  });

  describe('AC-9: normal top-k unaffected', () => {
    it('CoverageSearchService does not modify core store search semantics', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      // Verify CoverageSearchService calls searchWithMeta, not mutating the store
      let callCount = 0;
      const store = {
        async searchWithMeta(query, options) {
          callCount++;
          return { items: [], meta: { degraded: false } };
        },
      };
      service = new CoverageSearchService(store);
      await service.search('test');

      // Should call searchWithMeta (not search directly, and not mutate store)
      assert.ok(callCount >= 2, 'should call searchWithMeta for multiple scopes');
    });
  });

  describe('Task 6: CoverageSearchEvent telemetry', () => {
    it('emits CoverageSearchEvent via onCoverageEvent callback', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const events = [];
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'F200', kind: 'feature' })],
        threads: [makeItem({ anchor: 'thread-001', kind: 'thread' })],
      });
      service = new CoverageSearchService(store, null, {
        onCoverageEvent: (e) => events.push(e),
      });
      await service.search('memory');

      assert.equal(events.length, 1, 'should emit exactly one event');
      const event = events[0];
      assert.equal(event.query, 'memory');
      assert.equal(typeof event.totalHits, 'number');
      assert.equal(typeof event.directHits, 'number');
      assert.equal(typeof event.indirectHits, 'number');
      assert.equal(event.conventionGraphUsed, false);
      assert.equal(event.conventionGraphStaleSkips, 0);
      assert.ok(event.timestamp > 0);
      assert.ok(event.coverageId.startsWith('cov-'));
    });

    it('does not crash when onCoverageEvent is not provided', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({ docs: [makeItem({ anchor: 'A1' })] });
      service = new CoverageSearchService(store);
      // Should not throw
      const result = await service.search('test');
      assert.ok(result.totalHits >= 0);
    });
  });

  describe('Task 5: SearchOptions intent field', () => {
    it('intent field is accepted in SearchOptions', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      // Verify the service can be constructed and called — intent routing
      // happens at the API route level, not inside CoverageSearchService
      const store = createMockEvidenceStore({ docs: [makeItem({ anchor: 'A1' })] });
      service = new CoverageSearchService(store);
      const result = await service.search('test');
      assert.ok(result.matrix);
    });
  });

  describe('Task 2: structured expansion — frontmatter aliases', () => {
    it('expands coverage via keywords from direct hits (frontmatter alias)', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      // Mock that returns different results per query:
      // Original query → F200 (with keyword 'redis')
      // Expansion query 'redis' → F102 (new doc found via keyword)
      const store = {
        async searchWithMeta(query, opts) {
          const scope = opts?.scope || 'docs';
          if (scope === 'docs' && query === 'memory search') {
            return {
              items: [makeItem({ anchor: 'F200', title: 'Memory Recall', keywords: ['redis'], kind: 'feature' })],
              meta: { degraded: false },
            };
          }
          if (scope === 'docs' && query === 'redis') {
            return {
              items: [makeItem({ anchor: 'F102', title: 'Redis Store', kind: 'feature' })],
              meta: { degraded: false },
            };
          }
          return { items: [], meta: { degraded: false } };
        },
      };

      service = new CoverageSearchService(store);
      const result = await service.search('memory search');

      const aliasHits = result.matrix.filter((m) => m.matchType === 'alias');
      assert.ok(aliasHits.length > 0, 'should have alias expansion hits');
      assert.equal(aliasHits[0].anchor, 'F102');
      assert.equal(aliasHits[0].retrievalScore, undefined, 'edge heuristics must not masquerade as retrieval scores');
      assert.equal(aliasHits[0].expansionProvenance.source, 'frontmatter-alias');
      assert.ok(aliasHits[0].expansionProvenance.via.includes('redis'), 'provenance via should mention keyword');
    });

    it('does not duplicate already-seen anchors during expansion', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      // Expansion for keyword 'memory' returns F200 which is already a direct hit
      const store = {
        async searchWithMeta(query, opts) {
          const scope = opts?.scope || 'docs';
          if (scope === 'docs' && query === 'test') {
            return {
              items: [makeItem({ anchor: 'F200', title: 'Memory', keywords: ['memory'], kind: 'feature' })],
              meta: { degraded: false },
            };
          }
          if (scope === 'docs' && query === 'memory') {
            return {
              items: [makeItem({ anchor: 'F200', title: 'Memory', kind: 'feature' })],
              meta: { degraded: false },
            };
          }
          return { items: [], meta: { degraded: false } };
        },
      };

      service = new CoverageSearchService(store);
      const result = await service.search('test');

      const f200s = result.matrix.filter((m) => m.anchor === 'F200');
      assert.equal(f200s.length, 1, 'should not duplicate F200');
      assert.equal(f200s[0].matchType, 'direct', 'direct hit should win');
    });
  });

  describe('Task 2: structured expansion — source-thread links', () => {
    it('expands coverage via thread references in summary', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = {
        async searchWithMeta(query, opts) {
          const scope = opts?.scope || 'docs';
          if (scope === 'docs' && query === 'memory design') {
            return {
              items: [
                makeItem({
                  anchor: 'F200',
                  title: 'Memory Recall',
                  summary: 'Discussed in thread-abc123 about the approach',
                  kind: 'feature',
                }),
              ],
              meta: { degraded: false },
            };
          }
          if (scope === 'threads' && query === 'thread-abc123') {
            return {
              items: [makeItem({ anchor: 'thread-abc123', title: 'Memory Discussion', kind: 'thread' })],
              meta: { degraded: false },
            };
          }
          return { items: [], meta: { degraded: false } };
        },
      };

      service = new CoverageSearchService(store);
      const result = await service.search('memory design');

      const threadExpansions = result.matrix.filter((m) => m.matchType === 'source-thread');
      assert.ok(threadExpansions.length > 0, 'should have source-thread expansion hits');
      assert.equal(threadExpansions[0].anchor, 'thread-abc123');
      assert.equal(
        threadExpansions[0].retrievalScore,
        undefined,
        'source-thread heuristics must not masquerade as retrieval scores',
      );
      assert.equal(threadExpansions[0].expansionProvenance.source, 'source-thread');
      assert.ok(
        threadExpansions[0].expansionProvenance.via.includes('thread-abc123'),
        'provenance should trace thread ref',
      );
    });

    it('expands via sourceIds field', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = {
        async searchWithMeta(query, opts) {
          const scope = opts?.scope || 'docs';
          if (scope === 'docs' && query === 'test') {
            return {
              items: [makeItem({ anchor: 'F200', title: 'Memory', kind: 'feature', sourceIds: ['thread-xyz'] })],
              meta: { degraded: false },
            };
          }
          if (scope === 'threads' && query === 'thread-xyz') {
            return {
              items: [makeItem({ anchor: 'thread-xyz', title: 'XYZ thread', kind: 'thread' })],
              meta: { degraded: false },
            };
          }
          return { items: [], meta: { degraded: false } };
        },
      };

      service = new CoverageSearchService(store);
      const result = await service.search('test');

      const threadHits = result.matrix.filter((m) => m.matchType === 'source-thread');
      assert.ok(threadHits.length > 0, 'should find thread from sourceIds');
    });
  });

  describe('Task 2+3: expansionProvenance invariant', () => {
    it('every indirect hit has expansionProvenance (砚砚 constraint #2)', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = {
        async searchWithMeta(query, opts) {
          const scope = opts?.scope || 'docs';
          if (scope === 'docs' && query === 'memory system') {
            return {
              items: [makeItem({ anchor: 'F200', title: 'Memory', keywords: ['recall'], kind: 'feature' })],
              meta: { degraded: false },
            };
          }
          if (scope === 'docs' && query === 'recall') {
            return {
              items: [makeItem({ anchor: 'F102', title: 'Recall Core', kind: 'feature' })],
              meta: { degraded: false },
            };
          }
          return { items: [], meta: { degraded: false } };
        },
      };

      service = new CoverageSearchService(store);
      const result = await service.search('memory system');

      for (const item of result.matrix) {
        if (item.matchType !== 'direct') {
          assert.ok(item.expansionProvenance, `non-direct item ${item.anchor} must have expansionProvenance`);
          assert.ok(item.expansionProvenance.source, 'provenance.source required');
          assert.ok(item.expansionProvenance.via, 'provenance.via required');
          assert.ok(
            ['static', 'heuristic'].includes(item.expansionProvenance.edgeStrength),
            'provenance.edgeStrength must be static|heuristic',
          );
        }
      }
    });
  });

  describe('Task 3: convention graph expansion (stale + fresh)', () => {
    it('skips stale convention graph edges with degraded note', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'search_evidence', kind: 'feature' })],
      });
      const graph = {
        isAvailable: () => true,
        queryConsumers: async () => [
          {
            anchor: 'memory-search-skill',
            title: 'Memory Search Skill',
            kind: 'feature',
            edgeStrength: 'static',
            stale: true,
          },
        ],
      };
      service = new CoverageSearchService(store, graph);
      const result = await service.search('search_evidence');

      assert.equal(result.bySource.conventionGraph.count, 0, 'stale edges should be skipped');
      // No convention items in matrix
      const conventionHits = result.matrix.filter((m) => m.matchType === 'convention');
      assert.equal(conventionHits.length, 0, 'no convention hits from stale edges');
    });

    it('expands via convention graph edges when fresh', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'search_evidence', kind: 'feature' })],
      });
      const graph = {
        isAvailable: () => true,
        queryConsumers: async () => [
          {
            anchor: 'memory-search-skill',
            title: 'Memory Search Skill',
            kind: 'feature',
            edgeStrength: 'static',
            stale: false,
          },
        ],
      };
      service = new CoverageSearchService(store, graph);
      const result = await service.search('search_evidence');

      const conventionHits = result.matrix.filter((m) => m.matchType === 'convention');
      assert.ok(conventionHits.length > 0, 'should have convention graph hits');
      assert.equal(conventionHits[0].anchor, 'memory-search-skill');
      assert.equal(conventionHits[0].source, 'convention-graph');
      assert.equal(
        conventionHits[0].retrievalScore,
        undefined,
        'convention edge strength must stay independent from retrieval score',
      );
      assert.equal(conventionHits[0].expansionProvenance.source, 'convention-edge');
      assert.ok(
        conventionHits[0].expansionProvenance.via.includes('search_evidence'),
        'provenance should trace source anchor',
      );
      assert.equal(conventionHits[0].expansionProvenance.edgeStrength, 'static');
      assert.equal(result.bySource.conventionGraph.count, conventionHits.length);
    });

    it('records staleSkips in telemetry', async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      const store = createMockEvidenceStore({
        docs: [makeItem({ anchor: 'search_evidence', kind: 'feature' })],
      });
      const graph = {
        isAvailable: () => true,
        queryConsumers: async () => [
          { anchor: 'skill-a', title: 'A', kind: 'feature', edgeStrength: 'static', stale: true },
          { anchor: 'skill-b', title: 'B', kind: 'feature', edgeStrength: 'heuristic', stale: true },
        ],
      };
      const events = [];
      service = new CoverageSearchService(store, graph, { onCoverageEvent: (e) => events.push(e) });
      await service.search('search_evidence');

      assert.equal(events.length, 1);
      assert.equal(events[0].conventionGraphStaleSkips, 2, 'should record 2 stale skips');
      assert.equal(events[0].conventionGraphUsed, true, 'graph was available');
    });
  });

  describe('Task 7: coverage nudge upgrade', () => {
    it('coverage nudge mentions intent=coverage for matching queries', async () => {
      const { composeCoverageIntentNudge } = await import('../../../mcp-server/dist/tools/evidence-coverage-nudge.js');
      const nudge = composeCoverageIntentNudge('哪些 thread 提过 Redis');
      assert.ok(nudge, 'should return nudge for coverage-intent pattern');
      assert.ok(nudge.includes('intent=coverage'), 'nudge should mention intent=coverage');
    });

    it('coverage nudge does not trigger for non-coverage queries', async () => {
      const { composeCoverageIntentNudge } = await import('../../../mcp-server/dist/tools/evidence-coverage-nudge.js');
      const nudge = composeCoverageIntentNudge('how to fix bug');
      assert.equal(nudge, null, 'should not nudge for non-coverage queries');
    });
  });
});

describe('F263 Phase A coverage contract', () => {
  it('honors a narrow scope and applies the caller limit to the returned matrix', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const calls = [];
    const store = {
      async searchWithMeta(query, options) {
        calls.push({ query, options });
        return {
          items: Array.from({ length: 30 }, (_, index) =>
            makeItem({ anchor: `thread-${index}`, title: `Thread ${index}`, kind: 'thread' }),
          ),
          meta: { degraded: false },
        };
      },
    };

    const service = new CoverageSearchService(store);
    const result = await service.search('memory', { scope: 'threads', mode: 'hybrid', limit: 15 });

    assert.deepEqual(
      calls.map((call) => call.options.scope),
      ['threads'],
      'scope=threads must not execute docs or convention-graph searches',
    );
    assert.equal(calls[0].options.limit, 50, 'coverage discovery must use one fixed bounded candidate envelope');
    assert.equal(calls[0].options.mode, 'hybrid');
    assert.equal(result.matrix.length, 15);
    assert.deepEqual(result.contract.requested, { scope: 'threads', mode: 'hybrid', limit: 15, offset: 0 });
    assert.deepEqual(result.contract.executed.scopes, ['threads']);
  });

  it('returns within a declared latency budget when a source stalls', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const store = { searchWithMeta: async () => new Promise(() => {}) };
    const service = new CoverageSearchService(store, null, { latencyBudgetMs: 20 });

    const startedAt = Date.now();
    const result = await service.search('slow query', { scope: 'threads', limit: 15 });

    assert.ok(Date.now() - startedAt < 250, 'coverage search must not wait indefinitely for a stalled source');
    assert.equal(result.contract.latency.budgetMs, 20);
    assert.equal(result.contract.latency.timedOut, true);
    assert.equal(result.contract.response.hasMore, false);
    assert.equal(result.contract.response.drillDown, undefined);
    assert.ok(result.degraded?.some((item) => item.source === 'threads' && item.reason.includes('latency budget')));
  });

  it('marks all-source timeout as retryable incomplete without a continuation pointer', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const service = new CoverageSearchService({ searchWithMeta: async () => new Promise(() => {}) }, null, {
      latencyBudgetMs: 20,
    });

    const result = await service.search('all stalled', { scope: 'all', limit: 20 });

    assert.deepEqual(result.matrix, []);
    assert.equal(result.contract.latency.timedOut, true);
    assert.equal(result.contract.response.hasMore, false);
    assert.equal(result.contract.response.drillDown, undefined);
    assert.deepEqual(result.degraded?.map((item) => item.source).sort(), ['docs', 'threads']);
  });

  it('keeps completed all-scope hits and degrades only the source that stalls', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const store = {
      async searchWithMeta(_query, options) {
        if (options.scope === 'threads') return new Promise(() => {});
        return {
          items: [makeItem({ anchor: 'doc-fast', title: 'Fast doc', kind: 'feature' })],
          meta: { degraded: false },
        };
      },
    };
    const service = new CoverageSearchService(store, null, { latencyBudgetMs: 20 });

    const result = await service.search('partial timeout', { scope: 'all', limit: 20 });

    assert.deepEqual(
      result.matrix.map((item) => item.anchor),
      ['doc-fast'],
      'a stalled thread source must not erase completed docs',
    );
    assert.equal(result.contract.latency.timedOut, true);
    assert.ok(result.degraded?.some((item) => item.source === 'threads'));
    assert.ok(!result.degraded?.some((item) => item.source === 'docs'));
  });

  it('caps serialized response size and returns an explicit continuation pointer', async () => {
    const coverageModule = await import('../../dist/domains/memory/CoverageSearchService.js');
    const { CoverageSearchService, COVERAGE_RESPONSE_CHAR_BUDGET } = coverageModule;
    const hugeThreads = Array.from({ length: 15 }, (_, index) =>
      makeItem({
        anchor: `thread-${index}`,
        title: `Thread ${index} ${'x'.repeat(8_000)}`,
        kind: 'thread',
      }),
    );
    const service = new CoverageSearchService(createMockEvidenceStore({ threads: hugeThreads }));

    const result = await service.search('wide query', { scope: 'threads', mode: 'hybrid', limit: 15 });
    const serializedChars = JSON.stringify(result).length;

    assert.equal(typeof COVERAGE_RESPONSE_CHAR_BUDGET, 'number');
    assert.ok(serializedChars <= COVERAGE_RESPONSE_CHAR_BUDGET, `${serializedChars} exceeds declared budget`);
    assert.equal(result.contract.response.truncated, true);
    assert.equal(result.contract.response.hasMore, true);
    assert.ok(result.contract.response.omittedItems > 0);
    assert.equal(result.contract.response.serializedChars, serializedChars);
    assert.equal(result.contract.response.drillDown.tool, 'cat_cafe_search_evidence');
    assert.equal(result.contract.response.drillDown.params.coverage_offset, String(result.matrix.length));
  });

  it('derives source counts and totalHits from the final budget-fitted matrix', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const threads = Array.from({ length: 12 }, (_, index) =>
      makeItem({
        anchor: `thread-${index}`,
        title: `T${index} ${'x'.repeat(1_838)}`,
        kind: 'thread',
      }),
    );
    const service = new CoverageSearchService(createMockEvidenceStore({ threads }));

    const result = await service.search('fixed point', { scope: 'threads', mode: 'hybrid', limit: 20 });
    const sourceCount = Object.values(result.bySource).reduce((sum, source) => sum + source.count, 0);

    assert.equal(sourceCount, result.matrix.length);
    assert.equal(result.totalHits, result.matrix.length);
  });

  it('uses post-dedup lookahead before declaring a narrow page complete', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = Array.from({ length: 25 }, (_, index) =>
      makeItem({ anchor: `doc-${index}`, title: `Doc ${index}`, kind: 'feature' }),
    );
    const service = new CoverageSearchService(createMockEvidenceStore({ docs }));

    const result = await service.search('exact limit', { scope: 'docs', limit: 15 });

    assert.equal(result.matrix.length, 15);
    assert.equal(result.contract.response.hasMore, true);
    assert.ok(result.contract.response.omittedItems > 0);
    assert.equal(result.contract.response.drillDown?.params.coverage_offset, '15');
  });

  it('keeps continuation pages disjoint when the store top-k prefix changes with k', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const calls = [];
    const smallRanking = ['thread-a', 'thread-b', 'thread-c', 'thread-drift', 'thread-e', 'thread-lookahead'];
    const largeRanking = [
      'thread-a',
      'thread-b',
      'thread-c',
      'thread-e',
      'thread-x',
      'thread-f',
      'thread-g',
      'thread-h',
      'thread-i',
      'thread-drift',
      'thread-lookahead',
    ];
    const store = {
      async searchWithMeta(_query, options) {
        calls.push(options.limit);
        const ranking = options.limit <= smallRanking.length ? smallRanking : largeRanking;
        return {
          items: ranking.slice(0, options.limit).map((anchor) => makeItem({ anchor, title: anchor, kind: 'thread' })),
          meta: { degraded: false },
        };
      },
    };
    const service = new CoverageSearchService(store);

    const first = await service.search('unstable hybrid prefix', {
      scope: 'threads',
      mode: 'hybrid',
      limit: 5,
    });
    const second = await service.search('unstable hybrid prefix', {
      scope: 'threads',
      mode: 'hybrid',
      limit: 5,
      offset: 5,
    });
    const firstAnchors = new Set(first.matrix.map((item) => item.anchor));
    const overlap = second.matrix.map((item) => item.anchor).filter((anchor) => firstAnchors.has(anchor));

    assert.deepEqual(overlap, [], `continuation repeated anchors: ${overlap.join(', ')}`);
    assert.deepEqual(calls, [50, 50], 'every page must reconstruct the same bounded candidate envelope');
  });

  it('represents an oversize item with a bounded placeholder and explicit unavailable drill state', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = [makeItem({ anchor: `doc-${'x'.repeat(30_000)}`, title: 'Oversize doc', kind: 'feature' })];
    const service = new CoverageSearchService(createMockEvidenceStore({ docs }));

    const result = await service.search('oversize', { scope: 'docs', limit: 15 });
    const [item] = result.matrix;

    assert.equal(item.representation, 'oversize-placeholder');
    assert.ok(item.identityDigest);
    assert.equal(item.drillDown, undefined);
    assert.equal(item.drillUnavailable?.code, 'source-reference-unavailable');
    assert.ok(JSON.stringify(item).length <= 512, 'placeholder must fit its declared item budget');
    assert.equal(result.contract.response.oversizeItems, 1);
    assert.equal(result.contract.response.hasMore, false);
    assert.equal(result.contract.response.drillDown, undefined);
    assert.equal(result.totalHits, 1);
  });

  it('preserves a bounded callable drill on an oversize placeholder', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = [
      makeItem({
        anchor: `doc-${'x'.repeat(30_000)}`,
        title: 'Oversize doc with drill',
        kind: 'feature',
        drillDown: {
          tool: 'cat_cafe_graph_resolve',
          params: { anchor: 'F263' },
          hint: 'Resolve F263',
        },
      }),
    ];
    const service = new CoverageSearchService(createMockEvidenceStore({ docs }));

    const result = await service.search('oversize drill', { scope: 'docs', limit: 15 });
    const [item] = result.matrix;

    assert.equal(item.representation, 'oversize-placeholder');
    assert.equal(item.drillDown?.tool, 'cat_cafe_graph_resolve');
    assert.equal(item.drillUnavailable, undefined);
    assert.ok(JSON.stringify(item).length <= 512, 'placeholder with drill must remain bounded');
  });

  it('advances past an oversize placeholder when a later candidate remains', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = [
      makeItem({ anchor: `doc-${'x'.repeat(30_000)}`, title: 'Oversize first', kind: 'feature' }),
      makeItem({ anchor: 'doc-next', title: 'Next doc', kind: 'feature' }),
    ];
    const service = new CoverageSearchService(createMockEvidenceStore({ docs }));

    const result = await service.search('oversize progress', { scope: 'docs', limit: 2 });

    assert.equal(result.matrix[0].representation, 'oversize-placeholder');
    assert.equal(result.contract.response.hasMore, true);
    assert.equal(result.contract.response.drillDown?.params.coverage_offset, '1');
  });

  it('returns an out-of-range offset as a complete empty terminal page', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = [makeItem({ anchor: 'doc-only', title: 'Only doc', kind: 'feature' })];
    const service = new CoverageSearchService(createMockEvidenceStore({ docs }));

    const result = await service.search('past end', { scope: 'docs', limit: 5, offset: 10 });

    assert.deepEqual(result.matrix, []);
    assert.equal(result.contract.response.hasMore, false);
    assert.equal(result.contract.response.drillDown, undefined);
    assert.equal(result.contract.latency.timedOut, false);
  });

  it('records convention graph usage only when a graph query actually executes', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = [makeItem({ anchor: 'F263', title: 'F263', kind: 'feature' })];
    const store = createMockEvidenceStore({ docs });
    const events = [];
    const graph = { isAvailable: () => true, queryConsumers: async () => [] };
    const service = new CoverageSearchService(store, graph, { onCoverageEvent: (event) => events.push(event) });

    await service.search('narrow graph skip', { scope: 'docs', limit: 5 });
    await service.search('all graph zero results', { scope: 'all', limit: 5 });

    assert.equal(events[0].conventionGraphUsed, false);
    assert.equal(events[1].conventionGraphUsed, true);
  });

  it('preserves thread hits across all-scope continuation pages when docs exceed their quota', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const docs = Array.from({ length: 60 }, (_, index) =>
      makeItem({ anchor: `doc-${index}`, title: `Doc ${index}`, kind: 'feature' }),
    );
    const threads = Array.from({ length: 10 }, (_, index) =>
      makeItem({ anchor: `thread-${index}`, title: `Thread ${index}`, kind: 'thread' }),
    );
    const service = new CoverageSearchService(createMockEvidenceStore({ docs, threads }));

    const seen = [];
    let offset = 0;
    for (let page = 0; page < 3; page++) {
      const result = await service.search('wide all-scope query', {
        scope: 'all',
        mode: 'hybrid',
        limit: 20,
        offset,
      });
      seen.push(...result.matrix);
      const nextOffset = result.contract.response.drillDown?.params.coverage_offset;
      if (!nextOffset) break;
      offset = Number(nextOffset);
    }

    assert.ok(
      seen.some((item) => item.source === 'threads'),
      'continuation must not permanently hide thread hits',
    );
  });
});

describe('Coverage search hard latency budget and observability', () => {
  it('interrupts synchronous/microtask expansion close to the real budget instead of starving the timer', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    let calls = 0;
    const store = {
      async searchWithMeta(query, options) {
        calls++;
        const blockedUntil = Date.now() + 12;
        while (Date.now() < blockedUntil) {
          // Reproduce short better-sqlite3/vector slices that monopolize the event loop.
        }
        options?.signal?.throwIfAborted();
        if (query === 'root') {
          return {
            items: Array.from({ length: 25 }, (_, index) =>
              makeItem({
                anchor: `doc-${index}`,
                title: `Doc ${index}`,
                kind: 'feature',
                keywords: [`expand-${index}`],
              }),
            ),
            meta: { degraded: false },
          };
        }
        return { items: [], meta: { degraded: false } };
      },
    };
    const service = new CoverageSearchService(store, null, { latencyBudgetMs: 60 });

    const startedAt = Date.now();
    const result = await service.search('root', { scope: 'docs', mode: 'hybrid', limit: 20 });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 180, `60ms budget returned after ${elapsedMs}ms`);
    assert.equal(result.contract.latency.timedOut, true);
    assert.ok(calls < 26, `deadline should stop expansion work, observed ${calls} calls`);
    assert.ok(result.degraded?.some((item) => item.reason.includes('latency budget')));
  });

  it('aborts an in-flight async source and leaves no active background work after returning partial', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    let active = 0;
    let abortObserved = false;
    const store = {
      searchWithMeta(_query, options) {
        active++;
        return new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              active--;
              resolve({ items: [], meta: { degraded: false } });
            },
            { once: true },
          );
        });
      },
    };
    const service = new CoverageSearchService(store, null, { latencyBudgetMs: 30 });

    const result = await service.search('async stall', { scope: 'threads', limit: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(result.contract.latency.timedOut, true);
    assert.equal(abortObserved, true, 'deadline must propagate an AbortSignal into the evidence store');
    assert.equal(active, 0, 'timed-out work must not remain active after the partial response');
  });

  it(
    'enforces the production 15,000ms wall-clock budget and cancels the stalled source',
    { timeout: 20_000 },
    async () => {
      const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
      let active = 0;
      const store = {
        searchWithMeta(_query, options) {
          active++;
          return new Promise((resolve) => {
            options.signal.addEventListener(
              'abort',
              () => {
                active--;
                resolve({ items: [], meta: { degraded: false } });
              },
              { once: true },
            );
          });
        },
      };
      const service = new CoverageSearchService(store);

      const startedAt = Date.now();
      const result = await service.search('production budget stall', { scope: 'docs', limit: 5 });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.contract.latency.budgetMs, 15_000);
      assert.equal(result.contract.latency.timedOut, true);
      assert.equal(result.contract.latency.abortPropagated, true);
      assert.equal(active, 0);
      assert.ok(elapsedMs >= 14_500, `production deadline fired too early at ${elapsedMs}ms`);
      assert.ok(elapsedMs < 16_000, `15s production budget returned after ${elapsedMs}ms`);
    },
  );

  it('emits bounded per-stage evidence including fan-out, expansion, serialization, lag, and abort state', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const events = [];
    const store = {
      async searchWithMeta(query, options) {
        options?.signal?.throwIfAborted();
        if (query === 'observed' && options.scope === 'docs') {
          return {
            items: [
              makeItem({
                anchor: 'doc-observed',
                title: 'Observed doc',
                kind: 'feature',
                keywords: ['observed-alias'],
              }),
            ],
            meta: { degraded: false },
          };
        }
        if (query === 'observed' && options.scope === 'threads') {
          return {
            items: [makeItem({ anchor: 'thread-observed', title: 'Observed thread', kind: 'thread' })],
            meta: { degraded: false },
          };
        }
        return { items: [], meta: { degraded: false } };
      },
    };
    const service = new CoverageSearchService(store, null, {
      latencyBudgetMs: 500,
      onCoverageStageEvent: (event) => events.push(event),
    });

    const result = await service.search('observed', { scope: 'all', mode: 'hybrid', limit: 5 });
    const stages = new Set(events.map((event) => event.stage));

    assert.ok(stages.has('direct-docs'));
    assert.ok(stages.has('direct-threads'));
    assert.ok(stages.has('frontmatter-expansion'));
    assert.ok(stages.has('source-thread-expansion'));
    assert.ok(stages.has('serialization'));
    assert.ok(events.every((event) => Number.isFinite(event.durationMs)));
    assert.ok(events.every((event) => Number.isFinite(event.remainingBudgetMs)));
    assert.ok(events.every((event) => Number.isFinite(event.eventLoopLagMs)));
    assert.equal(typeof result.contract.latency.eventLoopLagMaxMs, 'number');
    assert.equal(typeof result.contract.latency.abortPropagated, 'boolean');
  });

  it('uses bounded lexical lookups for structured expansion instead of multiplying embedding HTTP calls', async () => {
    const { CoverageSearchService } = await import('../../dist/domains/memory/CoverageSearchService.js');
    const calls = [];
    const store = {
      async searchWithMeta(query, options) {
        calls.push({ query, mode: options.mode });
        if (query === 'root') {
          return {
            items: Array.from({ length: 25 }, (_, index) =>
              makeItem({
                anchor: `doc-${index}`,
                title: `Doc ${index}`,
                kind: 'feature',
                keywords: [`alias-${index}`],
              }),
            ),
            meta: { degraded: false },
          };
        }
        return { items: [], meta: { degraded: false } };
      },
    };
    const service = new CoverageSearchService(store, null, { latencyBudgetMs: 1_000 });

    await service.search('root', { scope: 'docs', mode: 'semantic', limit: 20 });

    assert.equal(calls[0].mode, 'semantic', 'direct retrieval must preserve caller mode');
    assert.ok(
      calls.slice(1).every((call) => call.mode === 'lexical'),
      'structured expansion must be lexical',
    );
    assert.ok(calls.length <= 22, `expansion work must be bounded, observed ${calls.length} calls`);
  });
});
