import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('SummaryCompactionTaskSpec', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
  });

  it('gate returns run:false when no eligible threads', async () => {
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');
    const spec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => null,
      getMessagesAfterWatermark: async () => [],
      generateAbstractive: async () => null,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate returns run:true with per-thread workItems when eligible threads exist', async () => {
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');

    // Seed a thread with enough pending work
    db.prepare(
      `INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('test-thread', 25, 2000, 0, 'concat');

    const spec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      // Thread has been quiet for > 10 minutes
      getThreadLastActivity: async () => ({ threadId: 'test-thread', lastMessageAt: Date.now() - 20 * 60 * 1000 }),
      getMessagesAfterWatermark: async () => [{ id: 'm1', content: 'hello', timestamp: Date.now() }],
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'test summary',
            topicKey: 'general',
            topicLabel: 'General',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: 'm1',
            toMessageId: 'm1',
            messageCount: 1,
          },
        ],
      }),
      logger: { info: () => {}, error: () => {} },
    });

    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.ok(result.workItems.length > 0);
    assert.match(result.workItems[0].subjectKey, /^thread-/);
  });

  it('has correct id and profile', async () => {
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');
    const spec = createSummaryCompactionTaskSpec({
      db: new Database(':memory:'),
      enabled: () => true,
      getThreadLastActivity: async () => null,
      getMessagesAfterWatermark: async () => [],
      generateAbstractive: async () => null,
      logger: { info: () => {}, error: () => {} },
    });

    assert.equal(spec.id, 'summary-compact');
    assert.equal(spec.profile, 'awareness');
    assert.equal(spec.trigger.ms, 30 * 60 * 1000);
  });
});
