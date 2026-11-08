import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageSearchResponseSchema } from '@cat-cafe/shared';
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

test('historical qualification keeps aggregate batch states without reviving a runner or exposing private payloads', () => {
  for (const batches of [
    { started: 0, completed: 0, cancelled: 0, failed: 0 },
    { started: 1, completed: 0, cancelled: 1, failed: 0 },
    { started: 2, completed: 1, cancelled: 0, failed: 1 },
  ]) {
    const saved = messageSearchResponseSchema.parse(
      response({
        status: 'partial',
        examined: 1,
        supported: 0,
        rejected: 0,
        indeterminate: 0,
        unassessed: 1,
        batches,
        privatePayload: 'PRIVATE OLD RUNNER OUTPUT',
      }),
    );
    const wire = boundMessageSearchResponse(saved);
    assert.deepEqual(wire.meta.qualification.batches, batches);
    assert.equal(wire.meta.qualification.unassessed, 1);
    assert.doesNotMatch(JSON.stringify(wire), /PRIVATE/);
  }
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
