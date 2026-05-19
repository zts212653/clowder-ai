import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('flushDirtyThreads passage indexing (clowder-ai#652)', () => {
  let tmpDir;
  let docsDir;
  let store;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-flush-pass-${randomUUID().slice(0, 8)}`);
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

  it('flushDirtyThreads indexes new messages into evidence_passages', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const uniqueKeyword = `decision-${randomUUID().slice(0, 8)}`;
    const mockMessages = [
      {
        id: 'msg_flush_001',
        content: 'We should use Redis Streams for event sourcing.',
        catId: 'opus',
        threadId: 'thread_flush1',
        timestamp: Date.now() - 3000,
      },
      {
        id: 'msg_flush_002',
        content: `Agreed, ${uniqueKeyword} is confirmed.`,
        catId: 'codex',
        threadId: 'thread_flush1',
        timestamp: Date.now() - 2000,
      },
      {
        id: 'msg_flush_003',
        content: 'Documenting this as a decision.',
        catId: 'opus',
        threadId: 'thread_flush1',
        timestamp: Date.now(),
      },
    ];

    const mockThreads = [
      {
        id: 'thread_flush1',
        title: 'Architecture decisions',
        participants: ['opus', 'codex'],
        threadMemory: { summary: 'Discussed event sourcing approach.' },
        lastActiveAt: Date.now(),
      },
    ];

    const messageListFn = (threadId) => {
      if (threadId === 'thread_flush1') return mockMessages;
      return [];
    };

    const builder = new IndexBuilder(store, docsDir, undefined, undefined, () => mockThreads, messageListFn);

    // Initial rebuild — should index passages
    await builder.rebuild();
    const db = store.getDb();
    const passagesBefore = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ?')
      .all('thread-thread_flush1');
    assert.equal(passagesBefore.length, 3, 'rebuild should index 3 passages');

    // Now simulate a new message arriving (without full rebuild)
    mockMessages.push({
      id: 'msg_flush_004',
      content: `New late-arriving message with ${uniqueKeyword} reference.`,
      catId: 'user',
      threadId: 'thread_flush1',
      timestamp: Date.now() + 1000,
    });

    // Mark dirty and flush — this should ALSO index the new passage
    builder.markThreadDirty('thread_flush1');
    await builder.flushDirtyThreads();

    const passagesAfter = db
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ?')
      .all('thread-thread_flush1');
    assert.equal(passagesAfter.length, 4, 'flushDirtyThreads should index new message as passage');

    // Verify the new message is actually in passages
    const newPassage = db.prepare('SELECT * FROM evidence_passages WHERE passage_id = ?').get('msg-msg_flush_004');
    assert.ok(newPassage, 'new message should exist in evidence_passages after flush');
    assert.equal(newPassage.speaker, 'user');
    assert.ok(newPassage.content.includes(uniqueKeyword));
  });

  it('flushDirtyThreads passage indexing is searchable via store.searchPassages', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const mockThreads = [
      {
        id: 'thread_fts1',
        title: 'Test thread',
        participants: ['opus'],
        threadMemory: { summary: 'General discussion.' },
        lastActiveAt: Date.now(),
      },
    ];

    let messages = [
      {
        id: 'msg_early',
        content: 'Initial setup conversation about widgets.',
        catId: 'opus',
        threadId: 'thread_fts1',
        timestamp: Date.now() - 5000,
      },
    ];

    const builder = new IndexBuilder(
      store,
      docsDir,
      undefined,
      undefined,
      () => mockThreads,
      () => messages,
    );

    await builder.rebuild();

    // Add a new message with a unique term — only discoverable via passages
    messages = [
      ...messages,
      {
        id: 'msg_new_decision',
        content: 'We decided to use the frobnicator pattern for this module.',
        catId: 'codex',
        threadId: 'thread_fts1',
        timestamp: Date.now(),
      },
    ];

    builder.markThreadDirty('thread_fts1');
    await builder.flushDirtyThreads();

    // Search via store.searchPassages (uses passage_fts internally)
    const results = store.searchPassages('frobnicator');
    assert.ok(results.length >= 1, 'searchPassages should find the new passage after flush');
    assert.equal(results[0].docAnchor, 'thread-thread_fts1');
    assert.equal(results[0].speaker, 'codex');
  });
});
