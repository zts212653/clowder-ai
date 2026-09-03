// F102 Batch 3 — KnowledgeResolver dimension routing tests
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';

/** Minimal stub that records calls and returns canned items */
function makeStore(tag, items = [], overrides = {}) {
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
    ...overrides,
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

  it('sunset F152 distilled truths are not served by legacy global or all search', async () => {
    const project = makeStore('proj', ['Project hit']);
    const global = makeStore('glob', [], {
      search: async () => [
        {
          anchor: 'distilled:legacy-candidate',
          kind: 'lesson',
          status: 'active',
          title: 'Retired global distillation',
          summary: 'Must remain forensic-only after the surface sunset.',
          updatedAt: '2026-08-29T00:00:00Z',
        },
        {
          anchor: 'global:skill/kept',
          kind: 'plan',
          status: 'active',
          title: 'Supported global method',
          summary: 'Still eligible for global recall.',
          updatedAt: '2026-08-29T00:00:00Z',
        },
      ],
    });
    const resolver = new KnowledgeResolver({ projectStore: project, globalStore: global });

    const globalOnly = await resolver.resolve('test', { dimension: 'global' });
    assert.deepEqual(
      globalOnly.results.map((item) => item.anchor),
      ['global:skill/kept'],
    );

    const all = await resolver.resolve('test', { dimension: 'all' });
    assert.ok(all.results.some((item) => item.anchor === 'proj:Project hit'));
    assert.ok(all.results.some((item) => item.anchor === 'global:skill/kept'));
    assert.ok(!all.results.some((item) => item.anchor.startsWith('distilled:')));
  });

  it('backfills eligible global results when a sunset item occupies the store limit', async () => {
    const project = makeStore('proj', []);
    const ranked = [
      {
        anchor: 'distilled:rank-one-retired',
        kind: 'lesson',
        status: 'active',
        title: 'Retired rank one',
        updatedAt: '2026-08-29T00:00:00Z',
      },
      {
        anchor: 'global:skill/rank-two-kept',
        kind: 'plan',
        status: 'active',
        title: 'Eligible rank two',
        updatedAt: '2026-08-29T00:00:00Z',
      },
    ];
    const global = makeStore('glob', [], {
      search: async (_query, opts = {}) => ranked.slice(0, opts.limit ?? ranked.length),
    });
    const resolver = new KnowledgeResolver({ projectStore: project, globalStore: global });

    const globalOnly = await resolver.resolve('test', { dimension: 'global', limit: 1 });
    assert.deepEqual(
      globalOnly.results.map((entry) => entry.anchor),
      ['global:skill/rank-two-kept'],
    );

    const all = await resolver.resolve('test', { dimension: 'all', limit: 1 });
    assert.deepEqual(
      all.results.map((entry) => entry.anchor),
      ['global:skill/rank-two-kept'],
    );
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

  it('dimension=all combines degradation metadata from project and global stores', async () => {
    const proj = makeStore('proj', ['Alpha'], {
      searchWithMeta: async (query, opts) => ({
        items: await makeStore('proj', ['Alpha']).search(query, opts),
        meta: { degraded: false },
      }),
    });
    const glob = makeStore('glob', ['Beta'], {
      searchWithMeta: async (query, opts) => ({
        items: await makeStore('glob', ['Beta']).search(query, opts),
        meta: {
          degraded: true,
          degradeReason: 'passage_embedding_unavailable',
          effectiveMode: 'lexical',
        },
      }),
    });
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const result = await resolver.resolve('test', { dimension: 'all', depth: 'raw', mode: 'semantic' });

    assert.equal(result.results.length, 2);
    assert.equal(result.meta?.degraded, true);
    assert.equal(result.meta?.degradeReason, 'passage_embedding_unavailable');
    assert.equal(result.meta?.effectiveMode, 'lexical');
  });

  it('scope=threads does not query globalStore or inherit global raw degradation', async () => {
    const proj = makeStore('proj', ['ThreadAlpha']);
    proj.searchWithMeta = async (query, opts) => ({
      items: await proj.search(query, opts),
      meta: { degraded: false },
    });
    const glob = makeStore('glob', ['GlobalBeta']);
    glob.searchWithMeta = async (query, opts) => ({
      items: await glob.search(query, opts),
      meta: {
        degraded: true,
        degradeReason: 'passage_embedding_unavailable',
        effectiveMode: 'lexical',
      },
    });
    const resolver = new KnowledgeResolver({ projectStore: proj, globalStore: glob });

    const result = await resolver.resolve('thread query', { scope: 'threads', depth: 'raw', mode: 'semantic' });

    assert.equal(proj.calls.length, 1);
    assert.equal(glob.calls.length, 0, 'thread-scoped searches must stay project-local');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].anchor, 'proj:ThreadAlpha');
    assert.deepEqual(result.sources, ['project']);
    assert.equal(result.meta?.degraded, false);
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
