/**
 * Usage Aggregator Tests — F128
 * 测试按日 × 猫聚合 token 消耗的纯函数
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('aggregateUsageByDay', () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;

  /** Today's UTC noon — safe anchor that never crosses midnight */
  function todayNoon() {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    return d.getTime();
  }

  /** UTC date string for an epoch ms */
  function dateOf(epochMs) {
    return new Date(epochMs).toISOString().slice(0, 10);
  }

  /**
   * Build a minimal InvocationRecord. usageRecordedAt defaults to the given
   * timestamp (aggregator prefers usageRecordedAt > updatedAt > createdAt).
   * Pass opts.createdAt / opts.updatedAt to simulate cross-midnight scenarios.
   */
  function makeRecord(id, ts, usageByCat, statusOrOpts = 'succeeded') {
    const epoch = typeof ts === 'number' ? ts : new Date(ts).getTime();
    const opts = typeof statusOrOpts === 'string' ? { status: statusOrOpts } : statusOrOpts;
    return {
      id,
      threadId: 'thread-1',
      userId: 'user-1',
      userMessageId: null,
      targetCats: Object.keys(usageByCat),
      intent: 'execute',
      status: opts.status ?? 'succeeded',
      idempotencyKey: `key-${id}`,
      usageByCat,
      createdAt: opts.createdAt ?? epoch,
      updatedAt: opts.updatedAt ?? epoch,
      usageRecordedAt: opts.usageRecordedAt ?? epoch,
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
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor, {
        opus: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, costUsd: 0.05 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].date, dateOf(anchor));
    assert.deepEqual(result.daily[0].cats.opus, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costUsd: 0.05,
      participations: 1,
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
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor - 4 * 3600_000, {
        opus: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, costUsd: 0.05 },
      }),
      makeRecord('inv-2', anchor + 2 * 3600_000, {
        codex: { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 300, costUsd: 0 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 1);
    const day = result.daily[0];
    assert.equal(day.cats.opus.inputTokens, 1000);
    assert.equal(day.cats.codex.inputTokens, 2000);
    assert.equal(day.total.inputTokens, 3000);
    assert.equal(day.total.outputTokens, 1300);
    assert.equal(day.total.invocations, 2);
  });

  test('multiple days are sorted descending (newest first)', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor - 2 * ONE_DAY, {
        opus: { inputTokens: 100, outputTokens: 50 },
      }),
      makeRecord('inv-2', anchor, {
        opus: { inputTokens: 300, outputTokens: 150 },
      }),
      makeRecord('inv-3', anchor - ONE_DAY, {
        opus: { inputTokens: 200, outputTokens: 100 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 3);
    assert.equal(result.daily[0].date, dateOf(anchor));
    assert.equal(result.daily[1].date, dateOf(anchor - ONE_DAY));
    assert.equal(result.daily[2].date, dateOf(anchor - 2 * ONE_DAY));
  });

  test('same cat multiple invocations on same day accumulates', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor - 4 * 3600_000, {
        opus: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 },
      }),
      makeRecord('inv-2', anchor + 4 * 3600_000, {
        opus: { inputTokens: 2000, outputTokens: 1000, costUsd: 0.1 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].cats.opus.inputTokens, 3000);
    assert.equal(result.daily[0].cats.opus.outputTokens, 1500);
    assert.equal(result.daily[0].cats.opus.costUsd, 0.15);
    assert.equal(result.daily[0].cats.opus.participations, 2);
  });

  test('catId filter returns only matching cat data', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor, {
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
    const anchor = todayNoon();
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
        createdAt: anchor,
        updatedAt: anchor,
        // no usageByCat
      },
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.deepEqual(result.daily, []);
    assert.equal(result.grandTotal.invocations, 0);
  });

  test('multi-cat invocation: participations per cat, invocations = 1 record', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor, {
        opus: { inputTokens: 1000, outputTokens: 500 },
        sonnet: { inputTokens: 800, outputTokens: 400 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily[0].cats.opus.participations, 1);
    assert.equal(result.daily[0].cats.sonnet.participations, 1);
    assert.equal(result.daily[0].total.invocations, 1);
    assert.equal(result.grandTotal.invocations, 1);
  });

  test('days parameter excludes records outside the window', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-today', anchor, {
        opus: { inputTokens: 100, outputTokens: 50 },
      }),
      makeRecord('inv-yesterday', anchor - ONE_DAY, {
        opus: { inputTokens: 200, outputTokens: 100 },
      }),
      makeRecord('inv-3-days-ago', anchor - 3 * ONE_DAY, {
        opus: { inputTokens: 300, outputTokens: 150 },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 1 });

    assert.equal(result.daily.length, 1);
    assert.equal(result.grandTotal.inputTokens, 100);
    assert.equal(result.grandTotal.invocations, 1);
  });

  test('days=2 includes today and yesterday only', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-today', anchor, {
        opus: { inputTokens: 100, outputTokens: 50 },
      }),
      makeRecord('inv-yesterday', anchor - ONE_DAY, {
        opus: { inputTokens: 200, outputTokens: 100 },
      }),
      makeRecord('inv-3-days-ago', anchor - 3 * ONE_DAY, {
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
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-1', anchor, {
        opus: { inputTokens: 1000 }, // no outputTokens, no cacheReadTokens, no costUsd
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily[0].cats.opus.inputTokens, 1000);
    assert.equal(result.daily[0].cats.opus.outputTokens, 0);
    assert.equal(result.daily[0].cats.opus.cacheReadTokens, 0);
    assert.equal(result.daily[0].cats.opus.costUsd, 0);
  });

  test('falls back to lastTurnInputTokens/contextUsedTokens for providers without normalized input tokens', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      makeRecord('inv-kimi-fallback', anchor, {
        kimi: {
          lastTurnInputTokens: 6335,
          contextUsedTokens: 6335,
        },
      }),
      makeRecord('inv-kimi-total-fallback', anchor, {
        kimi: {
          totalTokens: 900,
        },
      }),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    assert.equal(result.daily[0].cats.kimi.inputTokens, 7235);
    assert.equal(result.daily[0].cats.kimi.outputTokens, 0);
    assert.equal(result.daily[0].cats.kimi.participations, 2);
    assert.equal(result.daily[0].total.inputTokens, 7235);
    assert.equal(result.daily[0].total.outputTokens, 0);
    assert.equal(result.daily[0].total.invocations, 2);
  });

  test('cross-midnight: usageRecordedAt on next day overrides createdAt/updatedAt', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    // Invocation created before midnight, usage recorded after midnight (next day)
    const beforeMidnight = anchor - ONE_DAY + 1000; // yesterday 12:00:01
    const afterMidnight = anchor; // today 12:00:00
    const records = [
      makeRecord(
        'inv-cross',
        afterMidnight,
        {
          opus: { inputTokens: 500, outputTokens: 100 },
        },
        {
          createdAt: beforeMidnight,
          updatedAt: afterMidnight,
          usageRecordedAt: afterMidnight,
        },
      ),
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    // Should be bucketed by usageRecordedAt (today), not createdAt (yesterday)
    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].date, dateOf(afterMidnight));
  });

  test('legacy record without usageRecordedAt falls back to updatedAt', async () => {
    const { aggregateUsageByDay } = await import('../dist/domains/cats/services/usage-aggregator.js');
    const anchor = todayNoon();
    const records = [
      {
        id: 'inv-legacy',
        threadId: 'thread-1',
        userId: 'user-1',
        userMessageId: null,
        targetCats: ['opus'],
        intent: 'execute',
        status: 'succeeded',
        idempotencyKey: 'key-legacy',
        usageByCat: { opus: { inputTokens: 400, outputTokens: 80 } },
        createdAt: anchor - ONE_DAY, // yesterday
        updatedAt: anchor, // today
        // no usageRecordedAt — legacy record
      },
    ];

    const result = aggregateUsageByDay(records, { days: 7 });

    // Falls back to updatedAt (today)
    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].date, dateOf(anchor));
  });
});
