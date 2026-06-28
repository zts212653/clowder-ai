/**
 * F208 Phase D: Dossier observation API routes.
 *
 * POST /api/dossier/observations — operator adds observation (owner-gated)
 * GET  /api/dossier/observations — list all observations (grouped by catId)
 * GET  /api/dossier/observations?catId=opus — list for specific cat
 *
 * AC-D1 + OQ-10 (staging only, promotion in Phase E).
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

// Resolve owner ID for tests — mirrors resolveOwnerGate behavior
const OWNER_ID = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'default-user';

describe('Dossier Observation Routes', () => {
  let app;
  let prevOwnerId;

  beforeEach(async () => {
    // Ensure DEFAULT_OWNER_USER_ID is set so owner gate is deterministic
    prevOwnerId = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const { dossierObservationRoutes } = await import('../dist/routes/dossier-observations.js');
    const { InMemoryDossierObservationStore } = await import(
      '../dist/domains/cats/services/stores/ports/DossierObservationStore.js'
    );
    app = Fastify();
    const store = new InMemoryDossierObservationStore();
    await app.register(dossierObservationRoutes, { observationStore: store });
  });

  afterEach(async () => {
    if (app) await app.close();
    // Restore original env
    if (prevOwnerId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = prevOwnerId;
  });

  // --- POST /api/dossier/observations ---

  test('POST creates observation with authenticated user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: {
        catId: 'opus',
        content: 'opus 在 F208 review 中表现不错',
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.observation, 'should return observation object');
    assert.ok(body.observation.id, 'should have id');
    assert.equal(body.observation.catId, 'opus');
    assert.equal(body.observation.content, 'opus 在 F208 review 中表现不错');
    assert.equal(body.observation.provenance.type, 'cvo');
    assert.equal(body.observation.provenance.author, OWNER_ID);
    assert.ok(body.observation.createdAt);
  });

  test('POST uses resolved userId as author (not hardcoded)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'opus', content: 'Test obs' },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.observation.provenance.author, OWNER_ID);
  });

  test('POST rejects browser request without session (resolveStrictUserId)', async () => {
    // Simulate a browser request: has Origin header but no session cookie
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { origin: 'http://localhost:3004' },
      payload: { catId: 'opus', content: 'Browser without session' },
    });
    assert.equal(res.statusCode, 401, 'browser without session must be rejected');
  });

  test('POST rejects request with no identity at all', async () => {
    // No session, no header, no origin — resolveStrictUserId returns null
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      payload: { catId: 'opus', content: 'No identity' },
    });
    assert.equal(res.statusCode, 401, 'request with no identity must be rejected');
  });

  test('POST rejects when owner gate fails (non-owner user)', async () => {
    // Set DEFAULT_OWNER_USER_ID to restrict access
    const original = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'the-real-owner';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dossier/observations',
        headers: { 'x-cat-cafe-user': 'intruder' },
        payload: { catId: 'opus', content: 'Unauthorized obs' },
      });
      assert.equal(res.statusCode, 403);
    } finally {
      if (original === undefined) {
        delete process.env.DEFAULT_OWNER_USER_ID;
      } else {
        process.env.DEFAULT_OWNER_USER_ID = original;
      }
    }
  });

  test('POST rejects missing catId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { content: 'no catId' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('POST rejects missing content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'opus' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('POST rejects empty content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'opus', content: '' },
    });
    assert.equal(res.statusCode, 400);
  });

  // --- GET /api/dossier/observations ---

  test('GET returns all observations grouped by catId', async () => {
    // Seed two observations
    await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'opus', content: 'obs 1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'codex', content: 'obs 2' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/observations',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.observations, 'should have observations object');
    assert.ok(body.observations.opus, 'should have opus group');
    assert.ok(body.observations.codex, 'should have codex group');
    assert.equal(body.observations.opus.length, 1);
    assert.equal(body.observations.codex.length, 1);
  });

  test('GET with catId filter returns only that cat', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'opus', content: 'opus obs' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/dossier/observations',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'codex', content: 'codex obs' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/observations?catId=opus',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.observations, 'should have observations');
    assert.equal(body.observations.length, 1);
    assert.equal(body.observations[0].catId, 'opus');
  });

  test('GET with unknown catId returns empty array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/observations?catId=nonexistent',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.observations, []);
  });

  test('GET returns empty when no observations exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/observations',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.observations, {});
  });
});
