// F102 Batch 3 — KnowledgeResolver dimension routing tests
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';

/** Minimal stub that records calls and returns canned items */
function makeStore(tag, items = []) {
  const calls = [];
  return {
    calls,
    search: async (query, opts) => {
      calls.push({ query, opts });
      return items.map((title) => ({
        anchor: `${tag}:${title}`,
        kind: 'feature',
        status: 'published',
        title,
        summary: `${tag} summary for ${title}`,
        updatedAt: '2026-04-02T00:00:00Z',
      }));
    },
    health: async () => true,
  };
}

describe('KnowledgeResolver dimension routing', () => {
  it('dimension=project only queries projectStore', async () => {
    const proj = makeStore('proj', ['Alpha']);
    const glob = makeStore('glob', ['Beta']);
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const result = await resolver.resolve('test', { dimension: 'project' });

    assert.equal(proj.calls.length, 1);
    assert.equal(glob.calls.length, 0, 'globalStore must NOT be queried');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].anchor, 'proj:Alpha');
    assert.deepEqual(result.sources, ['project']);
  });

  it('dimension=global only queries globalStore', async () => {
    const proj = makeStore('proj', ['Alpha']);
    const glob = makeStore('glob', ['Beta']);
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const result = await resolver.resolve('test', { dimension: 'global' });

    assert.equal(proj.calls.length, 0, 'projectStore must NOT be queried');
    assert.equal(glob.calls.length, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].anchor, 'glob:Beta');
    assert.deepEqual(result.sources, ['global']);
  });

  it('dimension=all (default) does RRF fusion of both stores', async () => {
    const proj = makeStore('proj', ['Alpha', 'Charlie']);
    const glob = makeStore('glob', ['Beta']);
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const result = await resolver.resolve('test', { dimension: 'all' });

    assert.equal(proj.calls.length, 1);
    assert.equal(glob.calls.length, 1);
    // All three items should be present (fusion, no dedup since anchors differ)
    assert.equal(result.results.length, 3);
    assert.deepEqual(result.sources, ['project', 'global']);
  });

  it('undefined dimension behaves like all (backward compat)', async () => {
    const proj = makeStore('proj', ['Alpha']);
    const glob = makeStore('glob', ['Beta']);
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const result = await resolver.resolve('test', {});

    assert.equal(proj.calls.length, 1);
    assert.equal(glob.calls.length, 1);
    assert.equal(result.results.length, 2);
  });

  it('dimension=global with no globalStore returns empty', async () => {
    const proj = makeStore('proj', ['Alpha']);
    const resolver = new KnowledgeResolver({ projectStore: proj });

    const result = await resolver.resolve('test', { dimension: 'global' });

    assert.equal(proj.calls.length, 0);
    assert.equal(result.results.length, 0);
    assert.deepEqual(result.sources, []);
  });
});
