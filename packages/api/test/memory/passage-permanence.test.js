/**
 * F102 Phase I — Passage Permanence Regression Test (AC-I6)
 *
 * End-to-end test validating the full permanence guarantee:
 * Redis messages can expire, but passages persist via no-delete + JSONL backfill.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('passage permanence (Phase I regression)', () => {
  let tmpDir;
  let docsDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-perm-${randomUUID().slice(0, 8)}`);
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

  it('rebuild recovers passages from JSONL when Redis messages expired', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const threadId = 'thread_e2e_perm';
    const catId = 'opus';
    const sessionId = 'sess_e2e';

    const mockThreads = [
      {
        id: threadId,
        title: 'E2E permanence test',
        participants: ['opus', 'user'],
        threadMemory: { summary: 'End-to-end permanence verification.' },
        lastActiveAt: Date.now(),
      },
    ];

    // 5 Redis messages
    const allMessages = [
      {
        id: 'e2e_001',
        content: 'User asked about Redis config',
        catId: undefined,
        threadId,
        timestamp: Date.now() - 5000,
      },
      {
        id: 'e2e_002',
        content: 'Opus explained keyPrefix behavior',
        catId: 'opus',
        threadId,
        timestamp: Date.now() - 4000,
      },
      {
        id: 'e2e_003',
        content: 'User confirmed understanding',
        catId: undefined,
        threadId,
        timestamp: Date.now() - 3000,
      },
      {
        id: 'e2e_004',
        content: 'Opus documented the lesson learned',
        catId: 'opus',
        threadId,
        timestamp: Date.now() - 2000,
      },
      {
        id: 'e2e_005',
        content: 'User thanked and closed thread',
        catId: undefined,
        threadId,
        timestamp: Date.now() - 1000,
      },
    ];

    // Matching JSONL transcript
    const transcriptDir = join(tmpDir, 'transcripts');
    const sessDir = join(transcriptDir, 'threads', threadId, catId, 'sessions', sessionId);
    mkdirSync(sessDir, { recursive: true });

    const events = [
      {
        v: 1,
        t: Date.now() - 4500,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_e2e_1',
        eventNo: 0,
        event: { type: 'text', content: 'keyPrefix does not apply inside eval scripts.' },
      },
      {
        v: 1,
        t: Date.now() - 2500,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_e2e_2',
        eventNo: 1,
        event: { type: 'text', content: 'Documented as lesson: always use KEYS prefix manually in eval.' },
      },
    ];
    writeFileSync(join(sessDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // First rebuild: all 5 messages + transcript
    let currentMessages = allMessages;
    const messageListFn = (tid) => (tid === threadId ? currentMessages : []);

    const builder = new IndexBuilder(store, docsDir, undefined, transcriptDir, () => mockThreads, messageListFn);
    await builder.rebuild();

    const db = store.getDb();
    const passagesAfterFirst = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ?')
      .all(`thread-${threadId}`);
    // 5 from Redis + 2 from JSONL = 7 passages
    assert.equal(passagesAfterFirst.length, 7, 'first rebuild: 5 Redis + 2 JSONL = 7 passages');

    // Simulate all Redis messages expired
    currentMessages = [];
    await builder.rebuild();

    const passagesAfterExpiry = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ?')
      .all(`thread-${threadId}`);
    assert.equal(passagesAfterExpiry.length, 7, 'after Redis expiry: all 7 passages still exist');

    // Verify Redis-sourced passages survive
    const redisPassages = passagesAfterExpiry.filter((p) => p.passage_id.startsWith('msg-'));
    assert.equal(redisPassages.length, 5, 'all 5 Redis-sourced passages persist');

    // Verify transcript-sourced passages survive
    const transcriptPassages = passagesAfterExpiry.filter((p) => p.passage_id.startsWith('transcript-'));
    assert.equal(transcriptPassages.length, 2, 'both transcript-sourced passages persist');
  });

  it('P1-fix: backfill skips events with missing t field without throwing', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const threadId = 'thread_no_t';
    const catId = 'opus';
    const sessionId = 'sess_no_t';

    const transcriptDir = join(tmpDir, 'transcripts');
    const sessDir = join(transcriptDir, 'threads', threadId, catId, 'sessions', sessionId);
    mkdirSync(sessDir, { recursive: true });

    const events = [
      {
        v: 1,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_bad',
        eventNo: 0,
        event: { type: 'text', content: 'Missing timestamp' },
      },
      {
        v: 1,
        t: Date.now() - 1000,
        threadId,
        catId,
        sessionId,
        invocationId: 'inv_good',
        eventNo: 1,
        event: { type: 'text', content: 'Valid event after bad one' },
      },
    ];
    writeFileSync(join(sessDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const builder = new IndexBuilder(store, docsDir, undefined, transcriptDir);

    // Must not throw
    const added = await builder.backfillPassagesFromTranscript(threadId);
    // Valid event should be inserted; bad one skipped
    assert.equal(added, 1, 'should skip event with missing t and insert valid one');

    const db = store.getDb();
    const passages = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all(`thread-${threadId}`);
    assert.equal(passages.length, 1);
    assert.equal(passages[0].passage_id, 'transcript-inv_good');
  });

  it('searchPassages returns createdAt and passageId fields (AC-I7)', () => {
    const db = store.getDb();
    db.exec(
      "INSERT INTO evidence_docs (anchor, kind, status, title, updated_at) VALUES ('thread-i7', 'session', 'active', 'AC-I7 test', '2026-03-31')",
    );
    db.exec(
      "INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES ('thread-i7', 'msg-i7-001', 'Redis config discussion for testing', 'user', 0, '2026-03-31T10:00:00Z')",
    );
    db.exec('INSERT INTO passage_fts(rowid, content) SELECT rowid, content FROM evidence_passages');

    const results = store.searchPassages('Redis config');
    assert.ok(results.length >= 1, 'should find at least one passage');
    assert.equal(results[0].passageId, 'msg-i7-001');
    assert.equal(results[0].createdAt, '2026-03-31T10:00:00Z');
  });

  it('searchPassages returns context window around match (AC-I8)', () => {
    const db = store.getDb();
    db.exec(
      "INSERT INTO evidence_docs (anchor, kind, status, title, updated_at) VALUES ('thread-ctx', 'session', 'active', 'Context test', '2026-03-31')",
    );

    const passages = [
      ['msg-a', 'Hello how are you', 'user', 0, '2026-03-31T10:00:00Z'],
      ['msg-b', 'Fine thanks', 'opus', 1, '2026-03-31T10:01:00Z'],
      ['msg-c', 'Tell me about Redis caching strategies', 'user', 2, '2026-03-31T10:02:00Z'],
      ['msg-d', 'Redis caching strategies include write-through', 'opus', 3, '2026-03-31T10:03:00Z'],
      ['msg-e', 'Thanks that helps a lot', 'user', 4, '2026-03-31T10:04:00Z'],
    ];
    const stmt = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const p of passages) stmt.run('thread-ctx', ...p);
    db.exec('INSERT INTO passage_fts(rowid, content) SELECT rowid, content FROM evidence_passages');

    const results = store.searchPassages('Redis caching', 10, undefined, { contextWindow: 1 });
    assert.ok(results.length >= 1, 'should find at least one match');
    const match = results[0];
    assert.ok(match.context, 'context should be present');
    assert.ok(match.context.length >= 1, 'should have at least one adjacent passage');
    // Context passages should be within ±1 position of the match
    for (const ctx of match.context) {
      assert.ok(
        Math.abs(ctx.position - match.position) <= 1,
        `context passage at position ${ctx.position} should be within ±1 of match at ${match.position}`,
      );
    }
  });

  it('search with depth=raw returns structured passages (AC-I9)', async () => {
    const db = store.getDb();
    db.exec(
      "INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at) VALUES ('thread-raw', 'session', 'active', 'Raw depth test', 'A thread about Redis', '2026-03-31')",
    );
    const stmt = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmt.run('thread-raw', 'msg-r1', 'Redis pipeline optimization strategies', 'user', 0, '2026-03-31T11:00:00Z');
    stmt.run('thread-raw', 'msg-r2', 'Pipeline batching reduces round trips', 'opus', 1, '2026-03-31T11:01:00Z');
    db.exec(
      "INSERT INTO passage_fts(rowid, content) SELECT rowid, content FROM evidence_passages WHERE doc_anchor = 'thread-raw'",
    );
    // Also sync evidence_fts for the doc
    db.exec(
      "INSERT INTO evidence_fts(rowid, title, summary) SELECT rowid, title, summary FROM evidence_docs WHERE anchor = 'thread-raw'",
    );

    const results = await store.search('Redis pipeline', { depth: 'raw', scope: 'threads', limit: 5 });
    assert.ok(results.length >= 1, 'should find results');
    const hit = results.find((r) => r.anchor === 'thread-raw');
    assert.ok(hit, 'should find thread-raw');
    assert.ok(hit.passages, 'should have passages array');
    assert.ok(hit.passages.length >= 1, 'should have at least one passage');
    assert.equal(hit.passages[0].passageId, 'msg-r1');
    assert.equal(hit.passages[0].speaker, 'user');
    assert.equal(hit.passages[0].createdAt, '2026-03-31T11:00:00Z');
  });

  it('P1-fix: search(depth=raw, contextWindow) returns passages with context (AC-I8/I9 E2E)', async () => {
    const db = store.getDb();
    db.exec(
      "INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at) VALUES ('thread-e2e', 'session', 'active', 'E2E context test', 'context window e2e', '2026-03-31')",
    );
    const stmt = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmt.run('thread-e2e', 'msg-e1', 'Hello how are you', 'user', 0, '2026-03-31T12:00:00Z');
    stmt.run('thread-e2e', 'msg-e2', 'Redis caching architecture overview', 'opus', 1, '2026-03-31T12:01:00Z');
    stmt.run('thread-e2e', 'msg-e3', 'Thanks for the explanation', 'user', 2, '2026-03-31T12:02:00Z');
    db.exec(
      "INSERT INTO passage_fts(rowid, content) SELECT rowid, content FROM evidence_passages WHERE doc_anchor = 'thread-e2e'",
    );
    db.exec(
      "INSERT INTO evidence_fts(rowid, title, summary) SELECT rowid, title, summary FROM evidence_docs WHERE anchor = 'thread-e2e'",
    );

    // search() with contextWindow should return passages with context array
    const results = await store.search('Redis caching', {
      depth: 'raw',
      scope: 'threads',
      limit: 5,
      contextWindow: 1,
    });
    assert.ok(results.length >= 1, 'should find results');
    const hit = results.find((r) => r.anchor === 'thread-e2e');
    assert.ok(hit, 'should find thread-e2e');
    assert.ok(hit.passages, 'should have passages');
    const match = hit.passages.find((p) => p.passageId === 'msg-e2');
    assert.ok(match, 'should find the matching passage');
    assert.ok(match.context, 'passage should have context array');
    assert.ok(match.context.length >= 1, 'context should have at least one adjacent passage');
  });

  it('hot path passage insertion is under 5ms', async () => {
    const db = store.getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      stmt.run(`thread-bench`, `msg-bench-${i}`, `Benchmark message ${i}`, 'opus', i, new Date().toISOString());
    }
    const elapsed = performance.now() - start;
    const perMessage = elapsed / iterations;

    assert.ok(perMessage < 5, `per-message insertion should be under 5ms, got ${perMessage.toFixed(2)}ms`);
  });
});
