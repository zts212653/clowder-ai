import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { createSummaryCompactionTask } from '../../dist/domains/memory/SummaryCompactionTask.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function setupDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  // Insert a thread in evidence_docs
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('thread-t1', 'thread', 'active', 'Test Thread', 'concat summary', new Date().toISOString());
  return db;
}

function seedState(db, overrides = {}) {
  const defaults = {
    thread_id: 't1',
    last_summarized_message_id: 'msg-050',
    pending_message_count: 25,
    pending_token_count: 2000,
    pending_signal_flags: 0,
    carry_over: 0,
    summary_type: 'concat',
    last_abstractive_at: null,
    abstractive_token_count: null,
  };
  const state = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO summary_state
     (thread_id, last_summarized_message_id, pending_message_count,
      pending_token_count, pending_signal_flags, carry_over, summary_type,
      last_abstractive_at, abstractive_token_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    state.thread_id,
    state.last_summarized_message_id,
    state.pending_message_count,
    state.pending_token_count,
    state.pending_signal_flags,
    state.carry_over,
    state.summary_type,
    state.last_abstractive_at,
    state.abstractive_token_count,
  );
  return state;
}

function makeDeps(db, overrides = {}) {
  const logs = [];
  return {
    db,
    enabled: () => true,
    getThreadLastActivity: async (threadId) => ({
      threadId,
      lastMessageAt: Date.now() - 15 * 60 * 1000, // 15 min ago (quiet window ok)
    }),
    getMessagesAfterWatermark: async (_threadId, afterMessageId) => {
      // Watermark-aware mock: return messages only if watermark is before them
      if (afterMessageId === 'msg-070') return []; // already caught up
      return [
        { id: 'msg-051', content: 'First new message', catId: 'opus', timestamp: Date.now() - 10000 },
        { id: 'msg-070', content: 'Last new message', catId: 'user', timestamp: Date.now() },
      ];
    },
    generateAbstractive: async () => ({
      segments: [
        {
          summary: 'Discussed Phase G architecture and LSM compaction',
          topicKey: 'f102-phase-g',
          topicLabel: 'Phase G Architecture',
          boundaryReason: 'single topic batch',
          boundaryConfidence: 'high',
          fromMessageId: 'msg-051',
          toMessageId: 'msg-070',
          messageCount: 20,
          candidates: [{ kind: 'decision', title: 'Use thread-level summaries' }],
        },
      ],
    }),
    logger: {
      info: (msg) => logs.push(msg),
      error: (msg, err) => logs.push(`ERROR: ${msg} ${err}`),
    },
    _logs: logs,
    ...overrides,
  };
}

describe('SummaryCompactionTask', () => {
  let db;

  beforeEach(() => {
    db = setupDb();
  });

  it('creates a valid ScheduledTask', () => {
    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    assert.equal(task.name, 'summary-compaction');
    assert.equal(typeof task.intervalMs, 'number');
    assert.equal(typeof task.enabled, 'function');
    assert.equal(typeof task.execute, 'function');
  });

  it('processes eligible thread and writes segment + updates watermark', async () => {
    seedState(db);
    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    // Verify segment was inserted
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('t1');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].level, 1);
    assert.equal(segments[0].topic_key, 'f102-phase-g');
    assert.equal(segments[0].boundary_confidence, 'high');
    assert.ok(segments[0].candidates);

    // Verify summary_state was updated
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('t1');
    assert.equal(state.pending_message_count, 0);
    assert.equal(state.summary_type, 'abstractive');
    assert.equal(state.last_summarized_message_id, 'msg-070');

    // Verify evidence_docs summary was updated
    const doc = db.prepare('SELECT summary FROM evidence_docs WHERE anchor = ?').get('thread-t1');
    assert.ok(doc.summary.includes('Phase G architecture'));
  });

  it('skips thread when quiet window not met', async () => {
    seedState(db);
    const deps = makeDeps(db, {
      getThreadLastActivity: async (threadId) => ({
        threadId,
        lastMessageAt: Date.now() - 2 * 60 * 1000, // only 2 min ago
      }),
    });
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    // No segments should be created
    const segments = db.prepare('SELECT * FROM summary_segments').all();
    assert.equal(segments.length, 0);
  });

  it('skips thread when pending count below threshold and no signal', async () => {
    seedState(db, { pending_message_count: 5, pending_token_count: 200, pending_signal_flags: 0 });
    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    const segments = db.prepare('SELECT * FROM summary_segments').all();
    assert.equal(segments.length, 0);
  });

  it('processes thread with high-signal even if count below threshold', async () => {
    seedState(db, { pending_message_count: 5, pending_token_count: 200, pending_signal_flags: 1 }); // DECISION flag
    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    const segments = db.prepare('SELECT * FROM summary_segments').all();
    assert.equal(segments.length, 1);
  });

  it('respects cooldown unless high-signal', async () => {
    // Last abstractive was 30 min ago (< 2h cooldown)
    seedState(db, {
      last_abstractive_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      pending_signal_flags: 0,
    });
    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    const segments = db.prepare('SELECT * FROM summary_segments').all();
    assert.equal(segments.length, 0, 'should skip: cooldown not met');

    // But with high-signal, cooldown is bypassed
    db.prepare('DELETE FROM summary_state').run();
    seedState(db, {
      last_abstractive_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      pending_signal_flags: 1, // DECISION
    });
    await task.execute();

    const segments2 = db.prepare('SELECT * FROM summary_segments').all();
    assert.equal(segments2.length, 1, 'should process: high-signal bypasses cooldown');
  });

  it('handles Opus API returning null (fail-open)', async () => {
    seedState(db);
    const deps = makeDeps(db, { generateAbstractive: async () => null });
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    // State should be unchanged (no reset)
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('t1');
    assert.equal(state.pending_message_count, 25, 'pending count not reset on API failure');
  });

  it('respects perTickBudget', async () => {
    // Seed 10 threads
    for (let i = 1; i <= 10; i++) {
      const tid = `t${i}`;
      db.prepare(
        `INSERT OR IGNORE INTO evidence_docs (anchor, kind, status, title, summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`thread-${tid}`, 'thread', 'active', `Thread ${i}`, 'concat', new Date().toISOString());
      seedState(db, { thread_id: tid });
    }
    let callCount = 0;
    const deps = makeDeps(db, {
      generateAbstractive: async () => {
        callCount++;
        return {
          segments: [
            {
              summary: `Summary ${callCount}`,
              topicKey: 'topic',
              topicLabel: 'Topic',
              boundaryReason: 'test',
              boundaryConfidence: 'high',
              fromMessageId: 'msg-051',
              toMessageId: 'msg-070',
              messageCount: 20,
            },
          ],
        };
      },
    });
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    // Should process at most perTickBudget (5)
    assert.ok(callCount <= 5, `expected <= 5 API calls, got ${callCount}`);
  });

  it('handles multi-segment response', async () => {
    seedState(db);
    const deps = makeDeps(db, {
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Topic A discussion',
            topicKey: 'topic-a',
            topicLabel: 'Topic A',
            boundaryReason: 'topic shift',
            boundaryConfidence: 'high',
            fromMessageId: 'msg-051',
            toMessageId: 'msg-060',
            messageCount: 10,
          },
          {
            summary: 'Topic B discussion',
            topicKey: 'topic-b',
            topicLabel: 'Topic B',
            boundaryReason: 'topic shift',
            boundaryConfidence: 'medium',
            fromMessageId: 'msg-061',
            toMessageId: 'msg-070',
            messageCount: 10,
          },
        ],
      }),
    });
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    const segments = db
      .prepare('SELECT * FROM summary_segments WHERE thread_id = ? ORDER BY from_message_id')
      .all('t1');
    assert.equal(segments.length, 2);
    assert.equal(segments[0].topic_key, 'topic-a');
    assert.equal(segments[1].topic_key, 'topic-b');

    // evidence_docs.summary should be merged
    const doc = db.prepare('SELECT summary FROM evidence_docs WHERE anchor = ?').get('thread-t1');
    assert.ok(doc.summary.includes('Topic A'));
    assert.ok(doc.summary.includes('Topic B'));
  });

  it('carry-over backlog bypasses cooldown', async () => {
    // Simulate: thread was just compacted (last_abstractive_at = now) but has carry-over backlog
    seedState(db, {
      last_abstractive_at: new Date().toISOString(), // just now = cooldown would block
      pending_signal_flags: 0, // no high-signal
      carry_over: 1, // but has carry-over from previous batch
    });

    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    // Should process despite cooldown, because carry_over=1
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('t1');
    assert.equal(segments.length, 1, 'carry-over should bypass cooldown');
  });

  it('carry-over tail below volume threshold still processes', async () => {
    // Simulate: 205-message batch, first 200 processed, 5 remaining with carry_over=1
    seedState(db, {
      pending_message_count: 5, // below threshold (20)
      pending_token_count: 200, // below threshold (1500)
      pending_signal_flags: 0, // no high-signal
      carry_over: 1, // but carry-over from previous batch
      last_abstractive_at: new Date().toISOString(), // just compacted (cooldown would block)
    });

    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    // Should process: carry_over bypasses both volume AND cooldown
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('t1');
    assert.equal(segments.length, 1, 'carry-over tail should bypass volume + cooldown');
  });

  it('carry-over is cleared after backlog is drained', async () => {
    seedState(db, { carry_over: 1 });
    const deps = makeDeps(db);
    const task = createSummaryCompactionTask(deps);
    await task.execute();

    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('t1');
    assert.equal(state.carry_over, 0, 'carry_over should be cleared when no more backlog');
  });
});
