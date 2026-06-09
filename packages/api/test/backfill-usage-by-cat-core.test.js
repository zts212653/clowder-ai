/**
 * Issue #845 — Backfill core (pure planning) tests.
 *
 * The planner is split out of the CLI so it can be exercised without a live Redis.
 * These tests pin the decision rules listed in core.ts (status guard, window guard,
 * already-populated skip, recoverable vs unrecoverable, usageRecordedAt anchoring).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { indexMessagesByInvocation, planBackfill, formatBackfillPreview, decideApplyOutcome } = await import(
  '../dist/scripts/backfill-usage-by-cat/core.js'
);
const { applyPlan } = await import('../dist/scripts/backfill-usage-by-cat.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function makeInvocation(overrides) {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? 'thread-1',
    userId: overrides.userId ?? 'user-1',
    userMessageId: null,
    targetCats: overrides.targetCats ?? ['opus'],
    intent: 'execute',
    status: overrides.status ?? 'succeeded',
    idempotencyKey: overrides.idempotencyKey ?? `queue-${overrides.id}`,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
    ...('usageByCat' in overrides ? { usageByCat: overrides.usageByCat } : {}),
    ...('usageRecordedAt' in overrides ? { usageRecordedAt: overrides.usageRecordedAt } : {}),
  };
}

function makeMessage(invocationId, catId, usage, opts = {}) {
  return {
    id: opts.id ?? `msg-${invocationId}-${catId}`,
    threadId: opts.threadId ?? 'thread-1',
    userId: opts.userId ?? 'user-1',
    catId,
    content: '',
    mentions: [],
    metadata: { provider: 'p', model: opts.model ?? 'm', usage },
    extra: { stream: { invocationId } },
    timestamp: opts.timestamp ?? Date.now(),
  };
}

describe('indexMessagesByInvocation', () => {
  test('groups messages by parent invocationId, only when metadata.usage is present', () => {
    const messages = [
      makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 }),
      makeMessage('inv-1', 'codex', { inputTokens: 200, outputTokens: 20 }),
      makeMessage('inv-2', 'opus', { inputTokens: 50, outputTokens: 5 }),
      // No metadata.usage — must be ignored
      {
        id: 'noisy',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        content: 'text only',
        mentions: [],
        extra: { stream: { invocationId: 'inv-1' } },
        timestamp: 0,
      },
      // No extra.stream.invocationId — must be ignored
      {
        id: 'orphan',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        content: 'no parent',
        mentions: [],
        metadata: { provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } },
        timestamp: 0,
      },
    ];

    const index = indexMessagesByInvocation(messages);
    assert.equal(index.size, 2);
    assert.equal(index.get('inv-1').length, 2);
    assert.equal(index.get('inv-2').length, 1);
  });
});

describe('planBackfill', () => {
  test('skips records that are not succeeded', () => {
    const now = Date.now();
    const messages = [makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({ id: 'inv-1', createdAt: now - DAY_MS, status: 'running' }),
      makeInvocation({ id: 'inv-2', createdAt: now - DAY_MS, status: 'failed' }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.summary.succeededTotal, 0);
    assert.equal(plan.summary.orphanCandidates, 0);
  });

  test('skips records that already have usageByCat', () => {
    const now = Date.now();
    const messages = [makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-1',
        createdAt: now - DAY_MS,
        usageByCat: { opus: { inputTokens: 1, outputTokens: 1 } },
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.summary.succeededTotal, 1);
    assert.equal(plan.summary.orphanCandidates, 0);
  });

  test('treats empty usageByCat as backfillable', () => {
    const now = Date.now();
    const messages = [makeMessage('inv-empty', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-empty',
        createdAt: now - DAY_MS,
        usageByCat: {},
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].invocationId, 'inv-empty');
    assert.equal(plan.summary.succeededTotal, 1);
    assert.equal(plan.summary.orphanCandidates, 1);
    assert.equal(plan.summary.recoverable, 1);
  });

  test('skips records outside the window cutoff', () => {
    const now = Date.now();
    const messages = [makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: now - 30 * DAY_MS })];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.summary.orphanCandidates, 0);
  });

  test('uses usage anchor, not createdAt, for the backfill window cutoff', () => {
    const now = Date.now();
    const oldCreatedAt = now - 30 * DAY_MS;
    const retriedSucceededAt = now - DAY_MS;
    const messages = [makeMessage('inv-retry', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-retry',
        createdAt: oldCreatedAt,
        updatedAt: retriedSucceededAt,
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].invocationId, 'inv-retry');
    assert.equal(plan.entries[0].usageRecordedAt, retriedSucceededAt);
    assert.equal(plan.summary.orphanCandidates, 1);
  });

  test('uses existing usageRecordedAt as the usage anchor when present', () => {
    const now = Date.now();
    const oldCreatedAt = now - 30 * DAY_MS;
    const existingUsageAnchor = now - 2 * DAY_MS;
    const messages = [makeMessage('inv-empty', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-empty',
        createdAt: oldCreatedAt,
        updatedAt: now - DAY_MS,
        usageByCat: {},
        usageRecordedAt: existingUsageAnchor,
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].usageRecordedAt, existingUsageAnchor);
    assert.equal(plan.entries[0].date, new Date(existingUsageAnchor).toISOString().slice(0, 10));
  });

  test('recoverable: aggregates messages, anchors usageRecordedAt to invocation.updatedAt', () => {
    const now = Date.now();
    const invCreatedAt = now - 2 * DAY_MS;
    const invUpdatedAt = invCreatedAt + 30_000;
    // Message timestamps may be stream-start timestamps; invocation.updatedAt is the
    // closest persisted analog to the live writer's succeeded update time.
    const earlyTs = invCreatedAt + 5_000;
    const midTs = invCreatedAt + 12_000;
    const lateTs = invCreatedAt + 28_000;
    const messages = [
      makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 }, { timestamp: earlyTs }),
      makeMessage('inv-1', 'opus', { inputTokens: 50, outputTokens: 5 }, { id: 'msg-second', timestamp: midTs }),
      makeMessage('inv-1', 'codex', { inputTokens: 200, outputTokens: 20 }, { timestamp: lateTs }),
    ];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: invCreatedAt, updatedAt: invUpdatedAt })];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    const [entry] = plan.entries;
    assert.equal(entry.invocationId, 'inv-1');
    assert.equal(entry.usageRecordedAt, invUpdatedAt, 'anchor should use invocation completion/update time');
    assert.equal(entry.date, new Date(invUpdatedAt).toISOString().slice(0, 10));
    assert.equal(entry.source, 'queue');
    assert.equal(entry.messageCount, 3);
    assert.equal(entry.usageByCat.opus.inputTokens, 150);
    assert.equal(entry.usageByCat.opus.outputTokens, 15);
    assert.equal(entry.usageByCat.codex.inputTokens, 200);
    assert.equal(entry.usageByCat.codex.outputTokens, 20);
  });

  test('cross-midnight invocation anchors to invocation.updatedAt, not message start timestamp', () => {
    // Reproduce the case 砚砚 flagged: invocation begins one calendar day and finishes
    // the next. The live writer would have stamped usageRecordedAt ≈ succeeded time,
    // which lands the row on the *finish* day. The backfill must preserve that.
    const now = Date.now();
    const yesterdayLateNight = Date.UTC(2026, 4, 30, 23, 50, 0); // 2026-05-30 23:50 UTC
    const todayEarlyMorning = Date.UTC(2026, 4, 31, 0, 15, 0); // 2026-05-31 00:15 UTC
    // Window of "now" doesn't matter for the cutoff guard — make it generous.
    const messages = [
      makeMessage('inv-cross', 'opus', { inputTokens: 100, outputTokens: 10 }, { timestamp: yesterdayLateNight }),
    ];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-cross',
        createdAt: yesterdayLateNight,
        updatedAt: todayEarlyMorning,
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 365 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    const [entry] = plan.entries;
    assert.equal(
      entry.usageRecordedAt,
      todayEarlyMorning,
      'anchor must follow invocation completion, not message start',
    );
    assert.equal(entry.date, '2026-05-31', 'cross-midnight rows must land on the finish day');
    assert.notEqual(entry.date, '2026-05-30', 'must NOT bucket onto the start day');
  });

  test('derives completion anchor from message duration when updatedAt was shifted by later maintenance', () => {
    const invocationStart = Date.UTC(2026, 4, 30, 23, 50, 0); // 2026-05-30 23:50 UTC
    const invocationDurationMs = 25 * 60 * 1000;
    const invocationFinished = Date.UTC(2026, 4, 31, 0, 15, 0); // 2026-05-31 00:15 UTC
    const maintenanceRepairAt = Date.UTC(2026, 5, 7, 12, 0, 0); // later userId repair touched updatedAt
    const messages = [
      makeMessage(
        'inv-maintained',
        'opus',
        { inputTokens: 100, outputTokens: 10, durationMs: invocationDurationMs },
        { timestamp: invocationStart },
      ),
    ];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-maintained',
        createdAt: invocationStart,
        updatedAt: maintenanceRepairAt,
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: Date.UTC(2026, 4, 1, 0, 0, 0) });
    assert.equal(plan.entries.length, 1);
    const [entry] = plan.entries;
    assert.equal(entry.usageRecordedAt, invocationFinished);
    assert.equal(entry.date, '2026-05-31');
    assert.notEqual(entry.usageRecordedAt, maintenanceRepairAt, 'maintenance updatedAt must not become usage date');
  });

  test('uses duration-derived completion anchor for the cutoff window, not maintenance updatedAt', () => {
    const invocationStart = Date.UTC(2026, 4, 30, 23, 50, 0);
    const invocationDurationMs = 25 * 60 * 1000;
    const maintenanceRepairAt = Date.UTC(2026, 5, 7, 12, 0, 0);
    const messages = [
      makeMessage(
        'inv-old-maintained',
        'opus',
        { inputTokens: 100, outputTokens: 10, durationMs: invocationDurationMs },
        { timestamp: invocationStart },
      ),
    ];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({
        id: 'inv-old-maintained',
        createdAt: invocationStart,
        updatedAt: maintenanceRepairAt,
      }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: Date.UTC(2026, 5, 1, 0, 0, 0) });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.summary.orphanCandidates, 0);
  });

  test('falls back to invocation.updatedAt when messages have no usable timestamp', () => {
    // Defensive path: legacy messages or imports may lack timestamps. We still must
    // produce a non-NaN anchor; updatedAt is the closest analog to succeeded time.
    const now = Date.now();
    const invUpdatedAt = now - DAY_MS;
    const messages = [makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 }, { timestamp: 0 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: invUpdatedAt - 60_000, updatedAt: invUpdatedAt })];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].usageRecordedAt, invUpdatedAt);
  });

  test('unrecoverable: no matching messages → entry skipped but counted', () => {
    const now = Date.now();
    const messageIndex = new Map();
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: now - DAY_MS })];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.summary.orphanCandidates, 1);
    assert.equal(plan.summary.unrecoverable, 1);
    assert.equal(plan.summary.recoverable, 0);
  });

  test('source classification covers queue-, connector-, mm-, history-import:, other', () => {
    const now = Date.now();
    const invCreatedAt = now - DAY_MS;
    const messages = [
      makeMessage('q', 'opus', { inputTokens: 1, outputTokens: 1 }),
      makeMessage('c1', 'opus', { inputTokens: 1, outputTokens: 1 }),
      makeMessage('c2', 'opus', { inputTokens: 1, outputTokens: 1 }),
      makeMessage('m', 'opus', { inputTokens: 1, outputTokens: 1 }),
      makeMessage('h', 'opus', { inputTokens: 1, outputTokens: 1 }),
      makeMessage('o', 'opus', { inputTokens: 1, outputTokens: 1 }),
    ];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [
      makeInvocation({ id: 'q', createdAt: invCreatedAt, idempotencyKey: 'queue-abc' }),
      makeInvocation({ id: 'c1', createdAt: invCreatedAt, idempotencyKey: 'connector-msg-1' }),
      makeInvocation({ id: 'c2', createdAt: invCreatedAt, idempotencyKey: 'connector:lark:xyz' }),
      makeInvocation({ id: 'm', createdAt: invCreatedAt, idempotencyKey: 'mm-req-1-opus' }),
      makeInvocation({ id: 'h', createdAt: invCreatedAt, idempotencyKey: 'history-import:s:42' }),
      makeInvocation({ id: 'o', createdAt: invCreatedAt, idempotencyKey: 'random' }),
    ];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    const bySource = plan.summary.bySource;
    assert.equal(bySource.queue, 1);
    assert.equal(bySource.connector, 2);
    assert.equal(bySource['multi-mention'], 1);
    assert.equal(bySource['history-import'], 1);
    assert.equal(bySource.other, 1);
  });

  test('formatBackfillPreview is human-readable and stable', () => {
    const now = Date.now();
    const invCreatedAt = now - DAY_MS;
    const messages = [makeMessage('inv-1', 'opus', { inputTokens: 10, outputTokens: 1 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: invCreatedAt })];
    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    const out = formatBackfillPreview(plan, { dryRun: true });
    assert.match(out, /DRY-RUN/);
    assert.match(out, /recoverable: {9}1/);
    assert.match(out, /queue: 1/);
  });
});

// 砚砚 cloud review P1-B (PR #847): regression coverage for the race-safe
// pre-write guard. The planner builds entries from a SCAN snapshot; by the
// time applyPlan reaches each entry, a concurrent writer may have populated
// usageByCat or moved the record off 'succeeded'. decideApplyOutcome MUST NOT
// return 'apply' in those windows.
describe('apply-time race-safe guard', () => {
  function makeEntry(overrides = {}) {
    return {
      invocationId: 'inv-1',
      threadId: 'thread-1',
      date: '2026-06-02',
      usageRecordedAt: 1_770_000_000_000,
      source: 'queue',
      usageByCat: { opus: { inputTokens: 100, outputTokens: 10 } },
      messageCount: 1,
      ...overrides,
    };
  }

  function makeRecord(overrides = {}) {
    return {
      id: 'inv-1',
      threadId: 'thread-1',
      userId: 'user-1',
      userMessageId: null,
      targetCats: ['opus'],
      intent: 'execute',
      status: 'succeeded',
      idempotencyKey: 'queue-abc',
      createdAt: 1_770_000_000_000,
      updatedAt: 1_770_000_000_001,
      ...overrides,
    };
  }

  test('record disappeared since plan → skip-missing', () => {
    const out = decideApplyOutcome(makeEntry(), null);
    assert.equal(out.kind, 'skip-missing');
    assert.match(out.reason, /disappeared/);
  });

  test('status moved away from succeeded → skip-status', () => {
    for (const status of ['running', 'failed', 'canceled', 'queued']) {
      const out = decideApplyOutcome(makeEntry(), makeRecord({ status }));
      assert.equal(out.kind, 'skip-status', `status=${status}`);
      assert.match(out.reason, new RegExp(status));
    }
  });

  test('concurrent writer populated usageByCat → skip-populated (no overwrite)', () => {
    const record = makeRecord({
      usageByCat: {
        opus: { inputTokens: 999_999, outputTokens: 999, costUsd: 1.23 },
      },
      usageRecordedAt: 1_770_000_500_000,
    });
    const out = decideApplyOutcome(makeEntry(), record);
    assert.equal(out.kind, 'skip-populated');
    assert.match(out.reason, /concurrent writer/);
  });

  test('empty usageByCat object is treated as not populated → apply proceeds', () => {
    // Defensive: a record could in principle hold an empty object. Guard against
    // accidentally reading `{}` as "already populated" — that would lock the
    // backfill out forever once any partial write left an empty map behind.
    const record = makeRecord({ usageByCat: {} });
    const out = decideApplyOutcome(makeEntry(), record);
    assert.equal(out.kind, 'apply');
  });

  test('all guards pass → apply', () => {
    const out = decideApplyOutcome(makeEntry(), makeRecord());
    assert.equal(out.kind, 'apply');
    assert.equal(out.reason, undefined);
  });

  test('CAS mismatch after pre-read is skipped, not failed', async () => {
    const updateCalls = [];
    const store = {
      get: async () => makeRecord(),
      update: async (id, input) => {
        updateCalls.push({ id, input });
        return null;
      },
    };
    const plan = {
      entries: [makeEntry()],
      summary: {
        totalInvocations: 1,
        succeededTotal: 1,
        orphanCandidates: 1,
        recoverable: 1,
        unrecoverable: 0,
        byDate: { '2026-06-02': 1 },
        bySource: { queue: 1 },
      },
    };

    const stats = await applyPlan(plan, store);

    assert.equal(stats.applied, 0);
    assert.equal(stats.skippedCas, 1);
    assert.equal(stats.failed, 0);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].input.expectedStatus, 'succeeded');
    assert.equal(updateCalls[0].input.expectedUsageByCatAbsent, true);
  });
});
