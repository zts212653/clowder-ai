import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('GET /api/library/graph/resolve', () => {
  let Fastify;
  let libraryRoutes;
  let app;

  beforeEach(async () => {
    Fastify = (await import('fastify')).default;
    ({ libraryRoutes } = await import('../../dist/routes/library.js'));
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  function item(anchor, overrides = {}) {
    return {
      anchor,
      kind: 'feature',
      status: 'active',
      title: anchor,
      updatedAt: '2026-05-09',
      ...overrides,
    };
  }

  function catalog(manifests) {
    return {
      list: () => manifests,
      get: (id) => manifests.find((m) => m.id === id),
    };
  }

  function createStore(items, options = {}) {
    const byAnchor = new Map(items.map((evidence) => [evidence.anchor.toLowerCase(), evidence]));
    const relatedByAnchor = new Map(
      Object.entries(options.related ?? {}).map(([anchor, related]) => [anchor.toLowerCase(), related]),
    );
    return {
      async getByAnchor(anchor) {
        return byAnchor.get(anchor.toLowerCase()) ?? null;
      },
      async search(query, searchOptions = {}) {
        const lower = query.toLowerCase();
        return items
          .filter((evidence) =>
            [evidence.anchor, evidence.title, evidence.sourcePath, evidence.summary, ...(evidence.keywords ?? [])].some(
              (field) => field?.toLowerCase().includes(lower),
            ),
          )
          .slice(0, searchOptions.limit ?? items.length);
      },
      async getRelated(anchor) {
        return relatedByAnchor.get(anchor.toLowerCase()) ?? [];
      },
      async upsert() {},
      async deleteByAnchor() {},
      async health() {
        return true;
      },
      async initialize() {},
    };
  }

  async function setup() {
    const manifests = [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }];
    const store = createStore(
      [
        item('F186', { title: 'Library Memory Architecture' }),
        item('F102', { title: 'Memory Adapter' }),
        item('F200', {
          title: 'Harness discussion',
          kind: 'discussion',
          sourcePath: 'docs/discussions/harness.md',
          summary: 'Harness query candidate',
        }),
      ],
      {
        related: {
          F186: [
            {
              anchor: 'F102',
              relation: 'related_to',
              fromCollectionId: 'project:cat-cafe',
              toCollectionId: 'project:cat-cafe',
              edgeSensitivity: 'internal',
              provenance: 'frontmatter',
            },
          ],
        },
      },
    );
    app = Fastify();
    await app.register(libraryRoutes, {
      catalog: catalog(manifests),
      stores: new Map([['project:cat-cafe', store]]),
    });
    await app.ready();
  }

  async function setupDuplicateAnchor() {
    const manifests = [
      { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
      { id: 'private:lab', sensitivity: 'internal', kind: 'domain' },
    ];
    const projectStore = createStore([item('F301', { title: 'Project Harness' })]);
    const privateStore = createStore([item('F301', { title: 'Private Harness' })]);
    app = Fastify();
    await app.register(libraryRoutes, {
      catalog: catalog(manifests),
      stores: new Map([
        ['project:cat-cafe', projectStore],
        ['private:lab', privateStore],
      ]),
    });
    await app.ready();
  }

  async function setupHiddenDuplicateAnchor() {
    const manifests = [
      { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' },
      { id: 'private:lab', sensitivity: 'private', kind: 'domain' },
    ];
    const projectStore = createStore([item('F301', { title: 'Project Harness' })]);
    const privateStore = createStore([item('F301', { title: 'Private Harness' })]);
    app = Fastify();
    await app.register(libraryRoutes, {
      catalog: catalog(manifests),
      stores: new Map([
        ['project:cat-cafe', projectStore],
        ['private:lab', privateStore],
      ]),
    });
    await app.ready();
  }

  it('resolves exact anchors to graph payloads', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=f186&depth=1&collections=project:cat-cafe',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'graph');
    assert.equal(body.resolvedAnchor, 'F186');
    assert.equal(body.graph.center, 'F186');
    assert.equal(body.graph.edges.length, 1);
  });

  it('resolves natural queries to candidate payloads', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=harness&collections=project:cat-cafe',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'candidates');
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].anchor, 'F200');
    assert.equal(body.candidates[0].matchReason, 'title');
  });

  it('returns 400 for missing query', async () => {
    await setup();

    const res = await app.inject({ method: 'GET', url: '/api/library/graph/resolve' });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'query parameter is required' });
  });

  it('rejects non-localhost requests', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=F186',
      remoteAddress: '203.0.113.9',
    });

    assert.equal(res.statusCode, 403);
  });

  it('applies relations filter AT TRAVERSAL TIME (砚砚 cloud-9 P1)', async () => {
    await setup();

    // Default: edge with relation='related_to' is included → 1 edge.
    const allRes = await app.inject({ method: 'GET', url: '/api/library/graph/resolve?query=f186&depth=1' });
    assert.equal(allRes.statusCode, 200);
    assert.equal(allRes.json().graph.edges.length, 1, 'no filter → all edges included');

    // Filter to disallowed relation type → 0 edges; the related_to edge must be
    // skipped at resolve time, not just at render time.
    const filteredRes = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=f186&depth=1&relations=wikilink',
    });
    assert.equal(filteredRes.statusCode, 200);
    const filteredBody = filteredRes.json();
    assert.equal(filteredBody.status, 'graph');
    assert.equal(
      filteredBody.graph.edges.length,
      0,
      'relations=wikilink filter must skip related_to edge at resolve time',
    );
    // F102 should NOT appear in graph nodes since the only edge to it is filtered out.
    const hasF102 = filteredBody.graph.nodes.some((n) => n.anchor === 'F102');
    assert.equal(hasF102, false, 'F102 reached only via filtered-out edge — must not appear in nodes');

    // Allowed relation type matches → 1 edge.
    const allowRes = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=f186&depth=1&relations=related_to',
    });
    assert.equal(allowRes.statusCode, 200);
    assert.equal(allowRes.json().graph.edges.length, 1);
  });

  it('rejects invalid relation type with 400', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=f186&relations=bogus',
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /relations must be subset of/);
  });

  it('validates depth consistently with direct graph endpoint', async () => {
    await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=F186&depth=4',
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'depth must be 0-3' });
  });

  it('resolves exact queries by visible matches before returning candidates', async () => {
    await setupHiddenDuplicateAnchor();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph/resolve?query=F301&collections=project:cat-cafe&depth=0',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'graph');
    assert.equal(body.graph.nodes.length, 1);
    assert.equal(body.graph.nodes[0].collectionId, 'project:cat-cafe');
    assert.equal(body.graph.nodes[0].title, 'Project Harness');
    assert.ok(!JSON.stringify(body).includes('Private Harness'));
  });

  it('preserves selected collection for direct graph lookup when anchors collide', async () => {
    await setupDuplicateAnchor();

    const res = await app.inject({
      method: 'GET',
      url: '/api/library/graph?anchor=F301&collection=private:lab&depth=0',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.center, 'F301');
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].collectionId, 'private:lab');
    assert.equal(body.nodes[0].title, 'Private Harness');
  });
});
