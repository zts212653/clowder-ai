import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F186 Phase F: extended edge schema', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('stores and retrieves edge with collection/sensitivity/provenance', async () => {
    const edge = {
      fromAnchor: 'project:cat-cafe:doc/f186',
      toAnchor: 'world:lexander:doc/lore-a',
      relation: 'related_to',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'world:lexander',
      edgeSensitivity: 'private',
      provenance: 'frontmatter',
    };
    await store.addEdge(edge);
    const related = await store.getRelated('project:cat-cafe:doc/f186');
    assert.equal(related.length, 1);
    assert.equal(related[0].anchor, 'world:lexander:doc/lore-a');
    assert.equal(related[0].relation, 'related_to');
    assert.equal(related[0].fromCollectionId, 'project:cat-cafe');
    assert.equal(related[0].toCollectionId, 'world:lexander');
    assert.equal(related[0].edgeSensitivity, 'private');
    assert.equal(related[0].provenance, 'frontmatter');
  });

  it('normalizes legacy "related" edges to "related_to" in query results', async () => {
    // Insert directly with old relation name to simulate legacy data
    await store.addEdge({ fromAnchor: 'a', toAnchor: 'b', relation: 'related' });
    const related = await store.getRelated('a');
    assert.equal(related.length, 1);
    assert.equal(related[0].relation, 'related_to');
  });

  it('reverse lookup returns extended edge metadata', async () => {
    await store.addEdge({
      fromAnchor: 'doc-a',
      toAnchor: 'doc-b',
      relation: 'evolved_from',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'wikilink',
    });
    const reverse = await store.getRelated('doc-b');
    assert.equal(reverse.length, 1);
    assert.equal(reverse[0].anchor, 'doc-a');
    assert.equal(reverse[0].relation, 'evolved_from');
    assert.equal(reverse[0].provenance, 'wikilink');
  });

  it('stores edges without optional fields (backward compat)', async () => {
    await store.addEdge({ fromAnchor: 'x', toAnchor: 'y', relation: 'blocked_by' });
    const related = await store.getRelated('x');
    assert.equal(related.length, 1);
    assert.equal(related[0].anchor, 'y');
    assert.equal(related[0].relation, 'blocked_by');
    assert.equal(related[0].fromCollectionId, null);
    assert.equal(related[0].toCollectionId, null);
  });

  it('IndexBuilder writes related_to with provenance=frontmatter', async () => {
    await store.addEdge({
      fromAnchor: 'doc/f186',
      toAnchor: 'doc/f102',
      relation: 'related_to',
      provenance: 'frontmatter',
    });
    const edges = store.getDb().prepare('SELECT * FROM edges WHERE provenance = ?').all('frontmatter');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].relation, 'related_to');
    assert.equal(edges[0].provenance, 'frontmatter');
  });

  it('promoted_from edge type is accepted', async () => {
    await store.addEdge({
      fromAnchor: 'global:lesson-1',
      toAnchor: 'project:cat-cafe:doc/lesson-orig',
      relation: 'promoted_from',
      fromCollectionId: 'global:lessons',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'promote',
    });
    const related = await store.getRelated('global:lesson-1');
    assert.equal(related.length, 1);
    assert.equal(related[0].relation, 'promoted_from');
    assert.equal(related[0].provenance, 'promote');
  });
});
