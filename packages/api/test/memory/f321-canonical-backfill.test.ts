import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ThreadOverviewBackfill } from '../../src/domains/memory/curation/ThreadOverviewBackfill.js';
import { ThreadOverviewRepository } from '../../src/domains/memory/curation/ThreadOverviewRepository.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

for (const order of ['nonmonotonic', 'delayed_visibility'] as const) {
  test(`historical ${order} preserves every canonical visible source before its frozen frontier`, async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const threads = new ThreadStore();
    const messages = new MessageStore();
    const thread = threads.create('owner', 'old');
    const first = messages.append({
      threadId: thread.id,
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      content: 'first',
      timestamp: 200,
      ...(order === 'delayed_visibility'
        ? {
            deliveryStatus: 'queued' as const,
          }
        : {}),
    });
    const second = messages.append({
      threadId: thread.id,
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      content: 'second',
      timestamp: 100,
    });
    if (order === 'delayed_visibility') assert.equal(messages.markDelivered(first.id, 300)?.deliveryTransitioned, true);
    const expected = messages.getByThreadAfter(thread.id).map((m) => m.id);
    assert.deepEqual(expected, order === 'delayed_visibility' ? [second.id, first.id] : [first.id, second.id]);
    // Upgrade a real legacy raw watermark: only the second canonical row is pending.
    db.prepare(`INSERT INTO summary_state(thread_id,last_summarized_message_id,
      pending_message_count,pending_token_count,pending_signal_flags) VALUES (?,?,1,2,1)`).run(thread.id, expected[0]);
    const batches: string[][] = [];
    const repository = new ThreadOverviewRepository({
      db,
      ownerUserId: 'owner',
      threadStore: threads,
      messageStore: messages,
    });
    const backfill = new ThreadOverviewBackfill({
      repository,
      generate: async (input) => {
        batches.push(input.messages.map((m) => m.id));
        return {
          segments: [
            {
              summary: `idea （来源：${thread.id}#${input.messages[0].id}）`,
              topicKey: 'overview',
              topicLabel: 'old',
              boundaryReason: 'batch',
              boundaryConfidence: 'high',
              fromMessageId: input.messages[0].id,
              toMessageId: input.messages.at(-1)!.id,
              messageCount: input.messages.length,
            },
          ],
        };
      },
    });
    try {
      const [state] = await backfill.initialize();
      assert.equal(await backfill.process(state), true);
      assert.deepEqual(batches.flat(), expected);
      assert.deepEqual(await backfill.initialize(), []);
      const settled = db
        .prepare(
          'SELECT pending_message_count AS n,pending_token_count AS tokens,carry_over AS carry FROM summary_state',
        )
        .get() as { n: number; tokens: number; carry: number };
      assert.deepEqual(settled, { n: 0, tokens: 0, carry: 0 });
      // A new source published after the frozen frontier belongs to live processing.
      const later = messages.append({
        threadId: thread.id,
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        content: 'later',
        timestamp: 1,
      });
      const watermark = (
        db.prepare('SELECT last_summarized_message_id AS id FROM summary_state WHERE thread_id=?').get(thread.id) as {
          id: string;
        }
      ).id;
      assert.deepEqual(
        messages.getByThreadAfter(thread.id, watermark).map((m) => m.id),
        [later.id],
      );
    } finally {
      db.close();
    }
  });
}
