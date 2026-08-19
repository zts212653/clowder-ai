// F256 Phase C: L0ConventionGraphAdapter tests
// Tests the lightweight adapter that bridges evidence anchors to convention graph siblings.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('L0ConventionGraphAdapter', () => {
  async function importAdapter() {
    const mod = await import('../../dist/domains/memory/L0ConventionGraphAdapter.js');
    return mod.L0ConventionGraphAdapter;
  }

  describe('fromNodes (in-memory construction)', () => {
    it('returns siblings for a known node', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
        {
          name: 'cat-dossier',
          kind: 'l0_data_source',
          filePath: 'docs/team/cat-dossier.md',
          templateVar: 'TEAMMATE_ROSTER',
        },
        { name: 'l1-parallel-world.md', kind: 'l0_section', templateVar: 'L1_CONTENT' },
      ]);

      const consumers = await adapter.queryConsumers('l3-routing-rules.md');
      assert.ok(consumers.length > 0, 'should find siblings');
      // Dossier anchor uses evidence-compatible format (doc:<path>) since filePath starts with docs/
      const dossier = consumers.find((c) => c.anchor === 'doc:docs/team/cat-dossier');
      assert.ok(dossier, 'should include cat-dossier as sibling with evidence-compatible anchor');
      assert.equal(dossier.edgeStrength, 'static');
      assert.equal(dossier.stale, false);
    });

    it('does not include self in siblings', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
        {
          name: 'cat-dossier',
          kind: 'l0_data_source',
          filePath: 'docs/team/cat-dossier.md',
          templateVar: 'TEAMMATE_ROSTER',
        },
      ]);

      const consumers = await adapter.queryConsumers('l3-routing-rules.md');
      const self = consumers.find((c) => c.anchor === 'l3-routing-rules.md');
      assert.equal(self, undefined, 'should not include self as sibling');
    });

    it('sorts cross-kind siblings first (P1-1 fix)', async () => {
      const Adapter = await importAdapter();
      // Simulate full L0 topology: 7 sections + 1 data source
      const adapter = Adapter.fromNodes([
        { name: 'l1-parallel-world.md', kind: 'l0_section', templateVar: 'L1_CONTENT' },
        { name: 'l2-carry-over.md', kind: 'l0_section', templateVar: 'L2_CONTENT' },
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
        { name: 'l4-iron-laws.md', kind: 'l0_section', templateVar: 'L4_CONTENT' },
        { name: 'l5-mcp-tools-index.md', kind: 'l0_section', templateVar: 'L5_CONTENT' },
        { name: 'l6-capability-wakeup.md', kind: 'l0_section', templateVar: 'L6_CONTENT' },
        { name: 'l7-collaboration-philosophy.md', kind: 'l0_section', templateVar: 'L7_CONTENT' },
        {
          name: 'cat-dossier',
          kind: 'l0_data_source',
          filePath: 'docs/team/cat-dossier.md',
          templateVar: 'TEAMMATE_ROSTER',
        },
      ]);

      // Query a section → dossier (different kind) should come FIRST despite being
      // last in insertion order. This is critical: TopkExpansionService caps at 3,
      // so dossier must be in the first 3 to survive the budget cut.
      const consumers = await adapter.queryConsumers('l3-routing-rules.md');
      assert.equal(consumers.length, 7, 'should have 7 siblings (6 sections + 1 dossier)');
      assert.equal(consumers[0].kind, 'l0_data_source', 'cross-kind result (dossier) should sort first');
      assert.equal(consumers[0].anchor, 'doc:docs/team/cat-dossier', 'first result should be dossier');

      // Reverse: query dossier → sections (different kind) should come first
      const dossierConsumers = await adapter.queryConsumers('cat-dossier');
      assert.equal(dossierConsumers.length, 7, 'dossier should have 7 siblings');
      // All 7 are l0_section (all cross-kind from dossier's perspective), so order doesn't matter
      assert.ok(
        dossierConsumers.every((c) => c.kind === 'l0_section'),
        'all dossier siblings should be sections',
      );
    });

    it('matches stripped filename (without .md)', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
        { name: 'cat-dossier', kind: 'l0_data_source', templateVar: 'TEAMMATE_ROSTER' },
      ]);

      const consumers = await adapter.queryConsumers('l3-routing-rules');
      assert.ok(consumers.length > 0, 'should match stripped name without .md');
    });

    it('matches by substring containment', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
        { name: 'cat-dossier', kind: 'l0_data_source', templateVar: 'TEAMMATE_ROSTER' },
      ]);

      // Evidence anchors may not exactly match node names; containment helps
      const consumers = await adapter.queryConsumers('routing-rules');
      assert.ok(consumers.length > 0, 'should match by substring');
    });

    it('returns empty for unknown anchor', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
      ]);

      const consumers = await adapter.queryConsumers('totally-unknown-anchor');
      assert.equal(consumers.length, 0, 'should return empty for unknown');
    });
  });

  describe('isAvailable', () => {
    it('returns true when nodes exist', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
      ]);
      assert.equal(adapter.isAvailable(), true);
    });

    it('returns false when no nodes', async () => {
      const Adapter = await importAdapter();
      const adapter = Adapter.fromNodes([]);
      assert.equal(adapter.isAvailable(), false);
    });
  });

  describe('AC-C2 flagship', () => {
    it('search routing → find dossier as sibling', async () => {
      const Adapter = await importAdapter();
      // Simulate full L0 topology
      const adapter = Adapter.fromNodes([
        { name: 'l1-parallel-world.md', kind: 'l0_section', templateVar: 'L1_CONTENT' },
        { name: 'l2-carry-over.md', kind: 'l0_section', templateVar: 'L2_CONTENT' },
        { name: 'l3-routing-rules.md', kind: 'l0_section', templateVar: 'L3_CONTENT' },
        { name: 'l4-iron-laws.md', kind: 'l0_section', templateVar: 'L4_CONTENT' },
        { name: 'l5-mcp-tools-index.md', kind: 'l0_section', templateVar: 'L5_CONTENT' },
        { name: 'l6-capability-wakeup.md', kind: 'l0_section', templateVar: 'L6_CONTENT' },
        { name: 'l7-collaboration-philosophy.md', kind: 'l0_section', templateVar: 'L7_CONTENT' },
        {
          name: 'cat-dossier',
          kind: 'l0_data_source',
          filePath: 'docs/team/cat-dossier.md',
          templateVar: 'TEAMMATE_ROSTER',
        },
      ]);

      // Query for routing rules → should get dossier as sibling (evidence-compatible anchor)
      const consumers = await adapter.queryConsumers('l3-routing-rules.md');
      const dossier = consumers.find((c) => c.anchor === 'doc:docs/team/cat-dossier');
      assert.ok(dossier, 'routing rules should have cat-dossier sibling with evidence anchor');
      assert.equal(dossier.kind, 'l0_data_source');
      assert.equal(dossier.filePath, 'docs/team/cat-dossier.md');
      // Cross-kind sorting: dossier should be first (P1-1 fix)
      assert.equal(consumers[0].anchor, 'doc:docs/team/cat-dossier', 'dossier should sort first as cross-kind');

      // And the reverse: query dossier → should get routing rules as sibling
      const dossierConsumers = await adapter.queryConsumers('cat-dossier');
      const routing = dossierConsumers.find((c) => c.anchor === 'l3-routing-rules.md');
      assert.ok(routing, 'cat-dossier should have routing rules as sibling');
    });
  });

  describe('disk-based construction', () => {
    it('reads real L0 compiler from repo root', async () => {
      const Adapter = await importAdapter();
      // Use the actual repo root (this test runs from the worktree)
      const repoRoot = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
      const adapter = new Adapter(repoRoot);

      assert.equal(adapter.isAvailable(), true, 'should be available with real compiler file');

      // Real compiler has L0_SECTION_TEMPLATES → routing rules should have siblings
      const consumers = await adapter.queryConsumers('l3-routing-rules.md');
      assert.ok(consumers.length > 0, 'real compiler should produce siblings for routing rules');

      const dossier = consumers.find((c) => c.anchor === 'doc:docs/team/cat-dossier');
      assert.ok(dossier, 'real compiler should connect routing rules to cat-dossier with evidence anchor');
    });

    it('returns unavailable for nonexistent repo root', async () => {
      const Adapter = await importAdapter();
      const adapter = new Adapter('/nonexistent/path');
      assert.equal(adapter.isAvailable(), false);
    });
  });
});
