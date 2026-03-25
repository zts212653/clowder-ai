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
});
