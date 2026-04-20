/**
 * F163: Knowledge promotion API — observed→candidate→validated→constitutional
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { f163AdminRoutes } from '../../dist/routes/f163-admin.js';

describe('POST /api/f163/promote', () => {
  let app;
  let store;

  beforeEach(async () => {
    app = Fastify();
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert test doc with observed authority
    await store.upsert([
      {
        anchor: 'test-promote-1',
        kind: 'lesson',
        status: 'active',
        title: 'Test Lesson',
        summary: 'A lesson about testing',
        authority: 'observed',
        activation: 'query',
        updatedAt: '2026-01-01',
      },
    ]);

    await app.register(f163AdminRoutes, { evidenceStore: store });
    await app.ready();
  });

  it('promotes observed → candidate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      payload: {
        anchor: 'test-promote-1',
        targetAuthority: 'candidate',
        reason: 'Confirmed by review',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.previousAuthority, 'observed');
    assert.equal(body.newAuthority, 'candidate');

    // Verify in DB
    const item = await store.getByAnchor('test-promote-1');
    assert.equal(item.authority, 'candidate');
  });

  it('promotes candidate → validated', async () => {
    // First promote to candidate
    const db = store.getDb();
    db.prepare("UPDATE evidence_docs SET authority = 'candidate' WHERE anchor = 'test-promote-1'").run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      payload: {
        anchor: 'test-promote-1',
        targetAuthority: 'validated',
        reason: 'Validated by CVO',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.newAuthority, 'validated');
  });

  it('rejects demotion (validated → observed)', async () => {
    const db = store.getDb();
    db.prepare("UPDATE evidence_docs SET authority = 'validated' WHERE anchor = 'test-promote-1'").run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      payload: {
        anchor: 'test-promote-1',
        targetAuthority: 'observed',
        reason: 'Trying to demote',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes('upward'));
  });

  it('rejects promotion to constitutional without special flag', async () => {
    const db = store.getDb();
    db.prepare("UPDATE evidence_docs SET authority = 'validated' WHERE anchor = 'test-promote-1'").run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      payload: {
        anchor: 'test-promote-1',
        targetAuthority: 'constitutional',
        reason: 'Trying to go constitutional',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.ok(body.error.includes('constitutional'));
  });

  it('returns 404 for unknown anchor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      payload: {
        anchor: 'nonexistent-anchor',
        targetAuthority: 'candidate',
        reason: 'Test',
      },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(res.statusCode, 404);
  });

  it('returns 400 for missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      payload: { anchor: 'test-promote-1' },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(res.statusCode, 400);
  });
});
