/**
 * Standup Aggregator Tests — Q12 Bootcamp
 * 测试当日 × 猫聚合站会摘要的纯函数
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('aggregateStandup', () => {
  /** Today's UTC noon — safe anchor that never crosses midnight */
  function todayNoon() {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    return d.getTime();
  }

  /** Yesterday's UTC noon */
  function yesterdayNoon() {
    return todayNoon() - 24 * 60 * 60 * 1000;
  }

  /**
   * Build a minimal InvocationRecord for testing.
   */
  function makeRecord(id, ts, targetCats, status, usageByCat, threadId = 'thread-1') {
    const epoch = typeof ts === 'number' ? ts : new Date(ts).getTime();
    return {
      id,
      threadId,
      userId: 'user-1',
      userMessageId: null,
      targetCats,
      intent: 'execute',
      status,
      idempotencyKey: `key-${id}`,
      usageByCat,
      usageRecordedAt: epoch,
      createdAt: epoch,
      updatedAt: epoch,
    };
  }

  test('empty records returns empty cats and zero summary', async () => {
    const { aggregateStandup } = await import('../dist/domains/cats/services/standup-aggregator.js');
    const result = aggregateStandup([]);

    assert.ok(result.date);
    assert.deepEqual(result.cats, {});
    assert.deepEqual(result.summary, { totalInvocations: 0, totalCostUsd: 0 });
  });

  test('filters to today only — excludes yesterday', async () => {
    const { aggregateStandup } = await import('../dist/domains/cats/services/standup-aggregator.js');
    const records = [
      makeRecord('today-1', todayNoon(), ['opus'], 'succeeded', {
        opus: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, costUsd: 0.01 },
      }),
      makeRecord('yesterday-1', yesterdayNoon(), ['opus'], 'succeeded', {
        opus: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, costUsd: 0.02 },
      }),
    ];

    const result = aggregateStandup(records);

    assert.equal(Object.keys(result.cats).length, 1);
    assert.equal(result.cats.opus.invocations, 1);
    assert.equal(result.cats.opus.tokens.input, 100);
    assert.equal(result.summary.totalInvocations, 1);
  });

  test('aggregates multiple cats correctly', async () => {
    const { aggregateStandup } = await import('../dist/domains/cats/services/standup-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor, ['opus'], 'succeeded', {
        opus: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, costUsd: 0.05 },
      }),
      makeRecord('inv-2', anchor + 1000, ['codex'], 'failed', {
        codex: { inputTokens: 800, outputTokens: 300, cacheReadTokens: 100, costUsd: 0.03 },
      }),
      makeRecord('inv-3', anchor + 2000, ['opus', 'gemini'], 'succeeded', {
        opus: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, costUsd: 0.02 },
        gemini: { inputTokens: 600, outputTokens: 250, cacheReadTokens: 0, costUsd: 0 },
      }),
    ];

    const result = aggregateStandup(records);

    // opus: 2 participations
    assert.equal(result.cats.opus.invocations, 2);
    assert.equal(result.cats.opus.succeeded, 2);
    assert.equal(result.cats.opus.failed, 0);
    assert.equal(result.cats.opus.tokens.input, 1500);
    assert.equal(result.cats.opus.tokens.output, 700);
    assert.equal(result.cats.opus.costUsd, 0.07);

    // codex: 1 participation, failed
    assert.equal(result.cats.codex.invocations, 1);
    assert.equal(result.cats.codex.succeeded, 0);
    assert.equal(result.cats.codex.failed, 1);

    // gemini: 1 participation
    assert.equal(result.cats.gemini.invocations, 1);

    // summary: 3 distinct invocations (not 4 participations)
    assert.equal(result.summary.totalInvocations, 3);
  });

  test('tracks lastActiveAt as the latest updatedAt', async () => {
    const { aggregateStandup } = await import('../dist/domains/cats/services/standup-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor, ['opus'], 'succeeded', {
        opus: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      }),
      makeRecord('inv-2', anchor + 5000, ['opus'], 'succeeded', {
        opus: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      }),
    ];

    const result = aggregateStandup(records);
    assert.equal(result.cats.opus.lastActiveAt, anchor + 5000);
  });

  test('collects recentThreads (unique, max 5)', async () => {
    const { aggregateStandup } = await import('../dist/domains/cats/services/standup-aggregator.js');
    const anchor = todayNoon();
    const records = [];
    for (let i = 0; i < 7; i++) {
      records.push(
        makeRecord(
          `inv-${i}`,
          anchor + i * 1000,
          ['opus'],
          'succeeded',
          {
            opus: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          },
          `thread-${i}`,
        ),
      );
    }
    // Add duplicate thread
    records.push(
      makeRecord(
        'inv-dup',
        anchor + 8000,
        ['opus'],
        'succeeded',
        {
          opus: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        },
        'thread-0',
      ),
    );

    const result = aggregateStandup(records);
    assert.ok(result.cats.opus.recentThreads.length <= 5);
    // Should be unique
    const unique = new Set(result.cats.opus.recentThreads);
    assert.equal(unique.size, result.cats.opus.recentThreads.length);
  });

  test('records without usageByCat still count invocations', async () => {
    const { aggregateStandup } = await import('../dist/domains/cats/services/standup-aggregator.js');
    const anchor = todayNoon();
    const records = [makeRecord('inv-1', anchor, ['opus'], 'running', undefined)];

    const result = aggregateStandup(records);
    assert.equal(result.cats.opus.invocations, 1);
    assert.equal(result.cats.opus.tokens.input, 0);
  });
});
