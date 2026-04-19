/**
 * F163 Phase B Task 6: Retrieval backstop suppression (AC-B3)
 * When compression is active (!= 'off'), search excludes backstop docs.
 * includeBackstop: true overrides this for drill-down.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

describe('F163 backstop retrieval suppression (AC-B3)', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  async function seedWithBackstop() {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Create summary + 3 backstop originals
    await store.upsert([
      {
        anchor: 'CS-summary',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix consolidated',
        summary: 'Consolidated lesson about Redis keyPrefix behavior',
        updatedAt: '2026-04-16',
        activation: 'query',
        summaryOfAnchor: 'sg-001',
        sourceIds: ['LL-B01', 'LL-B02', 'LL-B03'],
      },
      {
        anchor: 'LL-B01',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVAL behavior',
        summary: 'keyPrefix not applied to EVAL',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
      {
        anchor: 'LL-B02',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVALSHA issue',
        summary: 'keyPrefix ignored by EVALSHA commands',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
      {
        anchor: 'LL-B03',
        kind: 'lesson',
        status: 'active',
        title: 'Redis scripting prefix problem',
        summary: 'keyPrefix scripting commands bypass',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
    ]);

    return store;
  }

  it('excludes backstop docs when compression is active', async () => {
    process.env.F163_COMPRESSION = 'suggest';
    const store = await seedWithBackstop();

    const results = await store.search('Redis keyPrefix');
    const anchors = results.map((r) => r.anchor);
    assert.ok(anchors.includes('CS-summary'), 'summary should be returned');
    assert.ok(!anchors.includes('LL-B01'), 'backstop LL-B01 should be excluded');
    assert.ok(!anchors.includes('LL-B02'), 'backstop LL-B02 should be excluded');
    assert.ok(!anchors.includes('LL-B03'), 'backstop LL-B03 should be excluded');
  });

  it('includes backstop docs when includeBackstop=true', async () => {
    process.env.F163_COMPRESSION = 'suggest';
    const store = await seedWithBackstop();

    const results = await store.search('Redis keyPrefix', { includeBackstop: true });
    const anchors = results.map((r) => r.anchor);
    assert.ok(anchors.includes('CS-summary'), 'summary should be returned');
    // At least some backstop docs should be returned
    const backstopCount = anchors.filter((a) => ['LL-B01', 'LL-B02', 'LL-B03'].includes(a)).length;
    assert.ok(backstopCount > 0, `should return backstop docs, got ${backstopCount}`);
  });

  it('returns ALL docs (including backstop) when compression=off', async () => {
    // No F163_COMPRESSION set = default off
    const store = await seedWithBackstop();

    const results = await store.search('Redis keyPrefix');
    const anchors = results.map((r) => r.anchor);
    // When compression is off, backstop suppression does NOT activate
    assert.ok(anchors.includes('CS-summary'), 'summary should be returned');
    const backstopCount = anchors.filter((a) => ['LL-B01', 'LL-B02', 'LL-B03'].includes(a)).length;
    assert.ok(backstopCount > 0, `backstop docs should be returned when off, got ${backstopCount}`);
  });

  it('excludes backstop docs in semantic search mode (R1 P1)', async () => {
    let sqliteVec;
    try {
      sqliteVec = await import('sqlite-vec');
    } catch {
      return; // skip if no sqlite-vec
    }

    process.env.F163_COMPRESSION = 'suggest';
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();

    // Seed docs including a semantic-only doc that lexical won't find
    await store.upsert([
      {
        anchor: 'CS-summary',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix consolidated',
        summary: 'Consolidated lesson about Redis keyPrefix behavior',
        updatedAt: '2026-04-16',
        activation: 'query',
        summaryOfAnchor: 'sg-001',
        sourceIds: ['LL-B01', 'LL-B02'],
      },
      {
        anchor: 'LL-B01',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVAL behavior',
        summary: 'keyPrefix not applied to EVAL',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
      {
        anchor: 'LL-B02',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVALSHA issue',
        summary: 'keyPrefix ignored by EVALSHA commands',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
    ]);

    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    const vectorStore = new VectorStore(db, 3);

    vectorStore.upsert('CS-summary', new Float32Array([0.9, 0.1, 0.0]));
    vectorStore.upsert('LL-B01', new Float32Array([0.85, 0.15, 0.0]));
    vectorStore.upsert('LL-B02', new Float32Array([0.8, 0.2, 0.0]));

    const mockEmbed = {
      isReady: () => true,
      embed: async (texts) => [new Float32Array([0.9, 0.1, 0.0])],
      getModelInfo: () => ({ modelId: 'test', modelRev: 'test', dim: 3 }),
    };
    store.setEmbedDeps({ embedding: mockEmbed, vectorStore, mode: 'on' });

    const results = await store.search('Redis keyPrefix', { mode: 'semantic', limit: 10 });
    const anchors = results.map((r) => r.anchor);
    assert.ok(anchors.includes('CS-summary'), 'summary should be returned in semantic');
    assert.ok(!anchors.includes('LL-B01'), 'backstop LL-B01 should be excluded in semantic');
    assert.ok(!anchors.includes('LL-B02'), 'backstop LL-B02 should be excluded in semantic');
  });

  it('excludes backstop docs in hybrid search mode (R1 P1)', async () => {
    let sqliteVec;
    try {
      sqliteVec = await import('sqlite-vec');
    } catch {
      return; // skip if no sqlite-vec
    }

    process.env.F163_COMPRESSION = 'suggest';
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();

    await store.upsert([
      {
        anchor: 'CS-summary',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix consolidated',
        summary: 'Consolidated lesson about Redis keyPrefix behavior',
        updatedAt: '2026-04-16',
        activation: 'query',
        summaryOfAnchor: 'sg-001',
        sourceIds: ['LL-B01', 'LL-B02'],
      },
      {
        anchor: 'LL-B01',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVAL behavior',
        summary: 'keyPrefix not applied to EVAL',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
      {
        anchor: 'LL-B02',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix EVALSHA issue',
        summary: 'keyPrefix ignored by EVALSHA commands',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
    ]);

    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    const vectorStore = new VectorStore(db, 3);

    vectorStore.upsert('CS-summary', new Float32Array([0.9, 0.1, 0.0]));
    vectorStore.upsert('LL-B01', new Float32Array([0.85, 0.15, 0.0]));
    vectorStore.upsert('LL-B02', new Float32Array([0.8, 0.2, 0.0]));

    const mockEmbed = {
      isReady: () => true,
      embed: async (texts) => [new Float32Array([0.9, 0.1, 0.0])],
      getModelInfo: () => ({ modelId: 'test', modelRev: 'test', dim: 3 }),
    };
    store.setEmbedDeps({ embedding: mockEmbed, vectorStore, mode: 'on' });

    const results = await store.search('Redis keyPrefix', { mode: 'hybrid', limit: 10 });
    const anchors = results.map((r) => r.anchor);
    assert.ok(anchors.includes('CS-summary'), 'summary should be returned in hybrid');
    assert.ok(!anchors.includes('LL-B01'), 'backstop LL-B01 should be excluded in hybrid');
    assert.ok(!anchors.includes('LL-B02'), 'backstop LL-B02 should be excluded in hybrid');
  });
});
