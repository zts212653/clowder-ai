/**
 * /api/library/recent route validation — F188 Phase F (砚砚 cloud-5 P2)
 *
 * Verifies invalid `scope` returns 400 rather than silently coercing to
 * undefined (which would broaden the query and skew agent metrics).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('GET /api/library/recent — scope validation', () => {
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

  async function setup() {
    const manifests = [{ id: 'project:cat-cafe', sensitivity: 'internal', kind: 'project' }];
    // Store irrelevant for 400-path tests — resolver is never invoked.
    app = Fastify();
    await app.register(libraryRoutes, {
      catalog: { list: () => manifests, get: (id) => manifests.find((m) => m.id === id) },
      stores: new Map(),
    });
    await app.ready();
  }

  it('rejects invalid scope with 400', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?scope=thread' });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.match(body.error, /scope must be one of/);
    assert.match(body.error, /docs/);
    assert.match(body.error, /threads/);
  });

  it('rejects empty-but-typo scope=invalid_value with 400', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?scope=invalid' });
    assert.equal(res.statusCode, 400);
  });

  it('accepts missing scope (defaults to undefined → no scope filter)', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?since=7d' });
    assert.equal(res.statusCode, 200);
  });

  it('accepts valid scope=docs', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?scope=docs' });
    assert.equal(res.statusCode, 200);
  });

  it('rejects malformed since=tomorrow with 400 (砚砚 cloud-7 P2)', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?since=tomorrow' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /since must be/);
  });

  it('rejects since=7days (typo for 7d) with 400', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?since=7days' });
    assert.equal(res.statusCode, 400);
  });

  it('rejects since with trailing garbage (砚砚 cloud-10 P2: Date.parse permissive)', async () => {
    await setup();
    // Date.parse('2026-05-01 garbage') is permissive in some runtimes;
    // anchored regex must reject.
    const res = await app.inject({
      method: 'GET',
      url: `/api/library/recent?since=${encodeURIComponent('2026-05-01 trailing-text')}`,
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects since=2026 (date prefix without month/day)', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?since=2026' });
    assert.equal(res.statusCode, 400);
  });

  it('rejects oversized relative since (砚砚 cloud-11 P2: Date overflow guard)', async () => {
    await setup();
    // since=999999999999999d would pass `\d+[dh]` and overflow Date.toISOString
    // with RangeError, crashing the endpoint with 500. Capped digit regex
    // rejects with 400 instead.
    const res = await app.inject({
      method: 'GET',
      url: '/api/library/recent?since=999999999999999d',
    });
    assert.equal(res.statusCode, 400);
  });

  it('accepts max-digit relative since (99999d)', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/library/recent?since=99999d' });
    assert.equal(res.statusCode, 200);
  });

  it('accepts since=7d / since=24h / since=ISO date', async () => {
    await setup();
    for (const v of ['7d', '24h', '2026-05-01', '2026-05-11T08:00:00Z']) {
      const res = await app.inject({ method: 'GET', url: `/api/library/recent?since=${encodeURIComponent(v)}` });
      assert.equal(res.statusCode, 200, `since=${v} must be accepted`);
    }
  });
});
