/**
 * MCP Graph Tools Tests — F188 Phase F (AC-F1)
 *
 * Tests cat_cafe_graph_resolve URL encoding, graph/candidates/no_match
 * rendering, and KD-8 privacy: schema must NOT accept callerCollections.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Graph Resolve Tool (AC-F1)', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleGraphResolve encodes query + depth into URL, calls graph/resolve endpoint', async () => {
    const { handleGraphResolve } = await import('../dist/tools/graph-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ status: 'no_match', queryKind: 'search', query: 'x', message: 'none', examples: [] }),
      };
    };

    await handleGraphResolve({ query: 'F186', depth: 2 });
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/library/graph/resolve');
    assert.equal(parsed.searchParams.get('query'), 'F186');
    assert.equal(parsed.searchParams.get('depth'), '2');
  });

  test('renders graph subgraph response with cross-reference footer (F188 Phase G AC-G2: real nested API shape)', async () => {
    const { handleGraphResolve } = await import('../dist/tools/graph-tools.js');
    // F188 Phase G AC-G2: API returns nested { status, graph: { nodes, edges, ... } }
    // (per GraphQueryResolver.ts:257). Pre-fix tests used flat shape — false green.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'graph',
        queryKind: 'exact',
        query: 'F186',
        resolvedAnchor: 'F186',
        graph: {
          nodes: [
            {
              anchor: 'F186',
              collectionId: 'project:cafe',
              sensitivity: 'internal',
              kind: 'feature',
              title: 'Library',
              redacted: false,
            },
            {
              anchor: 'F102',
              collectionId: 'project:cafe',
              sensitivity: 'internal',
              kind: 'feature',
              title: 'Memory',
              redacted: false,
            },
          ],
          edges: [{ from: 'F186', to: 'F102', relation: 'feature_ref' }],
          center: 'F186',
          depth: 1,
        },
      }),
    });

    const result = await handleGraphResolve({ query: 'F186' });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('★ F186'), 'center marker');
    assert.ok(text.includes('F186 -[feature_ref]-> F102'), 'edge rendering');
    assert.ok(text.includes('7-tool memory family'), 'cross-reference footer present');
  });

  test('filters edges by relations param (client-side, nested API shape)', async () => {
    const { handleGraphResolve } = await import('../dist/tools/graph-tools.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'graph',
        queryKind: 'exact',
        query: 'F186',
        resolvedAnchor: 'F186',
        graph: {
          nodes: [
            {
              anchor: 'F186',
              collectionId: 'project:cafe',
              sensitivity: 'internal',
              kind: 'feature',
              title: 'Library',
              redacted: false,
            },
            {
              anchor: 'F102',
              collectionId: 'project:cafe',
              sensitivity: 'internal',
              kind: 'feature',
              title: 'Memory',
              redacted: false,
            },
            {
              anchor: 'F195',
              collectionId: 'project:cafe',
              sensitivity: 'internal',
              kind: 'feature',
              title: 'Other',
              redacted: false,
            },
          ],
          edges: [
            { from: 'F186', to: 'F102', relation: 'feature_ref' },
            { from: 'F186', to: 'F195', relation: 'wikilink' },
          ],
          center: 'F186',
          depth: 1,
        },
      }),
    });

    const result = await handleGraphResolve({ query: 'F186', relations: ['wikilink'] });
    const text = result.content[0].text;
    assert.ok(text.includes('F186 -[wikilink]-> F195'));
    assert.ok(!text.includes('feature_ref'), 'feature_ref edge filtered out');
  });

  test('renders candidates response with index for selection', async () => {
    const { handleGraphResolve } = await import('../dist/tools/graph-tools.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'candidates',
        query: 'harness',
        candidates: [
          {
            anchor: 'F167',
            title: 'A2A Chain Quality',
            kind: 'feature',
            collectionId: 'project:cafe',
            sensitivity: 'internal',
            matchReason: 'title',
            snippet: 'harness layer ...',
          },
          {
            anchor: 'F192',
            title: 'Socio-technical Eval',
            kind: 'feature',
            collectionId: 'project:cafe',
            sensitivity: 'internal',
            matchReason: 'content',
          },
        ],
      }),
    });

    const result = await handleGraphResolve({ query: 'harness' });
    const text = result.content[0].text;
    assert.ok(text.includes('[0] F167'), 'candidate index 0');
    assert.ok(text.includes('[1] F192'), 'candidate index 1');
    assert.ok(text.includes('Candidates for "harness"'));
  });

  test('renders no_match response with examples', async () => {
    const { handleGraphResolve } = await import('../dist/tools/graph-tools.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'no_match',
        queryKind: 'search',
        query: 'nonsense',
        message: 'No graph data',
        examples: ['F186', 'F102'],
      }),
    });

    const result = await handleGraphResolve({ query: 'nonsense' });
    const text = result.content[0].text;
    assert.ok(text.includes('No graph node found for "nonsense"'));
    assert.ok(text.includes('F186, F102'));
  });

  test('KD-8 — schema does NOT contain callerCollections/collections/dimension', async () => {
    const { graphResolveInputSchema, graphTools } = await import('../dist/tools/graph-tools.js');
    const keys = Object.keys(graphResolveInputSchema);
    assert.ok(!keys.includes('callerCollections'), 'callerCollections must not be in MCP schema (KD-8)');
    assert.ok(!keys.includes('collections'), 'collections deferred to v2 with server-side identity derivation');
    assert.ok(!keys.includes('dimension'), 'dimension deferred to v2');
    // Sanity check the allowed keys
    assert.deepEqual(keys.sort(), ['depth', 'query', 'relations'].sort());
    // tool registration shape
    assert.equal(graphTools.length, 1);
    assert.equal(graphTools[0].name, 'cat_cafe_graph_resolve');
    assert.ok(graphTools[0].description.includes('KD-8'), 'description must mention KD-8 v1 limitation');
  });

  test('description warns depth>=2 without relations can trigger hub fan-out', async () => {
    const { graphTools } = await import('../dist/tools/graph-tools.js');
    const description = graphTools[0].description;

    assert.ok(description.includes('hub fan-out'), 'description should warn about hub fan-out');
    assert.ok(description.includes('depth>=2'), 'description should name the risky depth');
    assert.ok(description.includes('relations'), 'description should recommend relations filters');
  });

  test('handles fetch error gracefully', async () => {
    const { handleGraphResolve } = await import('../dist/tools/graph-tools.js');
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };
    const result = await handleGraphResolve({ query: 'F186' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('connection refused'));
  });
});
