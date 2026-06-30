// F256 Phase B: TopkExpansionService — expansion hints for default topk search
// TDD Red phase: tests written before implementation.
//
// Design: discussion doc §6.4 取舍 A-D + §7.5 graphTraversal=0% constraint.
// AC-B1: topk results include independent "Related directions" block
// AC-B2: provenance (frontmatter/source-thread/convention-edge) visible per hint
// AC-B3: F200 followup rate tracking (wired in route, not tested here)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Test helpers (same pattern as coverage-search.test.js) ───────────

/**
 * Creates a mock evidence store that returns different results per scope.
 * @param {{ docs?: Array<Record<string,any>>, threads?: Array<Record<string,any>> }} scopeResults
 */
function createMockStore(scopeResults = {}) {
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
 * @param {Partial<Record<string,any>>} overrides
 */
function makeItem(overrides) {
  return {
    anchor: overrides.anchor || 'test-anchor',
    kind: overrides.kind || 'feature',
    status: overrides.status || 'active',
    title: overrides.title || 'Test Item',
    summary: overrides.summary || '',
    sourcePath: overrides.sourcePath || '',
    updatedAt: overrides.updatedAt || '2026-06-29T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('TopkExpansionService', () => {
  async function createService(store) {
    const { TopkExpansionService } = await import('../../dist/domains/memory/TopkExpansionService.js');
    return new TopkExpansionService(store);
  }

  describe('baseline behavior', () => {
    it('returns empty hints when results have no keywords or sourceIds', async () => {
      const store = createMockStore({ docs: [] });
      const service = await createService(store);

      const topResults = [makeItem({ anchor: 'F100', title: 'No Keywords Feature' })];
      const hints = await service.expand(topResults, 'test query');

      assert.ok(Array.isArray(hints));
      assert.equal(hints.length, 0);
    });

    it('returns empty hints for empty results array', async () => {
      const store = createMockStore({ docs: [] });
      const service = await createService(store);

      const hints = await service.expand([], 'test query');

      assert.ok(Array.isArray(hints));
      assert.equal(hints.length, 0);
    });
  });

  describe('frontmatter-alias expansion (AC-B1, AC-B2)', () => {
    it('expands via keywords from top results and returns hints with provenance', async () => {
      // Top result has keyword "routing" → secondary search finds F208
      const expansionHit = makeItem({
        anchor: 'F208-capability-profile',
        title: 'Capability Profile Routing',
        kind: 'feature',
        sourcePath: 'features/F208.md',
      });
      const store = createMockStore({
        docs: [expansionHit],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102-routing',
          title: 'Routing System',
          keywords: ['routing', 'mention'],
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      assert.ok(hints.length > 0, 'should have at least one hint');
      const hint = hints[0];
      assert.equal(hint.anchor, 'F208-capability-profile');
      assert.equal(hint.title, 'Capability Profile Routing');
      // AC-B2: provenance visible
      assert.ok(hint.provenance, 'hint must have provenance');
      assert.equal(hint.provenance.source, 'frontmatter-alias');
      assert.ok(hint.provenance.via.includes('routing'), 'via should include the keyword');
      assert.equal(hint.provenance.confidence, 'heuristic');
    });

    it('deduplicates hints that are already in main results', async () => {
      // Expansion search returns F102 which is already in top results
      const store = createMockStore({
        docs: [makeItem({ anchor: 'F102-routing', title: 'Already in results' })],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102-routing',
          title: 'Routing System',
          keywords: ['routing'],
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      // F102-routing already in topResults, should not appear as hint
      assert.equal(hints.filter((h) => h.anchor === 'F102-routing').length, 0);
    });
  });

  describe('source-thread expansion (AC-B2)', () => {
    it('expands via thread references in summary and returns hints with provenance', async () => {
      const threadHit = makeItem({
        anchor: 'thread-abc123-digest',
        title: 'Discussion about routing design',
        kind: 'thread',
        sourcePath: '',
      });
      const store = createMockStore({
        threads: [threadHit],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102-routing',
          title: 'Routing System',
          summary: 'Discussed in thread-abc123 and thread-def456',
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      const threadHints = hints.filter((h) => h.provenance.source === 'source-thread');
      assert.ok(threadHints.length > 0, 'should have thread expansion hints');
      assert.equal(threadHints[0].provenance.source, 'source-thread');
      assert.ok(threadHints[0].provenance.via.includes('thread-'), 'via should contain thread ref');
      assert.equal(threadHints[0].provenance.confidence, 'heuristic');
    });

    it('expands via sourceIds containing thread references', async () => {
      const threadHit = makeItem({
        anchor: 'thread-xyz789-digest',
        title: 'Thread XYZ',
        kind: 'thread',
      });
      const store = createMockStore({
        threads: [threadHit],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F200-memory',
          title: 'Memory Eval',
          sourceIds: ['thread-xyz789'],
        }),
      ];
      const hints = await service.expand(topResults, 'memory');

      const threadHints = hints.filter((h) => h.provenance.source === 'source-thread');
      assert.ok(threadHints.length > 0, 'should find thread via sourceIds');
    });
  });

  describe('budget controls (§6.4 取舍 A)', () => {
    it('only expands top-3 results by default', async () => {
      // 5 results with keywords, but only top 3 should be expanded
      const store = createMockStore({
        docs: [
          makeItem({ anchor: 'expansion-hit-1', title: 'Hit 1' }),
          makeItem({ anchor: 'expansion-hit-2', title: 'Hit 2' }),
        ],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({ anchor: 'R1', title: 'Result 1', keywords: ['alpha'] }),
        makeItem({ anchor: 'R2', title: 'Result 2', keywords: ['beta'] }),
        makeItem({ anchor: 'R3', title: 'Result 3', keywords: ['gamma'] }),
        makeItem({ anchor: 'R4', title: 'Result 4', keywords: ['delta'] }),
        makeItem({ anchor: 'R5', title: 'Result 5', keywords: ['epsilon'] }),
      ];
      const hints = await service.expand(topResults, 'test');

      // Service should only process R1-R3 keywords, not R4-R5
      // We can verify by checking the store was not queried for 'delta' or 'epsilon'
      // But a simpler check: hints should only come from expanding alpha/beta/gamma
      for (const hint of hints) {
        if (hint.provenance.source === 'frontmatter-alias') {
          const via = hint.provenance.via;
          assert.ok(
            !via.includes('delta') && !via.includes('epsilon'),
            `hint via "${via}" should not come from results beyond top-3`,
          );
        }
      }
    });

    it('limits each expansion type to maxHintsPerType (default 3)', async () => {
      // Return many expansion hits, but should cap at 3
      const manyHits = Array.from({ length: 10 }, (_, i) => makeItem({ anchor: `exp-${i}`, title: `Expansion ${i}` }));
      const store = createMockStore({ docs: manyHits });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102',
          title: 'Routing',
          keywords: ['routing', 'mention', 'system', 'protocol'],
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      const frontmatterHints = hints.filter((h) => h.provenance.source === 'frontmatter-alias');
      assert.ok(frontmatterHints.length <= 3, `frontmatter hints should be ≤3, got ${frontmatterHints.length}`);
    });

    it('respects custom maxHitsToExpand option', async () => {
      const store = createMockStore({
        docs: [makeItem({ anchor: 'hit', title: 'Hit' })],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({ anchor: 'R1', keywords: ['a'] }),
        makeItem({ anchor: 'R2', keywords: ['b'] }),
        makeItem({ anchor: 'R3', keywords: ['c'] }),
      ];

      // maxHitsToExpand=1: only first result expanded
      const hints = await service.expand(topResults, 'test', { maxHitsToExpand: 1 });

      for (const hint of hints) {
        if (hint.provenance.source === 'frontmatter-alias') {
          assert.ok(
            !hint.provenance.via.includes('b') && !hint.provenance.via.includes('c'),
            'should only expand first result',
          );
        }
      }
    });
  });

  describe('query budget (砚砚 review P1-2)', () => {
    it('caps internal searchWithMeta calls to MAX_TERMS_PER_TYPE (5)', async () => {
      // 10 keywords but only 5 should trigger searchWithMeta calls
      let searchCallCount = 0;
      const store = {
        async searchWithMeta(_query, _options) {
          searchCallCount++;
          return { items: [], meta: { degraded: false } };
        },
      };
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102',
          title: 'Routing',
          keywords: ['kw1', 'kw2', 'kw3', 'kw4', 'kw5', 'kw6', 'kw7', 'kw8', 'kw9', 'kw10'],
        }),
      ];
      await service.expand(topResults, 'test');

      // 5 keyword probes + 0 thread probes (no thread refs)
      assert.ok(searchCallCount <= 5, `should cap keyword probes at 5, got ${searchCallCount}`);
    });

    it('caps thread ref probes to MAX_TERMS_PER_TYPE (5)', async () => {
      let searchCallCount = 0;
      const store = {
        async searchWithMeta(_query, _options) {
          searchCallCount++;
          return { items: [], meta: { degraded: false } };
        },
      };
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102',
          title: 'Discussion',
          summary: 'thread-a1 thread-b2 thread-c3 thread-d4 thread-e5 thread-f6 thread-g7 thread-h8',
        }),
      ];
      await service.expand(topResults, 'test');

      // 0 keyword probes + 5 thread probes (capped from 8)
      assert.ok(searchCallCount <= 5, `should cap thread probes at 5, got ${searchCallCount}`);
    });
  });

  describe('convention-edge exclusion (§7.5 graphTraversal=0%)', () => {
    it('does NOT produce convention-edge hints (Phase B constraint)', async () => {
      const store = createMockStore({ docs: [] });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102-routing',
          title: 'Routing System',
          keywords: ['routing'],
          summary: 'Thread reference: thread-abc123',
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      const conventionHints = hints.filter((h) => h.provenance.source === 'convention-edge');
      assert.equal(conventionHints.length, 0, 'Phase B should not produce convention-edge hints (graphTraversal=0%)');
    });
  });

  describe('cross-type dedup', () => {
    it('deduplicates across expansion types (same anchor from keyword + thread)', async () => {
      // Same anchor found via both keyword expansion and thread expansion
      const sharedItem = makeItem({
        anchor: 'shared-finding',
        title: 'Found Both Ways',
        kind: 'feature',
      });
      const store = createMockStore({
        docs: [sharedItem],
        threads: [sharedItem],
      });
      const service = await createService(store);

      const topResults = [
        makeItem({
          anchor: 'F102',
          title: 'Routing',
          keywords: ['shared-finding'],
          summary: 'See thread-shared-finding for discussion',
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      const matchingHints = hints.filter((h) => h.anchor === 'shared-finding');
      assert.ok(
        matchingHints.length <= 1,
        `anchor "shared-finding" should appear at most once, got ${matchingHints.length}`,
      );
    });
  });
});
