/**
 * Issue #845 — Backfill core (pure planning) tests.
 *
 * The planner is split out of the CLI so it can be exercised without a live Redis.
 * These tests pin the decision rules listed in core.ts (status guard, window guard,
 * already-populated skip, recoverable vs unrecoverable, usageRecordedAt anchoring).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { indexMessagesByInvocation, planBackfill, formatBackfillPreview } = await import(
  '../dist/scripts/backfill-usage-by-cat/core.js'
);

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

  test('skips records outside the window cutoff', () => {
    const now = Date.now();
    const messages = [makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 })];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: now - 30 * DAY_MS })];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.deepEqual(plan.entries, []);
    assert.equal(plan.summary.orphanCandidates, 0);
  });

  test('recoverable: aggregates messages, anchors usageRecordedAt to createdAt', () => {
    const now = Date.now();
    const invCreatedAt = now - 2 * DAY_MS;
    const messages = [
      makeMessage('inv-1', 'opus', { inputTokens: 100, outputTokens: 10 }),
      makeMessage('inv-1', 'opus', { inputTokens: 50, outputTokens: 5 }, { id: 'msg-second' }),
      makeMessage('inv-1', 'codex', { inputTokens: 200, outputTokens: 20 }),
    ];
    const messageIndex = indexMessagesByInvocation(messages);
    const invocations = [makeInvocation({ id: 'inv-1', createdAt: invCreatedAt })];

    const plan = planBackfill(invocations, messageIndex, { cutoffMs: now - 7 * DAY_MS });
    assert.equal(plan.entries.length, 1);
    const [entry] = plan.entries;
    assert.equal(entry.invocationId, 'inv-1');
    assert.equal(entry.usageRecordedAt, invCreatedAt);
    assert.equal(entry.date, new Date(invCreatedAt).toISOString().slice(0, 10));
    assert.equal(entry.source, 'queue');
    assert.equal(entry.messageCount, 3);
    assert.equal(entry.usageByCat.opus.inputTokens, 150);
    assert.equal(entry.usageByCat.opus.outputTokens, 15);
    assert.equal(entry.usageByCat.codex.inputTokens, 200);
    assert.equal(entry.usageByCat.codex.outputTokens, 20);
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
