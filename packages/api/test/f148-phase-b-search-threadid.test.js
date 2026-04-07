// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');

describe('F148 Phase B: search_evidence threadId filter (AC-B1)', () => {
  /** @type {InstanceType<typeof SqliteEvidenceStore>} */
  let store;
  let tmpDir;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'f148-b1-'));
    store = new SqliteEvidenceStore(join(tmpDir, 'evidence.sqlite'));
    await store.initialize();

    // Seed: two threads + one doc
    const now = new Date().toISOString();
    await store.upsert([
      {
        anchor: 'thread-thread_abc',
        kind: 'thread',
        status: 'active',
        title: 'Redis CAS discussion',
        summary: 'Discussion about Redis optimistic locking with CAS pattern',
        keywords: ['redis', 'cas', 'optimistic-locking'],
        updatedAt: now,
      },
      {
        anchor: 'thread-thread_xyz',
        kind: 'thread',
        status: 'active',
        title: 'Deploy pipeline setup',
        summary: 'Setting up CI/CD deploy pipeline for staging',
        keywords: ['deploy', 'ci-cd'],
        updatedAt: now,
      },
      {
        anchor: 'F042',
        kind: 'spec',
        status: 'active',
        title: 'F042 Three-layer architecture',
        summary: 'Three-layer information architecture with Redis caching',
        keywords: ['architecture', 'redis'],
        updatedAt: now,
      },
    ]);
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('without threadId: returns all matching results', async () => {
    const results = await store.search('Redis');
    assert.ok(results.length >= 2, `expected >=2 results, got ${results.length}`);
    const anchors = results.map((r) => r.anchor);
    assert.ok(anchors.includes('thread-thread_abc'), 'should include thread_abc');
  });

  it('with threadId: returns only evidence from that thread', async () => {
    const results = await store.search('Redis', { threadId: 'thread_abc' });
    assert.equal(results.length, 1, 'should return exactly 1 result');
    assert.equal(results[0].anchor, 'thread-thread_abc');
  });

  it('with threadId: no match returns empty', async () => {
    const results = await store.search('Redis', { threadId: 'thread_xyz' });
    assert.equal(results.length, 0, 'thread_xyz has no Redis content');
  });

  it('with threadId: does not return non-thread evidence', async () => {
    const results = await store.search('Redis', { threadId: 'thread_abc' });
    const anchors = results.map((r) => r.anchor);
    assert.ok(!anchors.includes('F042'), 'should not include doc evidence');
  });

  it('R2-P1: with threadId + mode=semantic: does not leak other threads', async () => {
    // Mock EmbedDeps — vectorStore returns both threads, hydrate must filter
    const mockEmbedDeps = {
      embedding: {
        isReady: () => true,
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'test', modelRev: '1', dim: 3 }),
        dispose: () => {},
        load: async () => {},
      },
      vectorStore: {
        search: () => [
          { anchor: 'thread-thread_abc', distance: 0.1 },
          { anchor: 'thread-thread_xyz', distance: 0.2 },
        ],
      },
      mode: 'on',
    };
    /** @type {any} */ (store).embedDeps = mockEmbedDeps;

    const results = await store.search('Redis', { threadId: 'thread_abc', mode: 'semantic' });
    const anchors = results.map((r) => r.anchor);
    assert.ok(
      !anchors.includes('thread-thread_xyz'),
      `semantic: should not include thread_xyz, got: ${anchors.join(', ')}`,
    );
    assert.ok(anchors.includes('thread-thread_abc'), 'semantic: should include thread_abc');
  });

  it('R2-P1: with threadId + mode=hybrid: does not leak other threads', async () => {
    const mockEmbedDeps = {
      embedding: {
        isReady: () => true,
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'test', modelRev: '1', dim: 3 }),
        dispose: () => {},
        load: async () => {},
      },
      vectorStore: {
        search: () => [
          { anchor: 'thread-thread_abc', distance: 0.1 },
          { anchor: 'thread-thread_xyz', distance: 0.2 },
        ],
      },
      mode: 'on',
    };
    /** @type {any} */ (store).embedDeps = mockEmbedDeps;

    const results = await store.search('Redis', { threadId: 'thread_abc', mode: 'hybrid' });
    const anchors = results.map((r) => r.anchor);
    assert.ok(
      !anchors.includes('thread-thread_xyz'),
      `hybrid: should not include thread_xyz, got: ${anchors.join(', ')}`,
    );
    assert.ok(anchors.includes('thread-thread_abc'), 'hybrid: should include thread_abc');
  });

  it('P1-2: with threadId + depth=raw: does not leak passages from other threads', async () => {
    // Seed passages for both threads directly via db handle (private at TS level, accessible at JS runtime)
    const db = /** @type {any} */ (store).db;
    db.prepare(
      'INSERT OR IGNORE INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('thread-thread_abc', 'p-abc-1', 'Redis CAS lock acquired successfully', 'opus', 1, new Date().toISOString());
    db.prepare(
      'INSERT OR IGNORE INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('thread-thread_xyz', 'p-xyz-1', 'Redis connection pool tuning', 'codex', 1, new Date().toISOString());

    const results = await store.search('Redis', { threadId: 'thread_abc', depth: 'raw', scope: 'threads' });
    const anchors = results.map((r) => r.anchor);
    assert.ok(
      !anchors.includes('thread-thread_xyz'),
      `should not include thread_xyz, got anchors: ${anchors.join(', ')}`,
    );
    // Should still include thread_abc
    assert.ok(anchors.includes('thread-thread_abc'), 'should include thread_abc');
  });
});
