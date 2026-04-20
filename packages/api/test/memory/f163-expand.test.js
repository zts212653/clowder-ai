/**
 * F163 Phase B Task 7: Source expansion API (AC-B3)
 * GET /api/f163/expand/:anchor — given a summary anchor, return source docs.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { f163AdminRoutes } from '../../dist/routes/f163-admin.js';

describe('F163 source expansion API (AC-B3)', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  async function setup() {
    process.env.F163_COMPRESSION = 'apply';
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Create original docs
    await store.upsert([
      {
        anchor: 'LL-E01',
        kind: 'lesson',
        status: 'active',
        title: 'Original 1',
        summary: 'First lesson',
        updatedAt: '2026-04-16',
      },
      {
        anchor: 'LL-E02',
        kind: 'lesson',
        status: 'active',
        title: 'Original 2',
        summary: 'Second lesson',
        updatedAt: '2026-04-16',
      },
    ]);

    // Create summary via the API
    const app = Fastify();
    await app.register(f163AdminRoutes, { evidenceStore: store });
    await app.ready();

    const applyRes = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {
        sourceAnchors: ['LL-E01', 'LL-E02'],
        summaryTitle: 'Combined lesson',
        summarySummary: 'First and second lesson combined',
        rationale: 'Duplicate lessons',
      },
    });

    const summaryAnchor = applyRes.json().summaryAnchor;
    return { app, store, summaryAnchor };
  }

  it('returns summary + sources for a valid summary anchor', async () => {
    const { app, summaryAnchor } = await setup();

    const res = await app.inject({
      method: 'GET',
      url: `/api/f163/expand/${summaryAnchor}`,
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.summary, 'should have summary doc');
    assert.equal(body.summary.anchor, summaryAnchor);
    assert.ok(Array.isArray(body.sources), 'should have sources array');
    assert.equal(body.sources.length, 2);

    const sourceAnchors = body.sources.map((s) => s.anchor).sort();
    assert.deepEqual(sourceAnchors, ['LL-E01', 'LL-E02']);
  });

  it('returns 404 for non-existent anchor', async () => {
    const { app } = await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/expand/NONEXISTENT',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    assert.equal(res.statusCode, 404);
  });

  it('returns 400 if anchor is not a summary', async () => {
    const { app } = await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/expand/LL-E01',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('not a summary'));
  });
});
