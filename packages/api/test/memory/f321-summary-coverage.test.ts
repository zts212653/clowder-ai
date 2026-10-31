import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createAbstractiveClient } from '../../src/domains/memory/AbstractiveSummaryClient.js';
import type { SummaryAttempt } from '../../src/domains/memory/abstractive-summary-types.js';
import { processThread, type SummaryCompactionDeps } from '../../src/domains/memory/SummaryCompactionTask.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { SUMMARY_CONFIG } from '../../src/domains/memory/summary-config.js';

const messages = [
  { id: 'first', content: 'a'.repeat(60000), timestamp: 1000 },
  { id: 'unread', content: 'b'.repeat(30000), timestamp: 2000 },
];

async function run(
  generate: SummaryCompactionDeps['generateAbstractive'],
  rows = messages,
  options: { failRefresh?: boolean; resume?: boolean; appendDuringGeneration?: boolean } = {},
) {
  let failRefresh = options.failRefresh;

  const db = new Database(':memory:');
  applyMigrations(db);
  db.prepare(
    "INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at) VALUES ('thread-fixture', 'thread', 'active', 'Fixture', 'old', ?)",
  ).run(new Date().toISOString());
  db.prepare(
    "INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type) VALUES ('fixture', ?, ?, 0, 'concat')",
  ).run(
    rows.length,
    rows.reduce((sum, row) => sum + Math.ceil(row.content.length / 4), 0),
  );
  const state = db.prepare("SELECT * FROM summary_state WHERE thread_id = 'fixture'").get() as Parameters<
    typeof processThread
  >[0];
  const submitted: unknown[] = [];
  const attempts: SummaryAttempt[] = [];
  try {
    const deps: SummaryCompactionDeps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => null,
      getMessagesAfterWatermark: async (_thread, after, limit) => {
        if (failRefresh && after) throw new Error('read temporarily unavailable');
        return rows.slice(after ? rows.findIndex((m) => m.id === after) + 1 : 0).slice(0, limit);
      },
      generateAbstractive: async (input, signal, onUsage) => {
        const result = await generate(input, signal, onUsage);
        if (options.appendDuringGeneration) {
          db.prepare(
            "UPDATE summary_state SET pending_message_count = pending_message_count + 1, pending_token_count = pending_token_count + 100, pending_signal_flags = pending_signal_flags | 1 WHERE thread_id = 'fixture'",
          ).run();
        }
        return result;
      },
      onAttempt: (attempt) => {
        attempts.push(attempt);
      },
      submitCandidate: async (c) => {
        submitted.push(c);
      },
      logger: { info() {}, error() {} },
    };
    const changed = await processThread(state, deps, SUMMARY_CONFIG);
    const firstState = db.prepare("SELECT * FROM summary_state WHERE thread_id = 'fixture'").get() as Parameters<
      typeof processThread
    >[0];
    let resumed: { changed: boolean; state: Record<string, unknown> } | undefined;
    if (options.resume) {
      failRefresh = false;
      resumed = {
        changed: await processThread(firstState, deps, SUMMARY_CONFIG),
        state: db.prepare("SELECT * FROM summary_state WHERE thread_id = 'fixture'").get() as Record<string, unknown>,
      };
    }
    return {
      changed,
      resumed,
      state: firstState,
      segments: db.prepare('SELECT * FROM summary_segments').all() as Array<Record<string, unknown>>,
      submitted,
      attempts,
    };
  } finally {
    db.close();
  }
}

test('watermark persists only the consumed prefix and marks the unread tail as carry-over', async () => {
  const result = await run(async () => ({
    segments: [
      {
        summary: 'Full first message summary',
        topicKey: 'fixture',
        topicLabel: 'Fixture',
        boundaryReason: 'batch',
        boundaryConfidence: 'high',
        fromMessageId: 'first',
        toMessageId: 'first',
        messageCount: 1,
        candidates: [
          {
            kind: 'decision',
            title: 'Real source',
            claim: 'Supported',
            evidence: [{ threadId: 'fixture', messageId: 'first', span: '' }],
          },
        ],
      },
    ],
  }));
  assert.equal(result.changed, true);
  assert.equal(result.state.last_summarized_message_id, 'first');
  assert.equal(result.state.carry_over, 1);
  assert.equal(result.state.pending_message_count, 1);
  assert.equal(result.segments[0].to_message_id, 'first');
  assert.deepEqual((result.submitted[0] as { evidence: unknown }).evidence, [
    { threadId: 'fixture', messageId: 'first', span: '' },
  ]);
});

test('a noncontiguous segment cannot advance the watermark over missing input', async () => {
  const result = await run(async () => ({
    segments: [
      {
        summary: 'Missing first message',
        topicKey: 'fixture',
        topicLabel: 'Fixture',
        boundaryReason: 'batch',
        boundaryConfidence: 'high',
        fromMessageId: 'unread',
        toMessageId: 'unread',
        messageCount: 1,
      },
    ],
  }));
  assert.equal(result.changed, false);
  assert.equal(result.state.last_summarized_message_id, null);
  assert.equal(result.segments.length, 0);
});

test('invalid coverage records the final failure while retaining generation usage', async () => {
  const result = await run(async (_input, _signal, onUsage) => {
    onUsage?.({ threadId: 'fixture', messageCount: 2, modelId: 'fixture-model', totalTokens: 15 });
    return {
      segments: [
        {
          summary: 'Missing first message',
          topicKey: 'fixture',
          topicLabel: 'Fixture',
          boundaryReason: 'batch',
          boundaryConfidence: 'high',
          fromMessageId: 'unread',
          toMessageId: 'unread',
          messageCount: 1,
        },
      ],
    };
  });
  assert.equal(result.changed, false);
  assert.equal(result.state.last_summarized_message_id, null);
  assert.equal(result.segments.length, 0);
  assert.deepEqual(result.attempts, [
    { threadId: 'fixture', messageCount: 2, modelId: 'fixture-model', totalTokens: 15, success: false },
  ]);
});

for (const failure of ['second fragment fails', 'model output reaches token limit']) {
  test(`${failure} leaves the entire oversized message unacknowledged`, async () => {
    const prior = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (failure === 'second fragment fails' && calls === 2) return new Response('unavailable', { status: 503 });
      return Response.json({
        content: [{ type: 'text', text: '# Fixture\n\nUseful summary.' }],
        stop_reason: failure === 'model output reaches token limit' ? 'max_tokens' : 'end_turn',
      });
    };
    try {
      const client = createAbstractiveClient(
        async () => ({ mode: 'api_key', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' }),
        { info() {}, error() {} },
      );
      const result = await run(client, [{ id: 'oversized', content: 'x'.repeat(170000), timestamp: 1000 }]);
      assert.equal(result.changed, false);
      assert.equal(result.state.last_summarized_message_id, null);
      assert.equal(result.segments.length, 0);
      assert.equal(calls, failure === 'second fragment fails' ? 2 : 1);
    } finally {
      globalThis.fetch = prior;
    }
  });
}

test('known unread tail remains durably eligible when post-commit refresh fails', async () => {
  const result = await run(
    async (input) => ({
      segments: [
        {
          summary: 'First only',
          topicKey: 'fixture',
          topicLabel: 'Fixture',
          boundaryReason: 'batch',
          boundaryConfidence: 'high',
          fromMessageId: input.messages[0].id,
          toMessageId: input.messages[0].id,
          messageCount: 1,
        },
      ],
    }),
    messages,
    { failRefresh: true, resume: true },
  );
  assert.equal(result.changed, true);
  assert.equal(result.state.last_summarized_message_id, 'first');
  assert.equal(result.state.pending_message_count, 1);
  assert.equal(result.state.pending_token_count, 7500);
  assert.equal(result.state.carry_over, 1);
  assert.equal(result.resumed?.changed, true);
  assert.equal(result.resumed?.state.last_summarized_message_id, 'unread');
  assert.equal(result.resumed?.state.pending_message_count, 0);
});

test('a concurrent append remains pending even when fetched input was fully covered and refresh fails', async () => {
  const result = await run(
    async () => ({
      segments: [
        {
          summary: 'First only',
          topicKey: 'fixture',
          topicLabel: 'Fixture',
          boundaryReason: 'batch',
          boundaryConfidence: 'high',
          fromMessageId: 'first',
          toMessageId: 'first',
          messageCount: 1,
        },
      ],
    }),
    [messages[0]],
    { failRefresh: true, appendDuringGeneration: true },
  );
  assert.equal(result.changed, true);
  assert.equal(result.state.last_summarized_message_id, 'first');
  assert.equal(result.state.pending_message_count, 1);
  assert.equal(result.state.pending_token_count, 100);
  assert.equal(result.state.pending_signal_flags, 1);
  assert.equal(result.state.carry_over, 1);
});
