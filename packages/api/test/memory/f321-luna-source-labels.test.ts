import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { AbstractiveMessage, SummaryAttempt } from '../../src/domains/memory/abstractive-summary-types.js';
import { createLunaCurationClient } from '../../src/domains/memory/LunaCurationClient.js';
import { processThread } from '../../src/domains/memory/SummaryCompactionTask.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { SUMMARY_CONFIG } from '../../src/domains/memory/summary-config.js';

const captured: { sourceMessageIds: string[]; responses: Array<{ text: string; usage: { totalTokens: number } }> } =
  JSON.parse(readFileSync(new URL('./fixtures/f321-luna-source-labels.json', import.meta.url), 'utf8'));

function clientFor(text: string, totalTokens = 15) {
  return createLunaCurationClient({
    resolveService: () => ({
      catId: 'codex6-luna',
      model: 'gpt-6-luna',
      service: {
        async *invoke() {
          yield { type: 'text', catId: 'codex6-luna', timestamp: 0, content: text };
          yield {
            type: 'done',
            catId: 'codex6-luna',
            timestamp: 1,
            metadata: { provider: 'openai', model: 'gpt-6-luna', usage: { totalTokens } },
          };
        },
      },
    }),
    workingDirectory: '/tmp',
    logger: { info() {}, error() {} },
  });
}

for (const [index, response] of captured.responses.entries()) {
  test(`runtime Luna response ${index + 1} commits actual IDs despite the message label`, async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const threadId = 'thread_msheiy8wz5r7qsn4';
    const messages: AbstractiveMessage[] = ['quote-comment', 'long-message'].map((name) =>
      JSON.parse(readFileSync(new URL(`./fixtures/f321-${name}.json`, import.meta.url), 'utf8')),
    );
    assert.deepEqual(
      messages.map((message) => message.id),
      captured.sourceMessageIds,
    );
    db.prepare('INSERT INTO summary_state (thread_id,pending_message_count,pending_signal_flags) VALUES (?,2,1)').run(
      threadId,
    );
    const state = db.prepare('SELECT * FROM summary_state').get() as Parameters<typeof processThread>[0];
    const attempts: SummaryAttempt[] = [];
    try {
      const changed = await processThread(
        state,
        {
          db,
          enabled: () => true,
          getThreadLastActivity: async () => null,
          getMessagesAfterWatermark: async (_thread, after) => (after ? [] : messages),
          generateAbstractive: clientFor(response.text, response.usage.totalTokens),
          onAttempt: (attempt) => {
            attempts.push(attempt);
          },
          logger: { info() {}, error() {} },
        },
        SUMMARY_CONFIG,
      );
      assert.equal(changed, true);
      const segment = db.prepare('SELECT summary,to_message_id AS lastId FROM summary_segments').get() as {
        summary: string;
        lastId: string;
      };
      assert.equal(segment.lastId, captured.sourceMessageIds[1]);
      for (const id of captured.sourceMessageIds) assert.ok(segment.summary.includes(`${threadId}#${id}`));
      assert.ok(!segment.summary.includes('#message '));
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].success, true);
      assert.equal(attempts[0].totalTokens, response.usage.totalTokens);
    } finally {
      db.close();
    }
  });
}

for (const label of ['message invented', 'other-thread#m1', 'message other-thread#m1', 'message M1']) {
  test(`decorated or cross-thread source cannot bypass exact input IDs: ${label}`, async () => {
    const result = await clientFor(`判断变化：不能虚构出处。 [sources: ${label}]`)({
      previousSummary: null,
      threadId: 'home',
      messages: [{ id: 'm1', content: 'actual source', timestamp: 0 }],
    });
    assert.equal(result, null);
  });
}

test('plain and labelled occurrences of the same actual source collapse to one coordinate', async () => {
  const result = await clientFor('值得回看：同一来源。 [sources: m1, message m1]')({
    previousSummary: null,
    threadId: 'home',
    messages: [{ id: 'm1', content: 'actual source', timestamp: 0 }],
  });
  assert.ok(result);
  assert.equal(result.segments[0].summary, '值得回看：同一来源。 （来源：home#m1）');
});

test('an exact actual ID wins before interpreting a message label', async () => {
  const result = await clientFor('判断变化：保留原坐标。 [sources: message m1]')({
    previousSummary: null,
    threadId: 'home',
    messages: [{ id: 'message m1', content: 'actual source', timestamp: 0 }],
  });
  assert.ok(result);
  assert.equal(result.segments[0].summary, '判断变化：保留原坐标。 （来源：home#message m1）');
});
