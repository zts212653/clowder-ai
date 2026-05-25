import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

function planFileContent(extra = '') {
  return `---
schemaVersion: 1
id: F209/f209-phase-d-orientation
title: F209 Phase D Orientation
featureIds: [F209]
ownerCatId: codex
intent: Orient a fresh cat on F209 Phase D evidence.
steps:
  - id: search-f209
    type: search_evidence
    query: F209 Phase D
    scope: docs
    mode: hybrid
    depth: raw
    limit: 5
  - id: open-top
    type: open_anchor
    source: previous_step
    selector: top
    maxOpen: 1
outputPolicy:
  storesResults: false
  returnsConclusion: false
  requiresAnchors: true
${extra}---

# Human notes
`;
}

function graphPlanFileContent() {
  return `---
schemaVersion: 1
id: F209/graph-orientation
title: F209 Graph Orientation
featureIds: [F209]
ownerCatId: codex
intent: Resolve F209 graph anchor.
steps:
  - id: resolve-f209
    type: graph_resolve
    anchor: F209
outputPolicy:
  storesResults: false
  returnsConclusion: false
  requiresAnchors: true
---

# Human notes
`;
}

function graphOpenPlanFileContent() {
  return `---
schemaVersion: 1
id: F209/graph-open
title: F209 Graph Open
featureIds: [F209]
ownerCatId: codex
intent: Resolve F209 graph anchor and open the produced route.
steps:
  - id: resolve-f209
    type: graph_resolve
    anchor: F209
  - id: open-graph
    type: open_anchor
    source: previous_step
    selector: top
    maxOpen: 1
outputPolicy:
  storesResults: false
  returnsConclusion: false
  requiresAnchors: true
---

# Human notes
`;
}

function writePlan(root, relativePath, content = planFileContent()) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function evidenceItem(anchor) {
  return {
    anchor,
    kind: 'feature',
    status: 'active',
    title: 'F209 Phase D',
    summary: 'Perspective runtime',
    updatedAt: '2026-05-24T00:00:00.000Z',
    sourcePath: 'docs/features/F209-evidence-recall-optimization.md',
    drillDown: {
      tool: 'cat_cafe_read_file_slice',
      params: { path: 'docs/features/F209-evidence-recall-optimization.md', startLine: '200', endLine: '220' },
      hint: 'open F209 Phase D feature slice',
    },
  };
}

function graphCatalog(manifest = { id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }) {
  return {
    list: () => [manifest],
    get: (id) => (id === manifest.id ? manifest : undefined),
  };
}

function graphStore(items) {
  const byAnchor = new Map(items.map((item) => [item.anchor.toLowerCase(), item]));
  return {
    async getByAnchor(anchor) {
      return byAnchor.get(anchor.toLowerCase()) ?? null;
    },
    async search() {
      return items;
    },
    async getRelated() {
      return [];
    },
  };
}

function externalEvidenceItem(anchor) {
  return {
    anchor,
    kind: 'feature',
    status: 'active',
    title: 'External Guide',
    summary: 'External guide from a library collection',
    updatedAt: '2026-05-24T00:00:00.000Z',
    sourcePath: 'docs/guide.md',
  };
}

describe('perspectiveRoutes', () => {
  let perspectiveRoutes;

  beforeEach(async () => {
    ({ perspectiveRoutes } = await import('../../dist/routes/perspectives.js'));
  });

  async function buildApp(root, overrides = {}) {
    const app = Fastify();
    await app.register(perspectiveRoutes, {
      repoRoot: root,
      searchEvidence: async () => ({
        items: [evidenceItem('docs/features/F209-evidence-recall-optimization.md')],
        meta: { degraded: false, effectiveMode: 'hybrid' },
      }),
      openAnchor: async (candidate) => ({
        anchor: candidate.anchor,
        status: 'opened',
        tool: candidate.drillDown?.tool,
        content: candidate.drillDown?.hint,
      }),
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-route-fixed',
      ...overrides,
    });
    await app.ready();
    return app;
  }

  it('loads and runs a Perspective plan by feature id and slug', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    writePlan(root, 'docs/perspectives/F209/f209-phase-d-orientation.md');
    const app = await buildApp(root);

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/f209-phase-d-orientation/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.planId, 'F209/f209-phase-d-orientation');
    assert.equal(body.runId, 'run-route-fixed');
    assert.equal(body.actorCatId, 'codex');
    assert.equal(body.steps[0].id, 'search-f209');
    assert.equal(body.steps[0].hitCount, 1);
    assert.equal(body.candidateAnchors[0].anchor, 'docs/features/F209-evidence-recall-optimization.md');
    assert.equal(body.openedAnchors[0].tool, 'cat_cafe_read_file_slice');
    assert.equal('conclusion' in body, false);
    assert.equal('storedResults' in body, false);
  });

  it('returns 404 for missing plans', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    mkdirSync(root, { recursive: true });
    const app = await buildApp(root);

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/missing/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /not found/i);
  });

  it('returns 400 for invalid plans', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    writePlan(
      root,
      'docs/perspectives/F209/invalid.md',
      planFileContent().replace('schemaVersion: 1', 'schemaVersion: 2'),
    );
    const app = await buildApp(root);

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/invalid/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /schemaVersion/);
  });

  it('does not write result sets back into the plan file', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    const planPath = writePlan(root, 'docs/perspectives/F209/f209-phase-d-orientation.md');
    const before = readFileSync(planPath, 'utf-8');
    const app = await buildApp(root);

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/f209-phase-d-orientation/run?actorCatId=codex',
    });
    const after = readFileSync(planPath, 'utf-8');

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 200);
    assert.equal(after, before);
  });

  it('default open_anchor returns typed reader route hints, not fetched source content', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    writePlan(root, 'docs/perspectives/F209/f209-phase-d-orientation.md');
    const app = await buildApp(root, { openAnchor: undefined });

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/f209-phase-d-orientation/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.openedAnchors[0].status, 'route_identified');
    assert.equal(body.openedAnchors[0].tool, 'cat_cafe_read_file_slice');
    assert.equal(body.openedAnchors[0].content, 'open F209 Phase D feature slice');
  });

  it('passes graph resolver dependency to graph_resolve steps', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    writePlan(root, 'docs/perspectives/F209/graph-orientation.md', graphPlanFileContent());
    let resolveCalls = 0;
    const app = await buildApp(root, {
      resolveGraph: async (anchor) => {
        resolveCalls += 1;
        return { status: 'graph', anchor };
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/graph-orientation/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(resolveCalls, 1);
    assert.equal(body.steps[0].status, 'ok');
    assert.equal(body.steps[0].hitCount, 1);
    assert.deepEqual(body.warnings, []);
  });

  it('default open_anchor returns route hints for graph_resolve anchors', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    writePlan(root, 'docs/perspectives/F209/graph-open.md', graphOpenPlanFileContent());
    const app = await buildApp(root, {
      openAnchor: undefined,
      graphCatalog: graphCatalog(),
      graphStores: new Map([['project:cat-cafe', graphStore([evidenceItem('F209')])]]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/graph-open/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.steps[0].status, 'ok');
    assert.equal(body.steps[1].status, 'ok');
    assert.equal(body.openedAnchors[0].status, 'route_identified');
    assert.equal(body.openedAnchors[0].tool, 'cat_cafe_read_file_slice');
    assert.equal(
      body.openedAnchors[0].content,
      '打开文件切片：read_file_slice(path="docs/features/F209-evidence-recall-optimization.md", startLine=1, endLine=120)',
    );
    assert.deepEqual(body.warnings, []);
  });

  it('default open_anchor preserves collection roots for graph_resolve candidate sources', async () => {
    const root = join(tmpdir(), `f209-perspective-route-${randomUUID().slice(0, 8)}`);
    const externalCollectionId = 'world:external';
    writePlan(
      root,
      'docs/perspectives/F209/graph-open.md',
      graphOpenPlanFileContent().replace('anchor: F209', 'anchor: External Guide'),
    );
    const app = await buildApp(root, {
      openAnchor: undefined,
      graphCatalog: graphCatalog({ id: externalCollectionId, sensitivity: 'internal', kind: 'world' }),
      graphStores: new Map([[externalCollectionId, graphStore([externalEvidenceItem('external-guide')])]]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/perspectives/F209/graph-open/run?actorCatId=codex',
    });

    rmSync(root, { recursive: true, force: true });
    await app.close();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.steps[0].status, 'ok');
    assert.equal(body.steps[1].status, 'ok');
    assert.equal(body.openedAnchors[0].status, 'route_identified');
    assert.equal(body.openedAnchors[0].tool, 'cat_cafe_read_file_slice');
    assert.equal(
      body.openedAnchors[0].content,
      '打开文件切片：read_file_slice(path="cat-cafe://collection/world%3Aexternal/docs/guide.md", startLine=1, endLine=120)',
    );
    assert.deepEqual(body.warnings, []);
  });
});
