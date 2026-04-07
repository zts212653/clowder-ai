import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('SummaryCompaction e2e', () => {
  let db;
  let processThread;
  const SUMMARY_CONFIG_OVERRIDE = {
    pendingMessageThreshold: 20,
    pendingTokenThreshold: 1500,
    cooldownHours: 2,
    quietWindowMinutes: 10,
    perTickBudget: 5,
    backfillIntervalMs: 2000,
    driftAlertTokenThreshold: 800,
    maxTopicSegments: 3,
    minSplitMessageCount: 8,
    minSplitTokenCount: 600,
    schedulerIntervalMs: 30 * 60 * 1000,
  };

  function makeMsgs(count, startId = 1) {
    return Array.from({ length: count }, (_, i) => ({
      id: `msg-${startId + i}`,
      content: `Message ${startId + i} about project decisions`,
      catId: 'opus',
      timestamp: Date.now() - (count - i) * 60_000,
    }));
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);

    const mod = await import('../../dist/domains/memory/SummaryCompactionTask.js');
    processThread = mod.processThread;

    // Seed evidence_docs with a thread
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('thread-test-thread', 'thread', 'active', 'Test Thread', 'Old concat summary', new Date().toISOString());

    // Seed summary_state as eligible: 25 msgs, 2000 tokens, no cooldown
    db.prepare(
      `INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('test-thread', 25, 2000, 0, 'concat');
  });

  it('e2e: mock Opus → inserts segment → submits candidate → updates watermark', async () => {
    const candidates = [];
    const msgs = makeMsgs(25);

    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000, // 20 min idle
      }),
      getMessagesAfterWatermark: async (_tid, _after, _limit) => msgs,
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Discussed memory architecture decisions and lesson about Redis isolation',
            topicKey: 'memory-architecture',
            topicLabel: 'Memory Architecture Decisions',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [
              {
                kind: 'decision',
                title: 'Knowledge Feed uses YAML files as truth source',
                claim: 'YAML files are truth source for git-trackability',
                confidence: 'explicit',
              },
            ],
          },
        ],
      }),
      reEmbed: async () => {},
      submitCandidate: async (c) => {
        candidates.push(c);
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);

    // Verify summary_segments inserted
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('test-thread');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].level, 1); // L1
    assert.ok(segments[0].summary.includes('memory architecture'));

    // Verify evidence_docs.summary updated (read model)
    const doc = db.prepare('SELECT summary FROM evidence_docs WHERE anchor = ?').get('thread-test-thread');
    assert.ok(doc.summary.includes('memory architecture'));

    // Verify watermark advanced
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.last_summarized_message_id, msgs[msgs.length - 1].id);
    assert.equal(state.summary_type, 'abstractive');
    assert.ok(state.last_abstractive_at);

    // Verify candidate submitted
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'decision');
    assert.ok(candidates[0].title.includes('YAML'));
  });

  it('sets carry_over=1 when messages remain after batch', async () => {
    const batch1 = makeMsgs(200, 1);
    const remaining = makeMsgs(50, 201);
    let callCount = 0;

    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async (_tid, afterId, _limit) => {
        callCount++;
        // First call: return batch of 200
        if (callCount === 1) return batch1;
        // Second/third call (remaining check): return 50 remaining
        return remaining;
      },
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Large batch summary',
            topicKey: 'large-batch',
            topicLabel: 'Large Batch',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: batch1[0].id,
            toMessageId: batch1[batch1.length - 1].id,
            messageCount: 200,
          },
        ],
      }),
      logger: { info: () => {}, error: () => {} },
    };

    // Update state to reflect 250 messages
    db.prepare(
      'UPDATE summary_state SET pending_message_count = 250, pending_token_count = 10000 WHERE thread_id = ?',
    ).run('test-thread');

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 250,
        pending_token_count: 10000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.carry_over, 1, 'carry_over should be 1 when messages remain');
    assert.equal(state.pending_message_count, 50, 'pending_message_count should reflect remaining');
  });

  it('returns false when Opus API returns null (fail-open)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => msgs,
      generateAbstractive: async () => null,
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, false);
    // No segments inserted
    const segments = db.prepare('SELECT count(*) as n FROM summary_segments').get();
    assert.equal(segments.n, 0);
    // Watermark unchanged
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.last_summarized_message_id, null);
  });

  it('continues when submitCandidate throws (fail-open)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => msgs,
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Summary with failing candidate',
            topicKey: 'fail-candidate',
            topicLabel: 'Fail Candidate',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [{ kind: 'lesson', title: 'Test lesson', claim: 'test', confidence: 'inferred' }],
          },
        ],
      }),
      submitCandidate: async () => {
        throw new Error('MarkerQueue unavailable');
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true, 'should succeed despite submitCandidate failure');
    const segments = db.prepare('SELECT count(*) as n FROM summary_segments').get();
    assert.equal(segments.n, 1, 'segment should still be inserted');
  });

  it('full pipeline: gate → execute → segment + candidate', async () => {
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');

    const msgs = makeMsgs(25);
    const candidates = [];

    const spec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => msgs,
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Full pipeline test summary',
            topicKey: 'pipeline-test',
            topicLabel: 'Pipeline Test',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [
              {
                kind: 'decision',
                title: 'Pipeline verification is essential for runtime trust',
                claim: 'Must verify full pipeline before declaring Phase G complete',
                confidence: 'explicit',
              },
            ],
          },
        ],
      }),
      reEmbed: async () => {},
      submitCandidate: async (c) => {
        candidates.push(c);
      },
      logger: { info: () => {}, error: () => {} },
    });

    // Step 1: Gate should find eligible thread
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true, 'gate should find eligible thread');
    assert.ok(gateResult.workItems.length > 0);

    // Step 2: Execute with the work item
    const workItem = gateResult.workItems[0];
    await spec.run.execute(workItem.signal, workItem.subjectKey, {
      taskId: spec.id,
      runId: 'test-run',
      startedAt: Date.now(),
    });

    // Verify segment inserted
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('test-thread');
    assert.equal(segments.length, 1);
    assert.ok(segments[0].summary.includes('pipeline'));

    // Verify candidate submitted
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'decision');

    // Verify watermark advanced
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.summary_type, 'abstractive');
    assert.ok(state.last_abstractive_at);
  });

  it('skips candidate submission when submitCandidate is undefined (F102_DURABLE_CANDIDATES=off)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => msgs,
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Summary with candidates but no submission',
            topicKey: 'no-submit',
            topicLabel: 'No Submit',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [{ kind: 'decision', title: 'Should not be submitted', claim: 'test', confidence: 'explicit' }],
          },
        ],
      }),
      // submitCandidate intentionally undefined — simulates F102_DURABLE_CANDIDATES=off
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true, 'should succeed without submitCandidate');
    // Segment still inserted even without candidate submission
    const segments = db.prepare('SELECT count(*) as n FROM summary_segments').get();
    assert.equal(segments.n, 1);
    // Watermark still advanced
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.summary_type, 'abstractive');
  });

  it('continues when reEmbed throws (fail-open)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => msgs,
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Summary with failing re-embed',
            topicKey: 'fail-embed',
            topicLabel: 'Fail Embed',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
          },
        ],
      }),
      reEmbed: async () => {
        throw new Error('Embedding service down');
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true, 'should succeed despite reEmbed failure');
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.summary_type, 'abstractive');
  });
});
