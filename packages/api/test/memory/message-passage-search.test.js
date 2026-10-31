import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('message-unit passage retrieval', () => {
  let store;
  const allowed = ['original', 'retelling'];
  const options = { visibleThreadIds: allowed, mode: 'lexical', sort: 'time', candidateLimit: 20 };

  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert(
      ['original', 'retelling', 'private'].map((id) => ({
        anchor: `thread-${id}`,
        kind: 'thread',
        status: 'active',
        title: 'Same title is not a message identity',
        summary: id === 'retelling' ? 'piano piano piano piano' : 'Unrelated summary',
        updatedAt: '2026-10-02T00:00:00Z',
      })),
    );
    const insert = store
      .getDb()
      .prepare(
        'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
    for (const [thread, id, content, timestamp] of [
      ['original', 'first', 'piano navigation', '2026-09-01T00:00:00.000Z'],
      ['original', 'again', 'piano navigation', '2026-09-02T00:00:00.000Z'],
      ['retelling', 'current-question', 'piano navigation', '2026-10-01T00:00:00.000Z'],
      ['retelling', 'retold', 'piano navigation', '2026-09-03T00:00:00.000Z'],
      ['private', 'secret', 'piano navigation', '2026-08-01T00:00:00.000Z'],
    ])
      insert.run(`thread-${thread}`, `msg-${id}`, content, 'codex61-sol', 0, timestamp);
    insert.run('thread-original', 'transcript-anonymous', 'piano navigation', null, 1, '2026-08-01T00:00:00Z');
  });

  afterEach(() => store.close());

  it('keeps multiple message hits in one conversation and sorts before candidate limiting', async () => {
    const result = await store.searchMessagePassages('piano', { ...options, candidateLimit: 2 });
    assert.deepEqual(
      result.passages.map((p) => [p.threadId, p.messageId]),
      [
        ['original', 'first'],
        ['original', 'again'],
      ],
    );
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.sort, 'time');
  });

  it('excludes only the exact source and keeps old messages with identical content', async () => {
    const result = await store.searchMessagePassages('piano', {
      ...options,
      excludeSource: { threadId: 'retelling', messageId: 'current-question' },
    });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['first', 'again', 'retold'],
    );
  });

  it('applies allowed threads and exact thread scope before limiting', async () => {
    const result = await store.searchMessagePassages('piano', { ...options, threadId: 'retelling', candidateLimit: 1 });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['retold'],
    );
    const denied = await store.searchMessagePassages('piano', { ...options, threadId: 'private' });
    assert.deepEqual(denied.passages, []);
    const noGrant = await store.searchMessagePassages('piano', { ...options, visibleThreadIds: [] });
    assert.deepEqual(noGrant.passages, []);
  });

  it('has deterministic message ID ties without collapsing equal titles or bodies', async () => {
    store.getDb().prepare('UPDATE evidence_passages SET created_at = ?').run('2026-09-01T00:00:00.000Z');
    const result = await store.searchMessagePassages('piano', options);
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['again', 'first', 'current-question', 'retold'],
    );
  });

  it('dates filter message times rather than the parent summary update time', async () => {
    const result = await store.searchMessagePassages('piano', { ...options, dateTo: '2026-09-02' });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['first', 'again'],
    );
  });

  it('treats ISO offsets and UTC representations of the same instant as inclusive boundaries', async () => {
    for (const boundary of ['2026-09-01T02:00:00+02:00', '2026-09-01T00:00:00Z']) {
      const result = await store.searchMessagePassages('piano', {
        ...options,
        dateFrom: boundary,
        dateTo: boundary,
      });
      assert.deepEqual(
        result.passages.map((p) => p.messageId),
        ['first'],
        boundary,
      );
    }
  });

  it('treats thread and source coordinates as data, never SQL', async () => {
    const result = await store.searchMessagePassages('piano', {
      ...options,
      threadId: "original' OR 1=1 --",
    });
    assert.deepEqual(result.passages, []);
    const source = await store.searchMessagePassages('piano', {
      ...options,
      excludeSource: { threadId: 'original', messageId: "first' OR 1=1 --" },
    });
    assert.equal(source.passages.length, 4);
  });

  it('merges Chinese substrings before time limiting, with the same scope and exact-source filters', async () => {
    const db = store.getDb();
    db.prepare('UPDATE evidence_passages SET content=? WHERE passage_id=?').run(
      '最初讨论琴键导航如何保住阅读位置。',
      'msg-first',
    );
    db.prepare('UPDATE evidence_passages SET content=? WHERE passage_id=?').run('琴键 导航', 'msg-again');
    db.prepare('UPDATE evidence_passages SET content=? WHERE passage_id=?').run('更早的琴键讨论。', 'msg-secret');
    const result = await store.searchMessagePassages('琴键', { ...options, candidateLimit: 1 });
    assert.deepEqual(
      result.passages.map((hit) => hit.messageId),
      ['first'],
    );
    assert.equal(result.meta.truncated, true);
    const excluded = await store.searchMessagePassages('琴键', {
      ...options,
      threadId: 'original',
      excludeSource: { threadId: 'original', messageId: 'first' },
    });
    assert.deepEqual(
      excluded.passages.map((hit) => hit.messageId),
      ['again'],
    );
    assert.deepEqual((await store.searchMessagePassages('琴键%_', options)).passages, [], 'wildcards are literal data');
  });

  it('reports unavailable vectors and unknown source coverage without calling indexed hits exhaustive', async () => {
    const result = await store.searchMessagePassages('piano', { ...options, mode: 'hybrid' });
    assert.equal(result.meta.effectiveMode, 'lexical');
    assert.equal(result.meta.degraded, true);
    assert.equal(result.meta.degradeReason, 'passage_embedding_unavailable');
    assert.equal(result.meta.sourceCoverage, 'unknown');
    assert.equal(result.meta.freshness, 'unknown');
    assert.equal(result.passages.length, 4);
  });
});
