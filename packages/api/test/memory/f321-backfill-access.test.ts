import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { parseCursor } from '../../src/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ThreadOverviewBackfill } from '../../src/domains/memory/curation/ThreadOverviewBackfill.js';
import { ThreadOverviewRepository } from '../../src/domains/memory/curation/ThreadOverviewRepository.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

for (const kind of ['delete', 'systemKind', 'access'] as const) {
  test(`backfill pauses ${kind} without attempt writes and resumes the same cursor after restoration`, async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const threads = new ThreadStore();
    const messages = new MessageStore();
    const thread = threads.create('owner', 'old idea');
    const first = messages.append({
      threadId: thread.id,
      userId: 'owner',
      catId: null,
      content: 'first',
      timestamp: 1,
    });
    const last = messages.append({ threadId: thread.id, userId: 'owner', catId: null, content: 'last', timestamp: 2 });
    let calls = 0;
    const repository = new ThreadOverviewRepository({
      db,
      ownerUserId: 'owner',
      threadStore: threads,
      messageStore: messages,
    });
    const backfill = new ThreadOverviewBackfill({
      repository,
      generate: async () => {
        calls++;
        return null;
      },
    });
    const readState = () =>
      db.prepare('SELECT * FROM thread_curation_state WHERE thread_id=?').get(thread.id) as Record<string, unknown>;
    try {
      await backfill.initialize();
      db.prepare('UPDATE thread_curation_state SET backfill_cursor=? WHERE thread_id=?').run(first.id, thread.id);
      const [queued] = await backfill.initialize();
      const before = readState();
      if (kind === 'delete') threads.softDelete(thread.id);
      if (kind === 'systemKind') thread.systemKind = 'memory_ops';
      if (kind === 'access') thread.createdBy = 'another-owner';
      assert.deepEqual(await backfill.initialize(), []);
      assert.equal(await backfill.process(queued), false);
      assert.deepEqual(await backfill.initialize(), []);
      assert.deepEqual(readState(), before, 'paused work must not rotate or pretend completion');
      assert.equal(calls, 0);
      if (kind === 'delete') threads.restore(thread.id);
      if (kind === 'systemKind') delete thread.systemKind;
      if (kind === 'access') thread.createdBy = 'owner';
      const [resumed] = await new ThreadOverviewBackfill({ repository, generate: async () => null }).initialize();
      assert.equal(resumed.cursor, first.id);
      assert.equal(parseCursor(resumed.target)?.id, last.id);
      assert.equal(await backfill.process(resumed), false);
      assert.equal(calls, 1, 'restored thread is retryable from the original cursor');
    } finally {
      db.close();
    }
  });
}

test('historical completion settles the same pending debt without claiming ignored rows as model sources', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const thread = threads.create('owner', 'old');
  const owner = messages.append({ threadId: thread.id, userId: 'owner', catId: null, content: 'idea', timestamp: 1 });
  messages.append({ threadId: thread.id, userId: 'system', catId: 'system', content: 'system log', timestamp: 2 });
  const tail = messages.append({
    threadId: thread.id,
    userId: 'owner',
    catId: null,
    content: 'private',
    visibility: 'whisper',
    timestamp: 3,
  });
  db.prepare(
    'INSERT INTO summary_state(thread_id,pending_message_count,pending_token_count,pending_signal_flags,carry_over) VALUES (?,3,9,1,1)',
  ).run(thread.id);
  const repository = new ThreadOverviewRepository({
    db,
    ownerUserId: 'owner',
    threadStore: threads,
    messageStore: messages,
  });
  const backfill = new ThreadOverviewBackfill({
    repository,
    generate: async (input) => ({
      segments: [
        {
          summary: `idea （来源：${thread.id}#${owner.id}）`,
          topicKey: 'overview',
          topicLabel: 'old',
          boundaryReason: 'batch',
          boundaryConfidence: 'high',
          fromMessageId: owner.id,
          toMessageId: owner.id,
          messageCount: input.messages.length,
        },
      ],
    }),
  });
  try {
    const [state] = await backfill.initialize();
    assert.equal(await backfill.process(state), true);
    const counters = db
      .prepare(
        'SELECT last_summarized_message_id AS watermark,pending_message_count AS count,pending_signal_flags AS flags,carry_over FROM summary_state WHERE thread_id=?',
      )
      .get(thread.id);
    assert.deepEqual(
      { ...counters, watermark: parseCursor(counters.watermark)?.id },
      { watermark: tail.id, count: 0, flags: 0, carry_over: 0 },
    );
    assert.deepEqual(await backfill.initialize(), []);
  } finally {
    db.close();
  }
});
