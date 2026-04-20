import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('IndexBuilder', () => {
  let tmpDir;
  let docsDir;
  let store;
  let builder;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-test-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });
    mkdirSync(join(docsDir, 'decisions'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    builder = new IndexBuilder(store, docsDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuild indexes docs with YAML frontmatter', async () => {
    writeFileSync(
      join(docsDir, 'features', 'F042-prompt-audit.md'),
      `---
feature_ids: [F042]
topics: [prompt, skills]
doc_kind: spec
---

# F042: Prompt Engineering Audit

Some content here about prompt engineering.
`,
    );

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 1);

    const item = await store.getByAnchor('F042');
    assert.ok(item, 'Should have indexed F042');
    assert.equal(item.kind, 'feature');
    assert.equal(item.title, 'F042: Prompt Engineering Audit');
    assert.ok(item.sourcePath.endsWith('F042-prompt-audit.md'));
  });

  it('rebuild indexes decisions', async () => {
    writeFileSync(
      join(docsDir, 'decisions', '005-hindsight.md'),
      `---
decision_id: ADR-005
topics: [hindsight, memory]
doc_kind: decision
---

# ADR-005: Hindsight Integration

Decision about using Hindsight.
`,
    );

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 1);

    const item = await store.getByAnchor('ADR-005');
    assert.ok(item);
    assert.equal(item.kind, 'decision');
  });

  it('rebuild indexes files without frontmatter using path-based anchor', async () => {
    writeFileSync(join(docsDir, 'features', 'no-frontmatter.md'), '# Just a title\n\nNo frontmatter here.');

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 1);

    const item = await store.getByAnchor('doc:features/no-frontmatter');
    assert.ok(item, 'should have indexed with path-based anchor (doc: prefix)');
    assert.equal(item.title, 'Just a title');
  });

  it('incrementalUpdate only re-indexes changed paths', async () => {
    const filePath = join(docsDir, 'features', 'F042-prompt-audit.md');
    writeFileSync(
      filePath,
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Original Title
`,
    );
    await builder.rebuild();
    assert.equal((await store.getByAnchor('F042')).title, 'F042: Original Title');

    writeFileSync(
      filePath,
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Updated Title
`,
    );
    await builder.incrementalUpdate([filePath]);
    assert.equal((await store.getByAnchor('F042')).title, 'F042: Updated Title');
  });

  it('checkConsistency reports ok when fts matches docs', async () => {
    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test Feature
`,
    );
    await builder.rebuild();

    const report = await builder.checkConsistency();
    assert.equal(report.ok, true);
    assert.equal(report.docCount, 1);
    assert.equal(report.ftsCount, 1);
    assert.deepEqual(report.mismatches, []);
  });

  it('rebuild with force re-indexes everything', async () => {
    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test
`,
    );
    const r1 = await builder.rebuild();
    assert.equal(r1.docsIndexed, 1);

    // Second rebuild without force — hash unchanged, should skip
    const r2 = await builder.rebuild();
    assert.equal(r2.docsSkipped, 1);

    // Force rebuild — should re-index
    const r3 = await builder.rebuild({ force: true });
    assert.equal(r3.docsIndexed, 1);
  });

  it('rebuild removes stale anchors for deleted files', async () => {
    const filePath = join(docsDir, 'features', 'F001.md');
    writeFileSync(
      filePath,
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Will Be Deleted
`,
    );
    await builder.rebuild();
    assert.ok(await store.getByAnchor('F001'), 'F001 should exist after rebuild');

    // Delete the file
    unlinkSync(filePath);
    await builder.rebuild();

    // F001 should be gone from the index
    const stale = await store.getByAnchor('F001');
    assert.equal(stale, null, 'F001 should be removed after file deletion');
  });

  it('rebuild indexes lessons directory', async () => {
    mkdirSync(join(docsDir, 'lessons'), { recursive: true });
    writeFileSync(
      join(docsDir, 'lessons', 'LL-001.md'),
      `---
anchor: LL-001
doc_kind: lesson
topics: [redis, pitfall]
---

# LL-001: Redis keyPrefix Pitfall

Lesson content about ioredis keyPrefix behavior.
`,
    );

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 1);

    const item = await store.getByAnchor('LL-001');
    assert.ok(item, 'Should have indexed lesson LL-001');
    assert.equal(item.kind, 'lesson');
    assert.equal(item.title, 'LL-001: Redis keyPrefix Pitfall');
  });

  it('extractAnchor recognizes anchor: field from materialized files', async () => {
    mkdirSync(join(docsDir, 'lessons'), { recursive: true });
    writeFileSync(
      join(docsDir, 'lessons', 'lesson-marker1.md'),
      `---
anchor: lesson-marker1
doc_kind: lesson
materialized_from: marker1
created: 2026-03-12
---

# Lesson from Marker

Some materialized lesson content.
`,
    );

    const result = await builder.rebuild();
    assert.ok(result.docsIndexed >= 1);

    const item = await store.getByAnchor('lesson-marker1');
    assert.ok(item, 'Should index file with anchor: frontmatter');
    assert.equal(item.kind, 'lesson');
  });

  it('getByAnchor is case-insensitive', async () => {
    writeFileSync(
      join(docsDir, 'features', 'F042.md'),
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Test Feature
`,
    );
    await builder.rebuild();

    const upper = await store.getByAnchor('F042');
    assert.ok(upper, 'Should find by uppercase F042');

    const lower = await store.getByAnchor('f042');
    assert.ok(lower, 'Should find by lowercase f042');

    assert.equal(upper.anchor, lower.anchor);
  });

  it('feature spec wins anchor collision over plan/lesson with same feature_ids', async () => {
    mkdirSync(join(docsDir, 'plans'), { recursive: true });
    mkdirSync(join(docsDir, 'lessons'), { recursive: true });

    // Feature spec for F042
    writeFileSync(
      join(docsDir, 'features', 'F042-prompt.md'),
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Prompt Engineering Audit
`,
    );

    // Plan that also references F042 (scanned after features)
    writeFileSync(
      join(docsDir, 'plans', 'plan-f042.md'),
      `---
feature_ids: [F042]
doc_kind: plan
---

# Plan for F042 Implementation
`,
    );

    // Lesson that also references F042 (scanned last)
    writeFileSync(
      join(docsDir, 'lessons', 'lesson-f042.md'),
      `---
feature_ids: [F042]
doc_kind: lesson
---

# Lesson from F042 Rollout
`,
    );

    await builder.rebuild({ force: true });

    const item = await store.getByAnchor('F042');
    assert.ok(item, 'F042 should exist');
    // Feature spec should win over plan/lesson
    assert.equal(item.kind, 'feature', 'Feature spec should win anchor collision');
    assert.ok(item.sourcePath.includes('features/'), `Source should be features/ dir, got: ${item.sourcePath}`);
  });

  it('incrementalUpdate does not let plan overwrite feature spec anchor', async () => {
    mkdirSync(join(docsDir, 'plans'), { recursive: true });

    const featurePath = join(docsDir, 'features', 'F042-prompt.md');
    writeFileSync(
      featurePath,
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Prompt Engineering Audit
`,
    );

    const planPath = join(docsDir, 'plans', 'plan-f042.md');
    writeFileSync(
      planPath,
      `---
feature_ids: [F042]
doc_kind: plan
---

# Plan for F042 Implementation
`,
    );

    // First rebuild — feature wins
    await builder.rebuild({ force: true });
    const before = await store.getByAnchor('F042');
    assert.equal(before.kind, 'feature', 'Feature should own anchor after rebuild');

    // Now incrementally update the plan file — should NOT overwrite feature
    await builder.incrementalUpdate([planPath]);
    const after = await store.getByAnchor('F042');
    assert.equal(after.kind, 'feature', 'Feature should still own anchor after plan incrementalUpdate');
    assert.ok(after.sourcePath.includes('features/'), `Source should remain features/, got: ${after.sourcePath}`);
  });

  it('incrementalUpdate: deleted feature + updated plan in same batch promotes plan', async () => {
    mkdirSync(join(docsDir, 'plans'), { recursive: true });

    const featurePath = join(docsDir, 'features', 'F042-prompt.md');
    writeFileSync(
      featurePath,
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Prompt Engineering Audit
`,
    );

    const planPath = join(docsDir, 'plans', 'plan-f042.md');
    writeFileSync(
      planPath,
      `---
feature_ids: [F042]
doc_kind: plan
---

# Plan for F042 Implementation
`,
    );

    // Rebuild — feature wins
    await builder.rebuild({ force: true });
    assert.equal((await store.getByAnchor('F042')).kind, 'feature');

    // Delete the feature file
    unlinkSync(featurePath);

    // incrementalUpdate with plan first, deleted feature second (worst-case ordering)
    await builder.incrementalUpdate([planPath, featurePath]);

    const after = await store.getByAnchor('F042');
    assert.ok(after, 'F042 should still exist — plan should take over after feature deletion');
    assert.equal(after.kind, 'plan', 'Plan should own anchor after feature is deleted');
  });

  it('P1-1: rebuild migrates anchor to lower-priority doc when higher-priority owner is deleted', async () => {
    mkdirSync(join(docsDir, 'plans'), { recursive: true });

    const featurePath = join(docsDir, 'features', 'F042-prompt.md');
    writeFileSync(
      featurePath,
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Prompt Engineering Audit
`,
    );

    const planPath = join(docsDir, 'plans', 'plan-f042.md');
    writeFileSync(
      planPath,
      `---
feature_ids: [F042]
doc_kind: plan
---

# Plan for F042 Implementation
`,
    );

    // First rebuild — feature wins
    await builder.rebuild({ force: true });
    const before = await store.getByAnchor('F042');
    assert.equal(before.kind, 'feature', 'Feature should own anchor initially');

    // Delete the feature file, plan still exists
    unlinkSync(featurePath);
    await builder.rebuild();

    const after = await store.getByAnchor('F042');
    assert.ok(after, 'F042 should still exist — plan should take over');
    assert.equal(after.kind, 'plan', 'Plan should own anchor after feature deletion');
    assert.ok(after.sourcePath.includes('plans/'), `Source should be plans/, got: ${after.sourcePath}`);
  });

  it('P1-2: incrementalUpdate backfills anchor from candidate doc when only delete event received', async () => {
    mkdirSync(join(docsDir, 'plans'), { recursive: true });

    const featurePath = join(docsDir, 'features', 'F042-prompt.md');
    writeFileSync(
      featurePath,
      `---
feature_ids: [F042]
doc_kind: spec
---

# F042: Prompt Engineering Audit
`,
    );

    const planPath = join(docsDir, 'plans', 'plan-f042.md');
    writeFileSync(
      planPath,
      `---
feature_ids: [F042]
doc_kind: plan
---

# Plan for F042 Implementation
`,
    );

    // Rebuild — feature wins
    await builder.rebuild({ force: true });
    assert.equal((await store.getByAnchor('F042')).kind, 'feature');

    // Delete feature file, but plan is NOT in changedPaths (only the delete)
    unlinkSync(featurePath);
    await builder.incrementalUpdate([featurePath]);

    const after = await store.getByAnchor('F042');
    assert.ok(after, 'F042 should still exist — plan should backfill after feature-only delete');
    assert.equal(after.kind, 'plan', 'Plan should own anchor after feature-only delete');
  });

  it('incrementalUpdate deletes anchor when file no longer exists', async () => {
    const filePath = join(docsDir, 'features', 'F099.md');
    writeFileSync(
      filePath,
      `---
feature_ids: [F099]
doc_kind: spec
---

# F099: Temporary
`,
    );
    await builder.rebuild();
    assert.ok(await store.getByAnchor('F099'));

    // Delete the file, then run incremental update on that path
    unlinkSync(filePath);
    await builder.incrementalUpdate([filePath]);

    const stale = await store.getByAnchor('F099');
    assert.equal(stale, null, 'F099 should be removed after incremental update');
  });
});

// ── Phase D-6: Session digest indexing ─────────────────────────────
describe('IndexBuilder with session digests (D6)', () => {
  let tmpDir;
  let docsDir;
  let transcriptDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-d6-test-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    transcriptDir = join(tmpDir, 'transcripts');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes session digests from transcript directory', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    // Create synthetic digest
    const sessionId = randomUUID();
    const threadId = 'thread_test123';
    const catId = 'opus';
    const digestDir = join(transcriptDir, 'threads', threadId, catId, 'sessions', sessionId);
    mkdirSync(digestDir, { recursive: true });

    writeFileSync(
      join(digestDir, 'digest.extractive.json'),
      JSON.stringify({
        v: 1,
        sessionId,
        threadId,
        catId,
        seq: 3,
        time: { createdAt: 1700000000000, sealedAt: 1700003600000 },
        invocations: [{ toolNames: ['Edit', 'Bash', 'Read'] }],
        filesTouched: [{ path: 'packages/api/src/index.ts', ops: ['edit'] }],
        errors: [],
      }),
    );

    const builder = new IndexBuilder(store, docsDir, undefined, transcriptDir);
    const result = await builder.rebuild();

    assert.ok(result.docsIndexed >= 1, 'should index at least the session digest');

    // Search for it
    // P1 fix: scope='threads' now maps to kind='thread', use scope='sessions' to find session digests
    const items = await store.search('Edit Bash', { scope: 'sessions' });
    assert.ok(items.length >= 1, 'should find session by tool names');
    assert.equal(items[0].kind, 'session');
    assert.ok(items[0].anchor.startsWith('session-'));
  });

  it('skips session digests when transcriptDataDir is not provided', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const builder = new IndexBuilder(store, docsDir); // no transcriptDataDir
    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 0);

    const db = store.getDb();
    const count = db.prepare("SELECT count(*) as c FROM evidence_docs WHERE kind = 'session'").get();
    assert.equal(count.c, 0);
  });

  it('P1 regression: different sessionIds produce unique anchors (no collision)', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const threadId = 'thread_collision_test';
    const catId = 'opus';
    // Two sessions with different UUIDs
    const sessionId1 = 'abcdef12-1111-4000-8000-000000000001';
    const sessionId2 = 'abcdef12-1112-4000-8000-000000000002';

    for (const [sid, seq] of [
      [sessionId1, 1],
      [sessionId2, 2],
    ]) {
      const digestDir = join(transcriptDir, 'threads', threadId, catId, 'sessions', sid);
      mkdirSync(digestDir, { recursive: true });
      writeFileSync(
        join(digestDir, 'digest.extractive.json'),
        JSON.stringify({
          v: 1,
          sessionId: sid,
          threadId,
          catId,
          seq,
          time: { createdAt: 1700000000000, sealedAt: 1700003600000 },
          invocations: [],
          filesTouched: [],
          errors: [],
        }),
      );
    }

    const builder = new IndexBuilder(store, docsDir, undefined, transcriptDir);
    await builder.rebuild({ force: true });

    const db = store.getDb();
    const sessionCount = db.prepare("SELECT count(*) as c FROM evidence_docs WHERE kind = 'session'").get();
    assert.equal(sessionCount.c, 2, 'Both sessions should be indexed (no anchor collision)');
  });
});

// ── Phase C: IndexBuilder + embedding integration ─────────────────
describe('IndexBuilder with embedding', () => {
  let tmpDir;
  let docsDir;
  let store;
  let vectorStore;
  let mockEmbedding;
  let embedCallCount;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-embed-test-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { applyMigrations, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4);
    vectorStore = new VectorStore(db, 4);

    embedCallCount = 0;
    mockEmbedding = {
      isReady: () => true,
      embed: async (texts) => {
        embedCallCount++;
        return texts.map(() => new Float32Array([0.5, 0.5, 0.5, 0.5]));
      },
      getModelInfo: () => ({ modelId: 'test-model', modelRev: 'v1', dim: 4 }),
      dispose: () => {},
      load: async () => {},
    };
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuild generates vectors when embedding service ready', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test Feature

A test feature for embedding.
`,
    );
    writeFileSync(
      join(docsDir, 'features', 'F002.md'),
      `---
feature_ids: [F002]
doc_kind: spec
---

# F002: Another Feature

Another feature for embedding.
`,
    );

    const builder = new IndexBuilder(store, docsDir, { embedding: mockEmbedding, vectorStore });
    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 2);
    assert.equal(vectorStore.count(), 2, 'should have 2 vectors');
    // Meta should be written
    const meta = vectorStore.getMeta();
    assert.equal(meta.embedding_model_id, 'test-model');
  });

  it('rebuild skips vectors when embedding not ready', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test
`,
    );

    const notReady = { ...mockEmbedding, isReady: () => false };
    const builder = new IndexBuilder(store, docsDir, { embedding: notReady, vectorStore });
    await builder.rebuild();
    assert.equal(vectorStore.count(), 0, 'no vectors when not ready');
  });

  it('rebuild detects model change and re-embeds all', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test Feature

Some content.
`,
    );

    // First rebuild with model A
    const builder = new IndexBuilder(store, docsDir, { embedding: mockEmbedding, vectorStore });
    await builder.rebuild();
    assert.equal(vectorStore.count(), 1);
    assert.equal(vectorStore.getMeta().embedding_model_id, 'test-model');

    // Now change model info — checkMetaConsistency will say inconsistent
    const modelB = {
      ...mockEmbedding,
      getModelInfo: () => ({ modelId: 'model-B', modelRev: 'v2', dim: 4 }),
    };
    const builder2 = new IndexBuilder(store, docsDir, { embedding: modelB, vectorStore });
    // Force rebuild so the doc gets re-indexed even though hash hasn't changed
    await builder2.rebuild({ force: true });
    assert.equal(vectorStore.count(), 1, 'still 1 vector after re-embed');
    assert.equal(vectorStore.getMeta().embedding_model_id, 'model-B', 'meta updated to model-B');
  });

  it('incrementalUpdate deletes stale vectors when doc removed (P1)', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const f1 = join(docsDir, 'features', 'F001.md');
    const f2 = join(docsDir, 'features', 'F002.md');
    writeFileSync(
      f1,
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Feature One
`,
    );
    writeFileSync(
      f2,
      `---
feature_ids: [F002]
doc_kind: spec
---

# F002: Feature Two
`,
    );

    const builder = new IndexBuilder(store, docsDir, { embedding: mockEmbedding, vectorStore });
    await builder.rebuild();
    assert.equal(vectorStore.count(), 2);

    // Delete F001 file
    unlinkSync(f1);
    await builder.incrementalUpdate([f1]);

    assert.equal(vectorStore.count(), 1, 'stale vector deleted');
    assert.equal(await store.getByAnchor('F001'), null, 'doc also removed');
  });

  it('incrementalUpdate embeds new/changed docs only', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Original
`,
    );

    const builder = new IndexBuilder(store, docsDir, { embedding: mockEmbedding, vectorStore });
    await builder.rebuild();
    assert.equal(vectorStore.count(), 1);
    const firstEmbedCount = embedCallCount;

    // Add a new doc
    const f2 = join(docsDir, 'features', 'F002.md');
    writeFileSync(
      f2,
      `---
feature_ids: [F002]
doc_kind: spec
---

# F002: New Feature

Brand new.
`,
    );

    await builder.incrementalUpdate([f2]);
    assert.equal(vectorStore.count(), 2, 'new vector added');
    // embed() should only be called once more (for the new doc, not the existing one)
    assert.equal(embedCallCount - firstEmbedCount, 1, 'embed called only for new doc');
  });
});

// ── Phase E: Thread summary indexing ──────────────────────────────
describe('IndexBuilder thread summary (E1/E2)', () => {
  let tmpDir;
  let docsDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-e-test-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('E1: indexes thread summaries from threadListFn', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const mockThreads = [
      {
        id: 'thread_abc123',
        title: 'Redis pitfall discussion',
        participants: ['opus', 'codex'],
        threadMemory: { summary: 'Discussed Redis keyPrefix pitfall with ioredis eval commands.' },
        lastActiveAt: Date.now(),
        featureIds: ['F113'],
      },
    ];

    const builder = new IndexBuilder(store, docsDir, undefined, undefined, () => mockThreads);
    await builder.rebuild();

    const item = await store.getByAnchor('thread-thread_abc123');
    assert.ok(item, 'thread should be indexed');
    assert.equal(item.kind, 'thread');
    assert.equal(item.title, 'Redis pitfall discussion');
    assert.ok(item.summary.includes('Redis keyPrefix'));
  });

  it('E1: threadListFn error does not delete existing thread anchors', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    // First: index a thread successfully
    const builder1 = new IndexBuilder(store, docsDir, undefined, undefined, () => [
      {
        id: 'thread_keep',
        title: 'Important thread',
        participants: ['opus'],
        threadMemory: { summary: 'This should survive errors.' },
        lastActiveAt: Date.now(),
      },
    ]);
    await builder1.rebuild();
    assert.ok(await store.getByAnchor('thread-thread_keep'), 'thread should exist after first rebuild');

    // Second: rebuild with a failing threadListFn
    const builder2 = new IndexBuilder(store, docsDir, undefined, undefined, () => {
      throw new Error('Redis connection lost');
    });
    await builder2.rebuild();

    // Thread should NOT be deleted
    const after = await store.getByAnchor('thread-thread_keep');
    assert.ok(after, 'thread should survive threadListFn error (P1 regression)');
    assert.equal(after.kind, 'thread');
  });

  it('E2: markThreadDirty + flushDirtyThreads updates index', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    let version = 'v1';
    const builder = new IndexBuilder(store, docsDir, undefined, undefined, () => [
      {
        id: 'thread_dirty',
        title: 'Dirty thread',
        participants: ['opus'],
        threadMemory: { summary: `Content ${version}` },
        lastActiveAt: Date.now(),
      },
    ]);

    await builder.rebuild();
    const before = await store.getByAnchor('thread-thread_dirty');
    assert.ok(before.summary.includes('v1'));

    // Simulate update
    version = 'v2';
    builder.markThreadDirty('thread_dirty');
    const flushed = await builder.flushDirtyThreads();
    assert.equal(flushed, 1, 'should flush 1 dirty thread');

    const after = await store.getByAnchor('thread-thread_dirty');
    assert.ok(after.summary.includes('v2'), 'summary should be updated to v2');
  });
});

// ── Phase E Step 2: Passage indexing + search ──────────────────────
describe('IndexBuilder passage indexing (E3/E4/E5)', () => {
  let tmpDir;
  let docsDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-e3-test-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('E3+E4: indexes thread messages as passages in evidence_passages', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const mockThreads = [
      {
        id: 'thread_pass1',
        title: 'Redis discussion',
        participants: ['opus', 'codex'],
        threadMemory: { summary: 'Discussed Redis keyPrefix behavior.' },
        lastActiveAt: Date.now(),
      },
    ];

    const mockMessages = [
      {
        id: 'msg_001',
        content: 'What happens with keyPrefix in eval?',
        catId: undefined,
        threadId: 'thread_pass1',
        timestamp: Date.now() - 2000,
      },
      {
        id: 'msg_002',
        content: 'ioredis keyPrefix does not apply inside eval scripts.',
        catId: 'opus',
        threadId: 'thread_pass1',
        timestamp: Date.now() - 1000,
      },
      {
        id: 'msg_003',
        content: 'Good catch, lets document this as a lesson.',
        catId: 'codex',
        threadId: 'thread_pass1',
        timestamp: Date.now(),
      },
    ];

    const messageListFn = (threadId) => {
      if (threadId === 'thread_pass1') return mockMessages;
      return [];
    };

    const builder = new IndexBuilder(store, docsDir, undefined, undefined, () => mockThreads, messageListFn);
    await builder.rebuild();

    // Verify passages were inserted
    const db = store.getDb();
    const passages = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('thread-thread_pass1');
    assert.equal(passages.length, 3, 'should have 3 passages');
    assert.equal(passages[0].passage_id, 'msg-msg_001');
    assert.equal(passages[0].speaker, 'user'); // no catId → 'user'
    assert.equal(passages[0].position, 0);
    assert.equal(passages[1].passage_id, 'msg-msg_002');
    assert.equal(passages[1].speaker, 'opus');
    assert.equal(passages[2].speaker, 'codex');
  });

  it('E5: searchPassages finds passages via FTS and search() merges them with depth=raw', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const mockThreads = [
      {
        id: 'thread_search1',
        title: 'Architecture chat',
        participants: ['opus'],
        threadMemory: { summary: 'General architecture discussion.' },
        lastActiveAt: Date.now(),
      },
    ];

    const mockMessages = [
      {
        id: 'msg_s1',
        content: 'The SystemPromptBuilder needs refactoring for modularity.',
        catId: 'opus',
        threadId: 'thread_search1',
        timestamp: Date.now() - 1000,
      },
      {
        id: 'msg_s2',
        content: 'Agreed, the prompt sections should be pluggable.',
        threadId: 'thread_search1',
        timestamp: Date.now(),
      },
    ];

    const builder = new IndexBuilder(
      store,
      docsDir,
      undefined,
      undefined,
      () => mockThreads,
      (tid) => {
        if (tid === 'thread_search1') return mockMessages;
        return [];
      },
    );
    await builder.rebuild();

    // Direct passage search
    const passages = store.searchPassages('SystemPromptBuilder');
    assert.ok(passages.length >= 1, 'should find passage by content');
    assert.equal(passages[0].docAnchor, 'thread-thread_search1');
    assert.equal(passages[0].speaker, 'opus');

    // Full search with depth=raw should find the thread (via FTS5 on message content summary or passage match)
    const results = await store.search('SystemPromptBuilder', { depth: 'raw', scope: 'all' });
    assert.ok(results.length >= 1, 'depth=raw search should find thread docs');
    const threadResult = results.find((r) => r.anchor === 'thread-thread_search1');
    assert.ok(threadResult, 'should find the thread doc (via summary or passage match)');
  });

  it('I2: rebuild does not delete existing passages when Redis returns fewer messages', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const mockThreads = [
      {
        id: 'thread_perm1',
        title: 'Permanence test',
        participants: ['opus'],
        threadMemory: { summary: 'Testing passage permanence.' },
        lastActiveAt: Date.now(),
      },
    ];

    const allMessages = [
      {
        id: 'perm_001',
        content: 'First message that will expire from Redis',
        catId: 'opus',
        threadId: 'thread_perm1',
        timestamp: Date.now() - 3000,
      },
      {
        id: 'perm_002',
        content: 'Second message still in Redis',
        catId: 'opus',
        threadId: 'thread_perm1',
        timestamp: Date.now() - 2000,
      },
      {
        id: 'perm_003',
        content: 'Third message still in Redis',
        catId: 'user',
        threadId: 'thread_perm1',
        timestamp: Date.now() - 1000,
      },
    ];

    // First rebuild: all 3 messages available
    let currentMessages = allMessages;
    const messageListFn = (threadId) => {
      if (threadId === 'thread_perm1') return currentMessages;
      return [];
    };

    const builder = new IndexBuilder(store, docsDir, undefined, undefined, () => mockThreads, messageListFn);
    await builder.rebuild();

    const db = store.getDb();
    const passagesAfterFirst = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('thread-thread_perm1');
    assert.equal(passagesAfterFirst.length, 3, 'first rebuild: should have 3 passages');

    // Simulate Redis expiry: only 1 message remains
    currentMessages = [allMessages[1]];
    await builder.rebuild();

    const passagesAfterSecond = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('thread-thread_perm1');
    assert.equal(passagesAfterSecond.length, 3, 'second rebuild: all 3 passages must persist (AC-I2)');
    assert.equal(passagesAfterSecond[0].passage_id, 'msg-perm_001', 'expired message passage still exists');
  });

  it('I1: backfillPassagesFromTranscript adds passages from JSONL events', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const threadId = 'thread_bf1';
    const catId = 'opus';
    const sessionId = 'sess_001';

    // Create JSONL transcript directory structure
    const transcriptDir = join(tmpDir, 'transcripts');
    const sessDir = join(transcriptDir, 'threads', threadId, catId, 'sessions', sessionId);
    mkdirSync(sessDir, { recursive: true });

    // Write events.jsonl with text events from two invocations
    const events = [
      {
        v: 1,
        t: Date.now() - 3000,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_001',
        eventNo: 0,
        event: { type: 'text', content: 'Hello from ' },
      },
      {
        v: 1,
        t: Date.now() - 2900,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_001',
        eventNo: 1,
        event: { type: 'text', content: 'first invocation.' },
      },
      {
        v: 1,
        t: Date.now() - 2000,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_002',
        eventNo: 2,
        event: { type: 'tool_use', name: 'Read' },
      },
      {
        v: 1,
        t: Date.now() - 1000,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_002',
        eventNo: 3,
        event: { type: 'text', content: 'Second invocation response.' },
      },
    ];
    writeFileSync(join(sessDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // Create builder with transcriptDataDir but no messageListFn
    const builder = new IndexBuilder(store, docsDir, undefined, transcriptDir);

    const added = await builder.backfillPassagesFromTranscript(threadId);
    assert.equal(added, 2, 'should add 2 passages (one per invocation with text)');

    const db = store.getDb();
    const passages = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all(`thread-${threadId}`);
    assert.equal(passages.length, 2);
    assert.equal(passages[0].passage_id, 'transcript-inv_001');
    assert.equal(passages[0].content, 'Hello from first invocation.');
    assert.equal(passages[0].speaker, 'opus');
    assert.equal(passages[1].passage_id, 'transcript-inv_002');
    assert.equal(passages[1].content, 'Second invocation response.');

    // Idempotent: running again adds nothing
    const addedAgain = await builder.backfillPassagesFromTranscript(threadId);
    assert.equal(addedAgain, 0, 'second run should add 0 (INSERT OR IGNORE)');
  });

  it('I3: rebuild runs transcript backfill after Redis-based passage indexing', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const threadId = 'thread_rebuild_bf';
    const catId = 'opus';
    const sessionId = 'sess_rb1';

    const mockThreads = [
      {
        id: threadId,
        title: 'Rebuild backfill test',
        participants: ['opus'],
        threadMemory: { summary: 'Testing rebuild with backfill.' },
        lastActiveAt: Date.now(),
      },
    ];

    // messageListFn returns empty (all Redis messages expired)
    const messageListFn = () => [];

    // Create JSONL transcript with text events
    const transcriptDir = join(tmpDir, 'transcripts');
    const sessDir = join(transcriptDir, 'threads', threadId, catId, 'sessions', sessionId);
    mkdirSync(sessDir, { recursive: true });

    const events = [
      {
        v: 1,
        t: Date.now() - 2000,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_rb1',
        eventNo: 0,
        event: { type: 'text', content: 'Recovered from transcript.' },
      },
    ];
    writeFileSync(join(sessDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const builder = new IndexBuilder(store, docsDir, undefined, transcriptDir, () => mockThreads, messageListFn);
    await builder.rebuild();

    const db = store.getDb();
    const passages = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all(`thread-${threadId}`);
    assert.ok(passages.length >= 1, 'rebuild should have backfilled passages from JSONL (AC-I3)');
    assert.equal(passages[0].passage_id, 'transcript-inv_rb1');
    assert.equal(passages[0].content, 'Recovered from transcript.');
  });

  it('I4: searchPassages filters by dateFrom/dateTo', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const threadId = 'thread_time1';
    const mockThreads = [
      {
        id: threadId,
        title: 'Time filter test',
        participants: ['opus'],
        threadMemory: { summary: 'Time filtering test.' },
        lastActiveAt: Date.now(),
      },
    ];

    // Insert messages with specific timestamps
    const mockMessages = [
      {
        id: 'time_001',
        content: 'Old message about architecture',
        catId: 'opus',
        threadId,
        timestamp: new Date('2026-03-10T12:00:00Z').getTime(),
      },
      {
        id: 'time_002',
        content: 'Middle message about architecture',
        catId: 'opus',
        threadId,
        timestamp: new Date('2026-03-18T12:00:00Z').getTime(),
      },
      {
        id: 'time_003',
        content: 'Recent message about architecture',
        catId: 'opus',
        threadId,
        timestamp: new Date('2026-03-25T12:00:00Z').getTime(),
      },
    ];

    const builder = new IndexBuilder(
      store,
      docsDir,
      undefined,
      undefined,
      () => mockThreads,
      () => mockMessages,
    );
    await builder.rebuild();

    // Search with date range that only includes middle message
    const filtered = store.searchPassages('architecture', 10, { dateFrom: '2026-03-15', dateTo: '2026-03-20' });
    assert.equal(filtered.length, 1, 'should only find middle message within date range');
    assert.equal(filtered[0].passageId, 'msg-time_002');

    // Search without date filter returns all
    const unfiltered = store.searchPassages('architecture', 10);
    assert.equal(unfiltered.length, 3, 'without date filter should find all 3');
  });
});

// ── F102 Phase F-2: Recursive fallback discovery ────────────────────

describe('IndexBuilder recursive fallback (F-2)', () => {
  let tmpDir;
  let docsDir;
  let store;
  let builder;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-f2-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    builder = new IndexBuilder(store, docsDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes .md files in non-standard directories', async () => {
    mkdirSync(join(docsDir, 'custom-notes'), { recursive: true });
    writeFileSync(
      join(docsDir, 'custom-notes', 'meeting.md'),
      '# Team Meeting Notes\n\nDiscussion about architecture.',
    );

    const result = await builder.rebuild();
    assert.ok(result.docsIndexed >= 1, 'should index .md from non-standard dir');

    const item = await store.getByAnchor('doc:custom-notes/meeting');
    assert.ok(item, 'should have path-based anchor');
    assert.equal(item.kind, 'plan'); // default kind for unknown dirs
    assert.equal(item.title, 'Team Meeting Notes');
  });

  it('respects frontmatter doc_kind for non-standard dir files', async () => {
    mkdirSync(join(docsDir, 'random'), { recursive: true });
    writeFileSync(
      join(docsDir, 'random', 'api-review.md'),
      `---
doc_kind: decision
anchor: REVIEW-001
---

# API Review Decision

We decided to use REST.
`,
    );

    await builder.rebuild();
    const item = await store.getByAnchor('REVIEW-001');
    assert.ok(item, 'should index with explicit anchor');
    assert.equal(item.kind, 'decision'); // from frontmatter, not path
  });

  it('excludes node_modules and .git from fallback scan', async () => {
    mkdirSync(join(docsDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(docsDir, 'node_modules', 'pkg', 'README.md'), '# Package\n');

    mkdirSync(join(docsDir, '.git', 'info'), { recursive: true });
    writeFileSync(join(docsDir, '.git', 'info', 'notes.md'), '# Git Notes\n');

    mkdirSync(join(docsDir, 'misc'), { recursive: true });
    writeFileSync(join(docsDir, 'misc', 'valid.md'), '# Valid Doc\n');

    const result = await builder.rebuild();

    const nodeModItem = await store.getByAnchor('doc:node_modules/pkg/README');
    assert.equal(nodeModItem, null, 'should NOT index node_modules');

    const gitItem = await store.getByAnchor('doc:.git/info/notes');
    assert.equal(gitItem, null, 'should NOT index .git');

    const validItem = await store.getByAnchor('doc:misc/valid');
    assert.ok(validItem, 'should index valid misc dir');
  });

  it('excludes nested node_modules and .git from fallback scan', async () => {
    mkdirSync(join(docsDir, 'misc', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(docsDir, 'misc', 'node_modules', 'pkg', 'README.md'), '# Package\n');

    mkdirSync(join(docsDir, 'misc', '.git', 'info'), { recursive: true });
    writeFileSync(join(docsDir, 'misc', '.git', 'info', 'notes.md'), '# Git Notes\n');

    mkdirSync(join(docsDir, 'misc', 'valid-sub'), { recursive: true });
    writeFileSync(join(docsDir, 'misc', 'valid-sub', 'doc.md'), '# Valid Nested Doc\n');

    await builder.rebuild();

    const nestedNM = await store.getByAnchor('doc:misc/node_modules/pkg/README');
    assert.equal(nestedNM, null, 'should NOT index nested node_modules');

    const nestedGit = await store.getByAnchor('doc:misc/.git/info/notes');
    assert.equal(nestedGit, null, 'should NOT index nested .git');

    const validNested = await store.getByAnchor('doc:misc/valid-sub/doc');
    assert.ok(validNested, 'should index valid nested subdirectory');
  });

  it('does not double-index files already found in KIND_DIRS', async () => {
    // Create a file in a standard KIND_DIR
    mkdirSync(join(docsDir, 'features'), { recursive: true });
    writeFileSync(
      join(docsDir, 'features', 'F099.md'),
      `---
feature_ids: [F099]
doc_kind: spec
---

# F099: Test Feature
`,
    );

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 1, 'should index exactly once');
  });

  it('recurses into nested non-standard subdirectories', async () => {
    mkdirSync(join(docsDir, 'team', 'backend', 'notes'), { recursive: true });
    writeFileSync(
      join(docsDir, 'team', 'backend', 'notes', 'api-v3.md'),
      '# API v3 Design\n\nNested doc about API design.',
    );

    await builder.rebuild();
    const item = await store.getByAnchor('doc:team/backend/notes/api-v3');
    assert.ok(item, 'should find deeply nested .md');
    assert.equal(item.title, 'API v3 Design');
  });

  it('legacy project with no standard dirs: search finds docs after rebuild', async () => {
    mkdirSync(join(docsDir, 'notes'), { recursive: true });
    writeFileSync(
      join(docsDir, 'notes', 'redis-setup.md'),
      `---
doc_kind: plan
topics: [redis, setup]
---

# Redis Setup Guide

How to configure Redis for production deployment.
`,
    );

    await builder.rebuild();
    const results = await store.search('redis setup', { limit: 5 });
    assert.ok(results.length >= 1, 'should find redis doc via search');
    assert.ok(
      results.some((r) => r.title.includes('Redis')),
      'result should include redis doc',
    );
  });
});

// ── F152 Phase A: CatCafeScanner ────────────────────────────────────

describe('F152 Phase A: CatCafeScanner', () => {
  let tmpDir;
  let docsDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `f152-scanner-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });
    mkdirSync(join(docsDir, 'decisions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discover() returns ScannedEvidence with authoritative provenance', async () => {
    writeFileSync(
      join(docsDir, 'features', 'F099-test.md'),
      `---
feature_ids: [F099]
topics: [test]
doc_kind: spec
---

# F099: Test Feature

Some test content.
`,
    );

    const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
    const scanner = new CatCafeScanner();
    const results = scanner.discover(docsDir);

    const f099 = results.find((r) => r.item.anchor === 'F099');
    assert.ok(f099, 'should discover F099');
    assert.equal(f099.provenance.tier, 'authoritative');
    assert.ok(f099.provenance.source.includes('features'));
    assert.ok(f099.rawContent.includes('Test Feature'));
    assert.equal(f099.item.kind, 'feature');
  });

  it('discover() handles files without frontmatter', async () => {
    writeFileSync(join(docsDir, 'VISION.md'), '# Vision\n\nOur vision statement.');

    const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
    const scanner = new CatCafeScanner();
    const results = scanner.discover(docsDir);

    const vision = results.find((r) => r.item.anchor === 'doc:VISION');
    assert.ok(vision, 'should discover VISION.md');
    assert.equal(vision.provenance.tier, 'authoritative');
  });

  it('discover() splits lessons-learned.md', async () => {
    writeFileSync(
      join(docsDir, 'lessons-learned.md'),
      `---
doc_kind: lesson
---

# Lessons Learned

### LL-001: Test lesson
Some lesson content.

关联：Redis | testing

### LL-002: Another lesson
More content here.
`,
    );

    const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
    const scanner = new CatCafeScanner();
    const results = scanner.discover(docsDir);

    const ll1 = results.find((r) => r.item.anchor === 'LL-001');
    assert.ok(ll1, 'should split LL-001');
    assert.equal(ll1.item.kind, 'lesson');
    assert.equal(ll1.provenance.tier, 'authoritative');

    const ll2 = results.find((r) => r.item.anchor === 'LL-002');
    assert.ok(ll2, 'should split LL-002');
  });

  it('parseSingle() returns ScannedEvidence for one file', async () => {
    writeFileSync(
      join(docsDir, 'features', 'F100-single.md'),
      `---
feature_ids: [F100]
topics: [parse]
doc_kind: spec
---

# F100: Single Parse

Content for single file parse.
`,
    );

    const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
    const scanner = new CatCafeScanner();
    const result = scanner.parseSingle(join(docsDir, 'features', 'F100-single.md'), docsDir);

    assert.ok(result, 'should parse single file');
    assert.equal(result.item.anchor, 'F100');
    assert.equal(result.provenance.tier, 'authoritative');
  });
});

// ── F152 Phase A: Auto-selection (AC-A3) ────────────────────────────

describe('F152 Phase A: Auto-selection', () => {
  it('auto-selects GenericRepoScanner for non-cat-cafe repos', async () => {
    const genericDir = join(tmpdir(), `f152-auto-${randomUUID().slice(0, 8)}`);
    mkdirSync(genericDir, { recursive: true });
    writeFileSync(join(genericDir, 'README.md'), '# Generic Project\n\nA non-cat-cafe project.');
    writeFileSync(
      join(genericDir, 'package.json'),
      JSON.stringify({ name: 'generic', version: '1.0.0', description: 'test' }),
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const genericStore = new SqliteEvidenceStore(':memory:');
    await genericStore.initialize();
    const genericBuilder = new IndexBuilder(genericStore, genericDir);

    const result = await genericBuilder.rebuild();
    assert.ok(result.docsIndexed >= 2, 'should index README + package.json');

    // Key test: package.json should be 'derived' — only GenericRepoScanner does this
    const pkg = await genericStore.getByAnchor('doc:package');
    assert.ok(pkg, 'GenericRepoScanner should index package.json');
    assert.equal(pkg.provenance?.tier, 'derived', 'package.json must be derived tier');

    genericStore.close();
    rmSync(genericDir, { recursive: true, force: true });
  });

  it('auto-selects CatCafeScanner when features/ dir exists', async () => {
    const catDir = join(tmpdir(), `f152-cat-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(catDir, 'features'), { recursive: true });
    writeFileSync(
      join(catDir, 'features', 'F001-test.md'),
      '---\nfeature_ids: [F001]\ntopics: [test]\ndoc_kind: spec\n---\n\n# F001: Test\n\nContent.\n',
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const catStore = new SqliteEvidenceStore(':memory:');
    await catStore.initialize();
    const catBuilder = new IndexBuilder(catStore, catDir);

    const result = await catBuilder.rebuild();
    const f001 = await catStore.getByAnchor('F001');
    assert.ok(f001, 'CatCafeScanner should find F001');
    assert.equal(f001.kind, 'feature');

    catStore.close();
    rmSync(catDir, { recursive: true, force: true });
  });

  it('auto-selects GenericRepoScanner when docsRoot is docs/ subdir (P1-1 fix)', async () => {
    // Production layout: projectRoot/package.json + projectRoot/docs/ (passed as docsRoot)
    const projectRoot = join(tmpdir(), `f152-prod-${randomUUID().slice(0, 8)}`);
    const docsSubdir = join(projectRoot, 'docs');
    mkdirSync(docsSubdir, { recursive: true });
    writeFileSync(join(projectRoot, 'README.md'), '# External Project\n\nSome project.');
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'external-app', version: '2.0.0', description: 'real app' }),
    );
    writeFileSync(join(docsSubdir, 'guide.md'), '# Dev Guide\n\nHow to develop.');

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const extStore = new SqliteEvidenceStore(':memory:');
    await extStore.initialize();
    // Pass docs/ subdir as docsRoot — just like production createMemoryServices
    const extBuilder = new IndexBuilder(extStore, docsSubdir);

    const result = await extBuilder.rebuild();
    // GenericRepoScanner should detect manifest in parent dir and scan from project root
    const pkg = await extStore.getByAnchor('doc:package');
    assert.ok(pkg, 'should find package.json via parent-dir manifest detection');
    assert.equal(pkg.provenance?.tier, 'derived', 'package.json must be derived tier');

    const readme = await extStore.getByAnchor('doc:README');
    assert.ok(readme, 'should find README.md at project root');
    assert.equal(readme.provenance?.tier, 'authoritative');

    extStore.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('search finds GenericRepoScanner results via FTS5 (AC-A4)', async () => {
    const genericDir = join(tmpdir(), `f152-search-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(genericDir, 'docs'), { recursive: true });
    writeFileSync(join(genericDir, 'README.md'), '# Widget Factory\n\nBuilds amazing widgets.');
    writeFileSync(join(genericDir, 'docs', 'setup.md'), '# Setup Guide\n\nHow to install widget factory.');

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const genericStore = new SqliteEvidenceStore(':memory:');
    await genericStore.initialize();
    const genericBuilder = new IndexBuilder(genericStore, genericDir);
    await genericBuilder.rebuild();

    const results = await genericStore.search('widget factory');
    assert.ok(results.length >= 1, 'should find widget docs via FTS5');

    genericStore.close();
    rmSync(genericDir, { recursive: true, force: true });
  });

  it('incrementalUpdate works with GenericRepoScanner when docsRoot is docs/ subdir (P1-5 fix)', async () => {
    // Production layout: projectRoot/docs/ passed as docsRoot, scanRoot resolves to projectRoot
    const projectRoot = join(tmpdir(), `f152-incr-${randomUUID().slice(0, 8)}`);
    const docsSubdir = join(projectRoot, 'docs');
    mkdirSync(docsSubdir, { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"incr-test"}');
    writeFileSync(join(docsSubdir, 'guide.md'), '# Guide\n\nOld content.');

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const incrStore = new SqliteEvidenceStore(':memory:');
    await incrStore.initialize();
    const builder = new IndexBuilder(incrStore, docsSubdir);
    await builder.rebuild();

    // source_path should be relative to scanRoot (projectRoot), not docsRoot
    const before = await incrStore.getByAnchor('doc:docs/guide');
    assert.ok(before, 'should find guide after rebuild');
    assert.equal(before.sourcePath, 'docs/guide.md', 'source_path relative to scanRoot');
    assert.ok(before.summary?.includes('Old'), 'initial summary should contain Old');

    // Modify the file and run incrementalUpdate
    writeFileSync(join(docsSubdir, 'guide.md'), '# Guide\n\nNew updated content.');
    await builder.incrementalUpdate([join(docsSubdir, 'guide.md')]);

    const after = await incrStore.getByAnchor('doc:docs/guide');
    assert.ok(after, 'should still find guide after incrementalUpdate');
    assert.ok(after.summary?.includes('New'), `summary should be updated (got: ${after.summary})`);

    incrStore.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });
});

// ── F152 Phase A: Provenance ────────────────────────────────────────

describe('F152 Phase A: Provenance', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
  });

  it('V10 migration adds provenance columns', () => {
    const db = store.getDb();
    const columns = db.pragma('table_info(evidence_docs)').map((c) => c.name);
    assert.ok(columns.includes('provenance_tier'), 'should have provenance_tier column');
    assert.ok(columns.includes('provenance_source'), 'should have provenance_source column');
  });

  it('upsert + getByAnchor round-trips provenance', async () => {
    await store.upsert([
      {
        anchor: 'test-prov',
        kind: 'research',
        status: 'active',
        title: 'Test provenance',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'derived', source: 'package.json' },
      },
    ]);
    const item = await store.getByAnchor('test-prov');
    assert.ok(item);
    assert.deepStrictEqual(item.provenance, { tier: 'derived', source: 'package.json' });
  });

  it('search filters by provenanceTier (AC-A6)', async () => {
    await store.upsert([
      {
        anchor: 'auth-doc',
        kind: 'plan',
        status: 'active',
        title: 'Authoritative setup guide',
        summary: 'How to set up the project',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'authoritative', source: 'README.md' },
      },
      {
        anchor: 'derived-doc',
        kind: 'research',
        status: 'active',
        title: 'Derived setup manifest',
        summary: 'Package manifest with setup info',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'derived', source: 'package.json' },
      },
      {
        anchor: 'soft-doc',
        kind: 'lesson',
        status: 'active',
        title: 'Soft clue setup changelog',
        summary: 'Changelog entry about setup',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'soft_clue', source: 'CHANGELOG.md' },
      },
    ]);

    const authOnly = await store.search('setup', { provenanceTier: 'authoritative' });
    assert.ok(authOnly.length >= 1, 'should find authoritative docs');
    assert.ok(
      authOnly.every((r) => r.provenance?.tier === 'authoritative'),
      'all results should be authoritative',
    );
  });

  it('search boosts authoritative results (AC-A6)', async () => {
    await store.upsert([
      {
        anchor: 'soft-widget',
        kind: 'lesson',
        status: 'active',
        title: 'Widget changelog',
        summary: 'Widget release notes',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'soft_clue', source: 'CHANGELOG.md' },
      },
      {
        anchor: 'auth-widget',
        kind: 'plan',
        status: 'active',
        title: 'Widget architecture',
        summary: 'Widget design document',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'authoritative', source: 'docs/widget.md' },
      },
    ]);

    const results = await store.search('widget');
    assert.ok(results.length >= 2, 'should find both widget docs');
    // Authoritative should rank first when BM25 scores are similar
    assert.equal(results[0].provenance?.tier, 'authoritative', 'authoritative should rank first');
  });

  it('NULL provenance does not sort above authoritative (P1-2 fix)', async () => {
    // Pre-V10 data has NULL provenance. Authoritative must still rank above NULL.
    await store.upsert([
      {
        anchor: 'old-gadget',
        kind: 'plan',
        status: 'active',
        title: 'Gadget legacy doc',
        summary: 'Old gadget documentation without provenance',
        updatedAt: new Date().toISOString(),
        // No provenance — simulates pre-V10 data
      },
      {
        anchor: 'auth-gadget',
        kind: 'plan',
        status: 'active',
        title: 'Gadget architecture',
        summary: 'Authoritative gadget design document',
        updatedAt: new Date().toISOString(),
        provenance: { tier: 'authoritative', source: 'docs/gadget.md' },
      },
    ]);

    const results = await store.search('gadget');
    assert.ok(results.length >= 2, 'should find both gadget docs');
    // NULL provenance must NOT rank above authoritative
    const authIdx = results.findIndex((r) => r.provenance?.tier === 'authoritative');
    const nullIdx = results.findIndex((r) => !r.provenance);
    assert.ok(authIdx < nullIdx, 'authoritative must rank before NULL provenance');
  });

  it('rebuild backfills provenance for existing docs with same hash (P1-2 fix)', async () => {
    const { createHash } = await import('node:crypto');
    // Create a temp dir with README.md — scanner will discover it as anchor 'doc:README'
    const bfDir = join(tmpdir(), `f152-backfill-${randomUUID().slice(0, 8)}`);
    mkdirSync(bfDir, { recursive: true });
    const readmeContent = '# Backfill test doc\n\nContent.';
    writeFileSync(join(bfDir, 'README.md'), readmeContent);

    // Compute the same hash the scanner would generate
    const expectedHash = createHash('sha256').update(readmeContent).digest('hex').slice(0, 16);

    // Pre-insert the SAME anchor with matching hash but NO provenance (simulates pre-V10 data)
    await store.upsert([
      {
        anchor: 'doc:README',
        kind: 'plan',
        status: 'active',
        title: 'Backfill test doc',
        sourceHash: expectedHash,
        updatedAt: new Date().toISOString(),
        sourcePath: 'README.md',
        // No provenance — simulates pre-V10 data
      },
    ]);
    const before = await store.getByAnchor('doc:README');
    assert.equal(before?.provenance, undefined, 'should start without provenance');

    // Rebuild — same hash, but scanner provides provenance → should backfill
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const bfBuilder = new IndexBuilder(store, bfDir);
    await bfBuilder.rebuild();

    const after = await store.getByAnchor('doc:README');
    assert.ok(after, 'should find README after rebuild');
    assert.ok(after.provenance, 'provenance should be backfilled for same-hash doc');
    assert.equal(after.provenance.tier, 'authoritative', 'README should be authoritative');
  });

  it('rebuild auto-skips soft clues for large repos (P2-4 fix)', async () => {
    // Create a "large" repo with >200 top-level entries + a CHANGELOG
    const largeDir = join(tmpdir(), `f152-large-${randomUUID().slice(0, 8)}`);
    mkdirSync(largeDir, { recursive: true });
    writeFileSync(join(largeDir, 'package.json'), '{"name":"large-repo"}');
    writeFileSync(join(largeDir, 'README.md'), '# Large Repo');
    writeFileSync(join(largeDir, 'CHANGELOG.md'), '# Changelog\n\n## v1.0\nInitial release.');
    // Create 201 dummy files to trigger the threshold
    for (let i = 0; i < 201; i++) {
      writeFileSync(join(largeDir, `file-${i}.txt`), `dummy ${i}`);
    }

    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const largeStore = new SqliteEvidenceStore(':memory:');
    await largeStore.initialize();
    const builder = new IndexBuilder(largeStore, largeDir);
    await builder.rebuild();

    // CHANGELOG.md should NOT be indexed because skipSoftClues was auto-enabled
    const all = await largeStore.search('Changelog', { limit: 20 });
    const softClues = all.filter((r) => r.provenance?.tier === 'soft_clue');
    assert.equal(softClues.length, 0, 'large repo should auto-skip soft clues');

    // But README should still be indexed
    const readmeResults = await largeStore.search('Large Repo', { limit: 5 });
    assert.ok(readmeResults.length > 0, 'README should still be indexed');
    largeStore.close();
  });

  it('upsert without provenance keeps null (backward compat)', async () => {
    await store.upsert([
      {
        anchor: 'no-prov',
        kind: 'plan',
        status: 'active',
        title: 'No provenance',
        updatedAt: new Date().toISOString(),
      },
    ]);
    const item = await store.getByAnchor('no-prov');
    assert.ok(item);
    assert.equal(item.provenance, undefined);
  });
});

// ── Indexing version auto-rebuild ─────────────────────────────────────
describe('IndexBuilder indexing version auto-rebuild', () => {
  let tmpDir;
  let docsDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-ver-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-indexes unchanged files when INDEXING_VERSION increases', async () => {
    const { IndexBuilder, INDEXING_VERSION } = await import('../../dist/domains/memory/IndexBuilder.js');

    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test Feature

## Section Alpha
Content here.
`,
    );

    const builder = new IndexBuilder(store, docsDir);

    // First rebuild — indexes file and stores version
    const r1 = await builder.rebuild();
    assert.equal(r1.docsIndexed, 1);

    // Second rebuild — file unchanged, should skip
    const r2 = await builder.rebuild();
    assert.equal(r2.docsSkipped, 1, 'same version + same hash → skip');

    // Simulate version bump by writing a lower version into embedding_meta
    const db = store.getDb();
    db.prepare("INSERT OR REPLACE INTO embedding_meta (key, value) VALUES ('indexing_version', ?)").run(
      String(INDEXING_VERSION - 1),
    );

    // Third rebuild — version mismatch should force re-index
    const r3 = await builder.rebuild();
    assert.equal(r3.docsIndexed, 1, 'version mismatch → force re-index despite same hash');
  });

  it('stores INDEXING_VERSION after successful rebuild', async () => {
    const { IndexBuilder, INDEXING_VERSION } = await import('../../dist/domains/memory/IndexBuilder.js');

    writeFileSync(
      join(docsDir, 'features', 'F001.md'),
      `---
feature_ids: [F001]
doc_kind: spec
---

# F001: Test
`,
    );

    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const db = store.getDb();
    const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'indexing_version'").get();
    assert.ok(row, 'indexing_version should be stored in embedding_meta');
    assert.equal(row.value, String(INDEXING_VERSION), 'stored version should match current INDEXING_VERSION');
  });
});
