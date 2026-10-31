import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { parseCursor } from '../../src/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { overviewRevision } from '../../src/domains/memory/curation/LunaCurationState.js';
import { ThreadOverviewBackfill } from '../../src/domains/memory/curation/ThreadOverviewBackfill.js';
import { ThreadOverviewRepository } from '../../src/domains/memory/curation/ThreadOverviewRepository.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

function fixture() {
  const db = new Database(':memory:');
  applyMigrations(db);
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const t = threads.create('owner', 'Old idea');
  const rows = Array.from({ length: 201 }, (_, i) =>
    messages.append({ threadId: t.id, userId: 'owner', catId: null, content: `turn ${i}`, timestamp: i }),
  );
  const repo = new ThreadOverviewRepository({ db, ownerUserId: 'owner', threadStore: threads, messageStore: messages });
  return { db, threads, messages, t, rows, repo };
}
function result(threadId: string, ids: string[]) {
  const summary = `History （来源：${threadId}#${ids[0]}）`;
  return {
    segments: [
      {
        summary,
        topicKey: 'thread-overview',
        topicLabel: 'Idea',
        boundaryReason: 'batch',
        boundaryConfidence: 'high' as const,
        fromMessageId: ids[0],
        toMessageId: ids.at(-1)!,
        messageCount: ids.length,
      },
    ],
    curationState: {
      ownerUserId: 'owner',
      sessionId: 'native',
      providerIdentity: 'luna',
      summaryRevision: overviewRevision(summary),
      directoryLine: 'Idea',
    },
  };
}
test('historical prefix persists and resumes without regressing a newer watermark', async () => {
  const f = fixture();
  try {
    const backfill = new ThreadOverviewBackfill({
      repository: f.repo,
      generate: async (input) => result(input.threadId, [input.messages[0].id]),
    });
    const [state] = await backfill.initialize();
    f.db
      .prepare('INSERT INTO summary_state(thread_id,last_summarized_message_id,pending_message_count) VALUES (?,?,4)')
      .run(f.t.id, f.rows.at(-1)!.id);
    assert.equal(await backfill.process(state), true);
    const [next] = await new ThreadOverviewBackfill({ repository: f.repo, generate: async () => null }).initialize();
    assert.equal(parseCursor(next.cursor)?.id, f.rows[0].id);
    assert.equal(parseCursor(next.target)?.id, f.rows.at(-1)!.id);
    const water = f.db
      .prepare('SELECT last_summarized_message_id AS id,pending_message_count AS n FROM summary_state')
      .get() as { id: string; n: number };
    assert.equal(parseCursor(water.id)?.id, f.rows.at(-1)!.id);
    assert.equal(water.n, 4);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM summary_segments').get() as { n: number }).n, 1);
    assert.equal(await backfill.process(state), false, 'stale cursor cannot commit');
  } finally {
    f.db.close();
  }
});
test('invalid noncontiguous coverage cannot acknowledge a historical tail', async () => {
  const f = fixture();
  try {
    const backfill = new ThreadOverviewBackfill({
      repository: f.repo,
      generate: async (input) => result(input.threadId, [input.messages[1].id]),
    });
    const [s] = await backfill.initialize();
    assert.equal(await backfill.process(s), false);
    assert.equal((await backfill.initialize())[0].cursor, null);
  } finally {
    f.db.close();
  }
});

test('failed historical attempts rotate durably, reach later threads, and remain retryable', async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 4; n++) {
      const thread = f.threads.create('owner', `old ${n}`);
      f.messages.append({ threadId: thread.id, userId: 'owner', catId: null, content: 'history', timestamp: n });
    }
    const failing = new ThreadOverviewBackfill({ repository: f.repo, generate: async () => null });
    const first = await failing.initialize();
    assert.equal(first.length, 3);
    for (const state of first) assert.equal(await failing.process(state), false);
    // A new object uses persisted scheduling state; in-memory offsets cannot satisfy recovery.
    const resumed = new ThreadOverviewBackfill({
      repository: f.repo,
      generate: async (input) =>
        result(
          input.threadId,
          input.messages.map((m) => m.id),
        ),
    });
    const next = await resumed.initialize();
    const newlyReached = next.filter((state) => !first.some((old) => old.threadId === state.threadId));
    assert.equal(newlyReached.length, 2, 'permanent failures must not starve the tail');
    for (const state of newlyReached) assert.equal(await resumed.process(state), true);
    const retried = await resumed.initialize();
    assert.ok(retried.some((state) => first.some((old) => old.threadId === state.threadId)));
    assert.ok(retried.every((state) => !newlyReached.some((done) => done.threadId === state.threadId)));
  } finally {
    f.db.close();
  }
});

test('V64 to V65 rotation migration preserves native session, summary and historical cursor', () => {
  const f = fixture();
  try {
    f.db
      .prepare(`INSERT INTO thread_curation_state(owner_user_id,thread_id,session_id,provider_identity,
      summary_revision,directory_line,backfill_cursor,backfill_target,backfill_complete)
      VALUES ('owner',?,'native','luna','revision','idea','cursor','target',0)`)
      .run(f.t.id);
    f.db.exec(
      'DROP INDEX idx_thread_curation_backfill_rotation; ALTER TABLE thread_curation_state DROP COLUMN backfill_attempt_order',
    );
    f.db.prepare('DELETE FROM schema_version WHERE version>=65').run();
    applyMigrations(f.db);
    applyMigrations(f.db);
    const state = f.db.prepare('SELECT * FROM thread_curation_state').get() as Record<string, unknown>;
    assert.equal(state.session_id, 'native');
    assert.equal(state.summary_revision, 'revision');
    assert.equal(state.backfill_cursor, 'cursor');
    assert.equal(state.backfill_target, 'target');
    assert.equal(state.backfill_complete, 0);
    assert.equal(state.backfill_attempt_order, 0);
  } finally {
    f.db.close();
  }
});
test('source visibility revoked while the model runs leaves cursor and canonical summary untouched', async () => {
  const f = fixture();
  try {
    const backfill = new ThreadOverviewBackfill({
      repository: f.repo,
      generate: async (input) => {
        f.rows[0].visibility = 'whisper';
        return result(input.threadId, [input.messages[0].id]);
      },
    });
    const [s] = await backfill.initialize();
    assert.equal(await backfill.process(s), false);
    assert.equal((await backfill.initialize())[0].cursor, null);
  } finally {
    f.db.close();
  }
});

test('historical material and canonical sources also skip system tails while owner coverage completes', async () => {
  const f = fixture();
  const batches: string[][] = [];
  try {
    const system = f.messages.append({
      threadId: f.t.id,
      userId: 'system',
      catId: 'system',
      content: 'system log',
      timestamp: 202,
    });
    const scheduler = f.messages.append({
      threadId: f.t.id,
      userId: 'scheduler',
      catId: null,
      content: 'scheduler log',
      timestamp: 203,
    });
    const backfill = new ThreadOverviewBackfill({
      repository: f.repo,
      generate: async (input) => {
        batches.push(input.messages.map((m) => m.id));
        return result(
          input.threadId,
          input.messages.map((m) => m.id),
        );
      },
    });
    for (let n = 0; n < 2; n++) {
      const [state] = await backfill.initialize();
      assert.equal(await backfill.process(state), true);
    }
    assert.deepEqual(
      batches.flat(),
      f.rows.map((m) => m.id),
    );
    assert.equal(await f.repo.isSourceReadable(f.t.id, system.id), false);
    assert.equal(await f.repo.isSourceReadable(f.t.id, scheduler.id), false);
    assert.deepEqual(await backfill.initialize(), []);
  } finally {
    f.db.close();
  }
});

test('new threads use normal live compaction immediately while old coverage is still backfilling', async () => {
  const f = fixture();
  try {
    const recent = f.threads.create('owner', 'Recent');
    f.messages.append({
      threadId: recent.id,
      userId: 'owner',
      catId: null,
      timestamp: Date.now(),
      content: 'new idea',
    });
    const backfill = new ThreadOverviewBackfill({
      repository: f.repo,
      generate: async () => null,
      liveSinceMs: () => recent.createdAt,
    });
    const pending = await backfill.initialize();
    assert.ok(!pending.some((s) => s.threadId === recent.id));
    assert.equal(
      (
        f.db
          .prepare('SELECT backfill_complete AS done FROM thread_curation_state WHERE thread_id=?')
          .get(recent.id) as { done: number }
      ).done,
      1,
    );
  } finally {
    f.db.close();
  }
});

test('oversized complete overview capacity slices reconstruct every byte including the tail', async () => {
  const { partitionCompleteOverviews } = await import('../../src/domains/memory/curation/overview-capacity.js');
  const summary = '旧经历'.repeat(60000) + 'TAIL';
  const items = partitionCompleteOverviews([
    {
      reason: 'related',
      overview: {
        threadId: 'old',
        title: 'old',
        summary,
        revision: 'r',
        directoryLine: 'old',
        sources: [{ threadId: 'old', messageId: 's' }],
        legacy: true,
      },
    },
  ]);
  assert.ok(items.length > 1);
  assert.equal(items.map((i) => i.overview.summary).join(''), summary);
  assert.ok(items.every((i) => i.overview.sources[0].messageId === 's'));
});

test('an unreadable page cannot advance its historical cursor across a newly prepared suppression fence', async () => {
  const f = fixture();
  try {
    for (const row of f.rows) row.visibility = 'whisper';
    const original = f.repo.deps.messageStore.getByThreadAfter.bind(f.repo.deps.messageStore);
    f.repo.deps.messageStore.getByThreadAfter = async (...args) => {
      f.db
        .prepare(
          "INSERT INTO message_recall_index_suppressions(doc_anchor,passage_id,lease_id,state,prepared_at) VALUES (?,?,'lease','prepared','now')",
        )
        .run(`thread-${f.t.id}`, f.rows[0].id);
      return original(...args);
    };
    const backfill = new ThreadOverviewBackfill({ repository: f.repo, generate: async () => null });
    const [state] = await backfill.initialize();
    await backfill.process(state);
    assert.equal((await backfill.initialize())[0].cursor, null);
  } finally {
    f.db.close();
  }
});
