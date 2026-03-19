/**
 * Usage Aggregator Tests — F128
 * 测试按日 × 猫聚合 token 消耗的纯函数
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('aggregateUsageByDay', () => {
  /** helper: build a minimal InvocationRecord with usageByCat */
  function makeRecord(id, createdAt, usageByCat, status = 'succeeded') {
    return {
      id,
      threadId: 'thread-1',
      userId: 'user-1',
      userMessageId: null,
      targetCats: Object.keys(usageByCat),
      intent: 'execute',
      status,
      idempotencyKey: `key-${id}`,
      usageByCat,
      createdAt: typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime(),
      updatedAt: Date.now(),
    };
  }

  test('empty records returns empty daily array with grandTotal zeros', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const result = aggregateUsageByDay([], { days: 7 });

    assert.ok(result.period);
    assert.ok(result.period.from);
    assert.ok(result.period.to);
    assert.deepEqual(result.daily, []);
    assert.deepEqual(result.grandTotal, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      invocations: 0,
    });
  });

  test('single record aggregates correctly to one day', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-19T10:00:00Z', {
        opus: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, costUsd: 0.05 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].date, '2026-03-19');
    assert.deepEqual(result.daily[0].cats.opus, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costUsd: 0.05,
      invocations: 1,
    });
    assert.deepEqual(result.daily[0].total, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costUsd: 0.05,
      invocations: 1,
    });
    assert.deepEqual(result.grandTotal, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costUsd: 0.05,
      invocations: 1,
    });
  });

  test('multiple cats on same day aggregate per-cat and total', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-19T08:00:00Z', {
        opus: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, costUsd: 0.05 },
      }),
      makeRecord('inv-2', '2026-03-19T14:00:00Z', {
        codex: { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 300, costUsd: 0 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 1);
    const day = result.daily[0];
    assert.equal(day.date, '2026-03-19');
    assert.equal(day.cats.opus.inputTokens, 1000);
    assert.equal(day.cats.codex.inputTokens, 2000);
    assert.equal(day.total.inputTokens, 3000);
    assert.equal(day.total.outputTokens, 1300);
    assert.equal(day.total.invocations, 2);
  });

  test('multiple days are sorted descending (newest first)', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-17T10:00:00Z', {
        opus: { inputTokens: 100, outputTokens: 50 },
      }),
      makeRecord('inv-2', '2026-03-19T10:00:00Z', {
        opus: { inputTokens: 300, outputTokens: 150 },
      }),
      makeRecord('inv-3', '2026-03-18T10:00:00Z', {
        opus: { inputTokens: 200, outputTokens: 100 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 3);
    assert.equal(result.daily[0].date, '2026-03-19');
    assert.equal(result.daily[1].date, '2026-03-18');
    assert.equal(result.daily[2].date, '2026-03-17');
  });

  test('same cat multiple invocations on same day accumulates', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-19T08:00:00Z', {
        opus: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 },
      }),
      makeRecord('inv-2', '2026-03-19T16:00:00Z', {
        opus: { inputTokens: 2000, outputTokens: 1000, costUsd: 0.1 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].cats.opus.inputTokens, 3000);
    assert.equal(result.daily[0].cats.opus.outputTokens, 1500);
    assert.equal(result.daily[0].cats.opus.costUsd, 0.15);
    assert.equal(result.daily[0].cats.opus.invocations, 2);
  });

  test('catId filter returns only matching cat data', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-19T10:00:00Z', {
        opus: { inputTokens: 1000, outputTokens: 500 },
        codex: { inputTokens: 2000, outputTokens: 800 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7, catId: 'opus' });

    assert.equal(result.daily.length, 1);
    assert.ok(result.daily[0].cats.opus);
    assert.equal(result.daily[0].cats.codex, undefined);
    assert.equal(result.daily[0].total.inputTokens, 1000);
  });

  test('records without usageByCat are skipped', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      {
        id: 'inv-no-usage',
        threadId: 'thread-1',
        userId: 'user-1',
        userMessageId: null,
        targetCats: ['opus'],
        intent: 'execute',
        status: 'succeeded',
        idempotencyKey: 'key-no-usage',
        createdAt: new Date('2026-03-19T10:00:00Z').getTime(),
        updatedAt: Date.now(),
        // no usageByCat
      },
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.deepEqual(result.daily, []);
    assert.equal(result.grandTotal.invocations, 0);
  });

  test('multi-cat invocation counts once per cat', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-19T10:00:00Z', {
        opus: { inputTokens: 1000, outputTokens: 500 },
        sonnet: { inputTokens: 800, outputTokens: 400 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily[0].cats.opus.invocations, 1);
    assert.equal(result.daily[0].cats.sonnet.invocations, 1);
    // total.invocations = sum of per-cat invocations
    assert.equal(result.daily[0].total.invocations, 2);
  });

  test('days parameter excludes records outside the window', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const records = [
      makeRecord('inv-today', now - 1000, {
        opus: { inputTokens: 100, outputTokens: 50 },
      }),
      makeRecord('inv-yesterday', now - oneDay, {
        opus: { inputTokens: 200, outputTokens: 100 },
      }),
      makeRecord('inv-3-days-ago', now - 3 * oneDay, {
        opus: { inputTokens: 300, outputTokens: 150 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 1 });

    // days=1 should only include today
    assert.equal(result.daily.length, 1);
    assert.equal(result.grandTotal.inputTokens, 100);
    assert.equal(result.grandTotal.invocations, 1);
  });

  test('days=2 includes today and yesterday only', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const records = [
      makeRecord('inv-today', now - 1000, {
        opus: { inputTokens: 100, outputTokens: 50 },
      }),
      makeRecord('inv-yesterday', now - oneDay, {
        opus: { inputTokens: 200, outputTokens: 100 },
      }),
      makeRecord('inv-3-days-ago', now - 3 * oneDay, {
        opus: { inputTokens: 300, outputTokens: 150 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 2 });

    assert.equal(result.daily.length, 2);
    assert.equal(result.grandTotal.inputTokens, 300); // 100 + 200, not 600
    assert.equal(result.grandTotal.invocations, 2);
  });

  test('handles missing numeric fields gracefully (treats as 0)', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const records = [
      makeRecord('inv-1', '2026-03-19T10:00:00Z', {
        opus: { inputTokens: 1000 }, // no outputTokens, no cacheReadTokens, no costUsd
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily[0].cats.opus.inputTokens, 1000);
    assert.equal(result.daily[0].cats.opus.outputTokens, 0);
    assert.equal(result.daily[0].cats.opus.cacheReadTokens, 0);
    assert.equal(result.daily[0].cats.opus.costUsd, 0);
  });
});
