import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageSearchResponseSchema } from '@cat-cafe/shared';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { boundMessageSearchResponse } from '../../dist/domains/memory/message-search-budget.js';

const response = (qualification) => ({
  searchId: 'frozen-search',
  query: 'neutral topic',
  results: [],
  meta: {
    scope: 'global',
    sort: 'time',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: true,
    hasMore: false,
    candidateLimit: 2000,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    ...(qualification ? { qualification } : {}),
    response: { budgetChars: 24000, serializedChars: 0, truncated: false, continuation: 'unavailable' },
  },
});

test('the bounded wire puts unassessed coverage before results without publishing candidates', () => {
  const source = response({
    status: 'partial',
    examined: 1953,
    supported: 0,
    rejected: 0,
    indeterminate: 0,
    unassessed: 1953,
  });
  const original = structuredClone(source);
  const result = boundMessageSearchResponse(source);
  const wire = JSON.stringify(result);
  assert.equal(Object.keys(result)[0], 'notice');
  assert.match(result.notice.summary, /全部尚未评估/);
  assert.match(result.notice.summary, /不能.*历史没有/);
  assert.equal(result.notice.counts.assessed, 0);
  assert.equal(result.notice.counts.candidates, 1953);
  assert.match(result.notice.nextStep, /已有.*日期.*对话.*原词/);
  assert.doesNotMatch(result.notice.nextStep, /打开/);
  assert.deepEqual(result.results, []);
  assert.equal(result.meta.response.serializedChars, wire.length);
  assert.ok(wire.length <= 24000);
  assert.deepEqual(source, original);
});

test('candidate counts are not assessed counts, indeterminate is separate, and legacy meta remains unknown', () => {
  const mixed = boundMessageSearchResponse(
    response({ status: 'partial', examined: 362, supported: 0, rejected: 7, indeterminate: 2, unassessed: 353 }),
  );
  assert.deepEqual(mixed.notice.counts, {
    candidates: 362,
    assessed: 9,
    supported: 0,
    rejected: 7,
    indeterminate: 2,
    unassessed: 353,
  });
  assert.match(mixed.notice.summary, /不能.*历史没有/);
  assert.match(boundMessageSearchResponse(response()).notice.summary, /未知/);
  const empty = boundMessageSearchResponse(
    response({ status: 'complete', examined: 0, supported: 0, rejected: 0, indeterminate: 0, unassessed: 0 }),
  );
  assert.match(empty.notice.summary, /未取得.*候选/);
  const rejected = boundMessageSearchResponse(
    response({ status: 'complete', examined: 9, supported: 0, rejected: 9, indeterminate: 0, unassessed: 0 }),
  );
  assert.match(rejected.notice.summary, /本次.*9.*不支持/);
  assert.doesNotMatch(rejected.notice.summary, /尚未评估/);
});

test('the owner exposes only aggregate batch lifecycle, distinguishing no start, cancellation and literal support', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const rows = [
    { threadId: 'PRIVATE-THREAD', messageId: 'PRIVATE-ID', content: 'plain body', contentRevision: 'PRIVATE-REV' },
  ];
  const qualifier = new MessageQueryQualifier(async (_batch, ctx) => {
    await new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    return '{}';
  });
  const stopped = await qualifier.qualify('different topic', rows, { userId: 'owner', deadlineAt: Date.now() + 1000 });
  assert.deepEqual(stopped.meta.batches, { started: 0, completed: 0, cancelled: 0, failed: 0 });
  const pending = qualifier.qualify('different topic', rows, { userId: 'owner', deadlineAt: Date.now() + 3000 });
  t.mock.timers.tick(1000);
  const cancelled = await pending;
  assert.deepEqual(cancelled.meta.batches, { started: 1, completed: 0, cancelled: 1, failed: 0 });
  assert.equal(cancelled.meta.unassessed, 1);
  assert.doesNotMatch(JSON.stringify(cancelled.meta), /PRIVATE/);
  const literal = await qualifier.qualify('plain', rows, { userId: 'owner', deadlineAt: Date.now() + 3000 });
  assert.equal(literal.meta.supported, 1);
  assert.equal(literal.meta.unassessed, 0);
  assert.equal(literal.nativeCalls, 0);
  assert.deepEqual(literal.meta.batches, { started: 0, completed: 0, cancelled: 0, failed: 0 });
});

test('whole-row budget truncation recomputes the explanation and preserves optional schema compatibility', () => {
  const input = response({
    status: 'complete',
    examined: 1,
    supported: 1,
    rejected: 0,
    indeterminate: 0,
    unassessed: 0,
  });
  const text = 'canonical original '.repeat(1500);
  input.results = [
    {
      threadId: 'visible',
      messageId: 'large',
      threadTitle: 'Original',
      speaker: 'user',
      timestamp: 1000,
      timelineOrderAt: 1000,
      snippet: { text, start: 0, end: text.length, source: 'body' },
      highlights: [],
      match: 'lexical',
      contentRevision: 'same',
      publiclyQuotable: true,
    },
  ];
  const result = boundMessageSearchResponse(input);
  assert.equal(result.results.length, 0);
  assert.equal(result.meta.response.truncated, true);
  assert.match(result.notice.coverage, /预算/);
  assert.doesNotMatch(result.notice.nextStep, /打开/);
  assert.ok(JSON.stringify(result).length <= 24000);
  assert.equal(result.meta.response.serializedChars, JSON.stringify(result).length);
  assert.equal(messageSearchResponseSchema.safeParse(result).success, true);
  assert.equal(messageSearchResponseSchema.safeParse(response()).success, true);
});
