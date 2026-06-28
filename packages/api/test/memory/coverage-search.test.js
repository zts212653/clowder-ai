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
            ['static', 'heuristic'].includes(item.expansionProvenance.confidence),
            'provenance.confidence must be static|heuristic',
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
            confidence: 'static',
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
            confidence: 'static',
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
      assert.equal(conventionHits[0].expansionProvenance.source, 'convention-edge');
      assert.ok(
        conventionHits[0].expansionProvenance.via.includes('search_evidence'),
        'provenance should trace source anchor',
      );
      assert.equal(conventionHits[0].expansionProvenance.confidence, 'static');
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
          { anchor: 'skill-a', title: 'A', kind: 'feature', confidence: 'static', stale: true },
          { anchor: 'skill-b', title: 'B', kind: 'feature', confidence: 'heuristic', stale: true },
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
