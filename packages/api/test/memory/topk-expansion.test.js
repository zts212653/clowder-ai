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

  // ── Shared graph adapter helpers (hoisted for health funnel tests) ──
  function createMockGraphAdapterTop(consumersByName = {}) {
    return {
      queryConsumers(name) {
        return Promise.resolve(consumersByName[name] || []);
      },
      isAvailable() {
        return true;
      },
    };
  }

  async function createServiceWithGraphTop(store, graphAdapter) {
    const { TopkExpansionService } = await import('../../dist/domains/memory/TopkExpansionService.js');
    return new TopkExpansionService(store, graphAdapter);
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
      assert.equal(hint.provenance.edgeStrength, 'heuristic');
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
        anchor: 'thread-thread_abc',
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
      assert.equal(threadHints[0].provenance.edgeStrength, 'heuristic');
      assert.deepEqual(threadHints[0].targetRef, { kind: 'thread', threadId: 'thread_abc' });
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

  describe('convention-edge expansion (Phase C)', () => {
    /**
     * Creates a mock ConventionGraphAdapter for testing.
     * @param {Record<string, Array<{anchor: string, title: string, kind: string, filePath?: string, edgeStrength: string, stale: boolean}>>} consumersByName
     */
    function createMockGraphAdapter(consumersByName = {}) {
      return {
        queryConsumers(name) {
          return Promise.resolve(consumersByName[name] || []);
        },
        isAvailable() {
          return true;
        },
      };
    }

    async function createServiceWithGraph(store, graphAdapter) {
      const { TopkExpansionService } = await import('../../dist/domains/memory/TopkExpansionService.js');
      return new TopkExpansionService(store, graphAdapter);
    }

    it('produces convention-edge hints when adapter is available', async () => {
      const store = createMockStore({ docs: [] });
      const adapter = createMockGraphAdapter({
        'F102-routing': [
          {
            anchor: 'F208-cat-dossier',
            title: 'Cat Dossier (F208)',
            kind: 'l0_data_source',
            filePath: 'docs/team/cat-dossier.md',
            edgeStrength: 'static',
            stale: false,
          },
        ],
      });
      const service = await createServiceWithGraph(store, adapter);

      const topResults = [
        makeItem({
          anchor: 'F102-routing',
          title: 'Routing System',
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      const conventionHints = hints.filter((h) => h.provenance.source === 'convention-edge');
      assert.ok(conventionHints.length > 0, 'should have convention-edge hints');
      assert.equal(conventionHints[0].anchor, 'F208-cat-dossier');
      assert.equal(conventionHints[0].provenance.source, 'convention-edge');
      assert.equal(conventionHints[0].provenance.edgeStrength, 'static');
    });

    it('does NOT produce convention-edge hints when no adapter', async () => {
      const store = createMockStore({ docs: [] });
      const service = await createService(store); // no adapter

      const topResults = [
        makeItem({
          anchor: 'F102-routing',
          title: 'Routing System',
          keywords: ['routing'],
        }),
      ];
      const hints = await service.expand(topResults, 'routing');

      const conventionHints = hints.filter((h) => h.provenance.source === 'convention-edge');
      assert.equal(conventionHints.length, 0, 'no adapter → no convention-edge hints');
    });

    it('skips stale convention graph results', async () => {
      const store = createMockStore({ docs: [] });
      const adapter = createMockGraphAdapter({
        'stale-anchor': [
          {
            anchor: 'stale-consumer',
            title: 'Stale Result',
            kind: 'l0_section',
            edgeStrength: 'static',
            stale: true, // marked stale
          },
        ],
      });
      const service = await createServiceWithGraph(store, adapter);

      const topResults = [makeItem({ anchor: 'stale-anchor', title: 'Source' })];
      const hints = await service.expand(topResults, 'test');

      const conventionHints = hints.filter((h) => h.provenance.source === 'convention-edge');
      assert.equal(conventionHints.length, 0, 'stale convention results should be skipped');
    });

    it('deduplicates convention-edge hints against main results and other hints', async () => {
      const store = createMockStore({
        docs: [makeItem({ anchor: 'keyword-hit', title: 'Via Keyword' })],
      });
      const adapter = createMockGraphAdapter({
        'F102-routing': [
          {
            anchor: 'keyword-hit',
            title: 'Same via convention',
            kind: 'feature',
            edgeStrength: 'static',
            stale: false,
          },
          { anchor: 'F102-routing', title: 'Self reference', kind: 'feature', edgeStrength: 'static', stale: false },
        ],
      });
      const service = await createServiceWithGraph(store, adapter);

      const topResults = [makeItem({ anchor: 'F102-routing', title: 'Routing', keywords: ['keyword-hit'] })];
      const hints = await service.expand(topResults, 'routing');

      // keyword-hit already found via frontmatter-alias, should not appear again as convention-edge
      const conventionForKeywordHit = hints.filter(
        (h) => h.anchor === 'keyword-hit' && h.provenance.source === 'convention-edge',
      );
      assert.equal(conventionForKeywordHit.length, 0, 'should not duplicate keyword-hit as convention-edge');

      // F102-routing is in main results, should not appear as hint
      const selfHints = hints.filter((h) => h.anchor === 'F102-routing');
      assert.equal(selfHints.length, 0, 'should not hint back to a main result');
    });

    it('limits convention-edge hints to maxHintsPerType', async () => {
      const store = createMockStore({ docs: [] });
      const manyConsumers = Array.from({ length: 10 }, (_, i) => ({
        anchor: `convention-${i}`,
        title: `Convention ${i}`,
        kind: 'l0_section',
        edgeStrength: 'static',
        stale: false,
      }));
      const adapter = createMockGraphAdapter({ F102: manyConsumers });
      const service = await createServiceWithGraph(store, adapter);

      const topResults = [makeItem({ anchor: 'F102', title: 'Source' })];
      const hints = await service.expand(topResults, 'test');

      const conventionHints = hints.filter((h) => h.provenance.source === 'convention-edge');
      assert.ok(conventionHints.length <= 3, `convention hints should be ≤3, got ${conventionHints.length}`);
    });

    it('AC-C2 flagship: convention edge connects routing to dossier', async () => {
      // This is the signature test for Phase C:
      // search "routing" → top result mentions routing → convention edge → F208 dossier
      //
      // The mock simulates real adapter output: cross-kind results sort first,
      // so dossier (l0_data_source) appears before same-kind sections (l0_section).
      // With maxPerType=3, dossier survives the budget cut despite 7 total siblings.
      const store = createMockStore({ docs: [] });
      const adapter = createMockGraphAdapter({
        'l3-routing-rules': [
          // Cross-kind result first (adapter sorts these ahead)
          {
            anchor: 'doc:docs/team/cat-dossier',
            title: 'Cat Dossier — L0 data source (feeds {{TEAMMATE_ROSTER}})',
            kind: 'l0_data_source',
            filePath: 'docs/team/cat-dossier.md',
            edgeStrength: 'static',
            stale: false,
          },
          // Same-kind siblings (these would be capped out by budget)
          {
            anchor: 'l1-parallel-world.md',
            title: 'L1 Section',
            kind: 'l0_section',
            edgeStrength: 'static',
            stale: false,
          },
          { anchor: 'l2-carry-over.md', title: 'L2 Section', kind: 'l0_section', edgeStrength: 'static', stale: false },
          { anchor: 'l4-iron-laws.md', title: 'L4 Section', kind: 'l0_section', edgeStrength: 'static', stale: false },
          {
            anchor: 'l5-mcp-tools-index.md',
            title: 'L5 Section',
            kind: 'l0_section',
            edgeStrength: 'static',
            stale: false,
          },
          {
            anchor: 'l6-capability-wakeup.md',
            title: 'L6 Section',
            kind: 'l0_section',
            edgeStrength: 'static',
            stale: false,
          },
          {
            anchor: 'l7-collaboration-philosophy.md',
            title: 'L7 Section',
            kind: 'l0_section',
            edgeStrength: 'static',
            stale: false,
          },
        ],
      });
      const service = await createServiceWithGraph(store, adapter);

      const topResults = [
        makeItem({
          anchor: 'l3-routing-rules',
          title: 'Routing Rules (L3)',
          sourcePath: 'assets/prompt-templates/l3-routing-rules.md',
        }),
      ];
      const hints = await service.expand(topResults, '路由');

      // Dossier should be surfaced despite 7 siblings (it's first because cross-kind)
      const dossierHint = hints.find((h) => h.anchor === 'doc:docs/team/cat-dossier');
      assert.ok(dossierHint, 'searching routing should find dossier via convention edge');
      assert.equal(dossierHint.provenance.source, 'convention-edge');
      assert.ok(
        dossierHint.provenance.via.includes('l3-routing-rules'),
        'provenance should trace back to the routing result',
      );
      // Evidence anchor format should be followable through the memory stack
      assert.ok(dossierHint.anchor.startsWith('doc:'), 'hint anchor should use evidence-compatible doc: format');
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

  // ── F256 health funnel: expandWithMeta returns per-stage counts ──────
  describe('expandWithMeta — health funnel telemetry', () => {
    it('returns funnel metadata alongside hints', async () => {
      const store = createMockStore({
        docs: [makeItem({ anchor: 'extra-doc', title: 'Extra', kind: 'doc' })],
      });
      const service = await createService(store);
      const topResults = [makeItem({ anchor: 'main-result', keywords: ['testing'], title: 'Main' })];

      const result = await service.expandWithMeta(topResults, 'test');

      // Must return both hints and funnel metadata
      assert.ok(Array.isArray(result.hints), 'result.hints should be an array');
      assert.ok(result.funnel, 'result.funnel should exist');
      assert.equal(result.funnel.attempted, true);
      assert.equal(typeof result.funnel.keyword.probed, 'number');
      assert.equal(typeof result.funnel.keyword.added, 'number');
      assert.equal(typeof result.funnel.sourceThread.probed, 'number');
      assert.equal(typeof result.funnel.conventionEdge.attempted, 'boolean');
      assert.equal(result.funnel.presented, result.hints.length);
    });

    it('records zero counts when no expansion sources exist', async () => {
      const store = createMockStore({ docs: [] });
      const service = await createService(store);
      const topResults = [makeItem({ anchor: 'bare-result', title: 'Bare' })];

      const result = await service.expandWithMeta(topResults, 'test');

      assert.equal(result.funnel.attempted, true);
      assert.equal(result.funnel.keyword.probed, 0);
      assert.equal(result.funnel.keyword.added, 0);
      assert.equal(result.funnel.sourceThread.probed, 0);
      assert.equal(result.funnel.sourceThread.added, 0);
      assert.equal(result.funnel.conventionEdge.attempted, false, 'no convention graph configured');
      assert.equal(result.funnel.presented, 0);
    });

    it('tracks dedup count separately from added', async () => {
      // If keyword expansion finds items already in top-k, deduped should increment
      const store = createMockStore({
        docs: [makeItem({ anchor: 'main-result', title: 'Same' })],
      });
      const service = await createService(store);
      const topResults = [makeItem({ anchor: 'main-result', keywords: ['overlap'], title: 'Main' })];

      const result = await service.expandWithMeta(topResults, 'test');

      assert.equal(result.funnel.keyword.probed, 1, 'should probe the keyword');
      assert.equal(result.funnel.keyword.added, 0, 'should not add (deduped)');
      assert.ok(result.funnel.keyword.deduped >= 1, 'should count deduped items');
    });

    it('records convention-edge funnel when graph is available', async () => {
      const store = createMockStore({ docs: [] });
      const adapter = createMockGraphAdapterTop({
        'test-anchor': [
          {
            anchor: 'sibling-1',
            title: 'Sibling',
            kind: 'l0_section',
            edgeStrength: 'static',
            stale: false,
          },
        ],
      });
      const service = await createServiceWithGraphTop(store, adapter);
      const topResults = [makeItem({ anchor: 'test-anchor', title: 'Source' })];

      const result = await service.expandWithMeta(topResults, 'test');

      assert.equal(result.funnel.conventionEdge.attempted, true);
      assert.equal(result.funnel.conventionEdge.added, 1);
    });

    it('empty results returns short-circuit funnel', async () => {
      const store = createMockStore({});
      const service = await createService(store);

      const result = await service.expandWithMeta([], 'test');

      assert.deepEqual(result.hints, []);
      assert.equal(result.funnel.attempted, false);
      assert.equal(result.funnel.presented, 0);
    });
  });
});
