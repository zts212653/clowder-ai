/**
 * Reflect Route Tests
 * POST /api/reflect — SQLite-backed reflection service
 * F102 Phase D1: SQLite-only — no Hindsight paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { reflectRoutes } from '../dist/routes/reflect.js';

function createMockReflectionService(overrides = {}) {
  return {
    reflect: async () => 'This is a reflection.',
    ...overrides,
  };
}

describe('POST /api/reflect', () => {
  async function setup(serviceOverrides = {}) {
    const app = Fastify();
    const reflectionService = createMockReflectionService(serviceOverrides);
    await app.register(reflectRoutes, { reflectionService });
    await app.ready();
    return app;
  }

  it('returns reflection from reflection service', async () => {
    const app = await setup({
      reflect: async () => 'Phase 4 introduced per-cat budgets to replace the global 32k limit.',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: 'Why do we have per-cat budgets?' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, false);
    assert.ok(body.reflection.includes('per-cat budgets'));
    assert.equal(body.dispositionMode, 'off');
  });

  it('passes query to reflection service', async () => {
    let capturedQuery;
    const app = await setup({
      reflect: async (query) => {
        capturedQuery = query;
        return 'ok';
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: 'What changed in phase 5?' },
    });

    assert.equal(capturedQuery, 'What changed in phase 5?');
  });

  it('degrades when reflection service throws', async () => {
    const app = await setup({
      reflect: async () => {
        throw new Error('reflection failure');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: 'test' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'reflection_service_error');
    assert.equal(body.reflection, '');
    assert.equal(body.dispositionMode, 'off');
  });

  it('returns 400 for missing query', async () => {
    const app = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for empty query', async () => {
    const app = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: '' },
    });

    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for whitespace-only query', async () => {
    const app = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reflect',
      payload: { query: '   ' },
    });

    assert.equal(res.statusCode, 400);
  });
});
