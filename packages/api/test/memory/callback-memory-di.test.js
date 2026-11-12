/**
 * F102 Phase B: Route DI — callback-memory-routes accepts IEvidenceStore/IReflectionService
 * (IMarkerQueue left with the retain-memory route, 2026-11-09 memory entry subtraction)
 * Tests the new SQLite-backed path for callback memory routes.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('callback-memory-routes DI (IEvidenceStore path)', () => {
  let app;
  let registerFn;
  let registerAuthHook;

  beforeEach(async () => {
    const mod = await import('../../dist/routes/callback-memory-routes.js');
    registerFn = mod.registerCallbackMemoryRoutes;
    const authMod = await import('../../dist/routes/callback-auth-prehandler.js');
    registerAuthHook = authMod.registerCallbackAuthHook;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  function createMockRegistry() {
    return {
      // F174 Phase A: verify() returns VerifyResult discriminated union
      verify: async () => ({
        ok: true,
        record: {
          invocationId: 'inv-1',
          catId: 'opus',
          userId: 'user-1',
          threadId: 'thread-1',
          callbackToken: 'tok-1',
        },
      }),
    };
  }

  it('search-evidence delegates to IEvidenceStore and returns mapped EvidenceResult shape', async () => {
    let searchQuery;
    let searchOptions;
    const mockStore = {
      search: async (q, opts) => {
        searchQuery = q;
        searchOptions = opts;
        return [
          {
            anchor: 'F042',
            kind: 'feature',
            status: 'active',
            title: 'F042: Prompt Audit',
            summary: 'Prompt engineering audit spec',
            updatedAt: new Date().toISOString(),
          },
        ];
      },
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    };

    app = Fastify();
    registerAuthHook(app, createMockRegistry());
    await registerFn(app, {
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/search-evidence?q=prompt+audit',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.results.length > 0);
    assert.equal(searchQuery, 'prompt audit');
    assert.equal(searchOptions.includePullOnly, true);
    // F263 AC-A2: callback results use the same explicit axes as the primary route.
    const r = body.results[0];
    assert.ok('title' in r, 'result must have title');
    assert.ok('anchor' in r, 'result must have anchor');
    assert.ok('snippet' in r, 'result must have snippet (mapped from summary)');
    assert.equal(r.matchRank, 'high');
    assert.equal(r.confidence, undefined);
    assert.ok('updatedAt' in r, 'result must preserve freshness');
    assert.ok('sourceType' in r, 'result must have sourceType');
  });

  it('search-evidence maps architecture EvidenceKind to architecture sourceType', async () => {
    const mockStore = {
      search: async () => [
        {
          anchor: 'doc:architecture/memory-system-overview',
          kind: 'architecture',
          status: 'active',
          title: 'Memory System Overview',
          summary: 'Architecture map',
          updatedAt: new Date().toISOString(),
        },
      ],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    };

    app = Fastify();
    registerAuthHook(app, createMockRegistry());
    await registerFn(app, {
      evidenceStore: mockStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/search-evidence?q=memory+overview',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.results[0].sourceType, 'architecture');
  });

  it('reflect delegates to IReflectionService and includes dispositionMode', async () => {
    let reflectQuery;
    const mockReflection = {
      reflect: async (q) => {
        reflectQuery = q;
        return 'Reflected insight about architecture';
      },
    };

    app = Fastify();
    registerAuthHook(app, createMockRegistry());
    await registerFn(app, {
      reflectionService: mockReflection,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/reflect',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
      payload: {
        query: 'What patterns do we use?',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.reflection, 'Reflected insight about architecture');
    assert.equal(body.degraded, false);
    assert.equal(reflectQuery, 'What patterns do we use?');
    // P1-2: DI path must include dispositionMode for schema consistency
    assert.ok('dispositionMode' in body, 'DI reflect must include dispositionMode');
  });
});
