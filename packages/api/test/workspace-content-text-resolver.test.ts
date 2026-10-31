import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceTextDigest } from '../src/domains/workspace/workspace-content-source-utils.js';
import {
  resolveWorkspaceTextQuote,
  resolveWorkspaceTextQuoteBatch,
} from '../src/domains/workspace/workspace-content-text-resolver.js';

test('bounded text matching fails closed instead of retaining an unbounded candidate list', () => {
  const repeated = 'a'.repeat(1_000_000);
  const resolution = resolveWorkspaceTextQuote({
    text: repeated,
    quote: 'a',
    expectedContextDigest: workspaceTextDigest('no matching context'),
    candidateBudget: 2,
  });
  assert.equal(resolution.status, 'ambiguous');
});

test('batch matching shares a total candidate budget across distinct raw quotes', () => {
  const results = resolveWorkspaceTextQuoteBatch({
    text: `${'a'.repeat(8)}${'b'.repeat(8)}`,
    sourceRevision: 'current-revision',
    candidateBudget: 2,
    anchors: [
      {
        annotationId: 'annotation-a',
        baseRevision: 'older-revision',
        quote: 'a',
        expectedContextDigest: workspaceTextDigest('no matching context a'),
      },
      {
        annotationId: 'annotation-b',
        baseRevision: 'older-revision',
        quote: 'b',
        expectedContextDigest: workspaceTextDigest('no matching context b'),
      },
    ],
  });

  assert.deepEqual(
    results.map((result) => [result.annotationId, result.status]),
    [
      ['annotation-a', 'ambiguous'],
      ['annotation-b', 'ambiguous'],
    ],
  );
});

test('batch matching bounds total source-scan work across distinct absent quotes', () => {
  const results = resolveWorkspaceTextQuoteBatch({
    text: 'a'.repeat(64),
    sourceRevision: 'current-revision',
    scanBudget: 64,
    anchors: [
      {
        annotationId: 'annotation-first',
        baseRevision: 'older-revision',
        quote: 'z',
      },
      {
        annotationId: 'annotation-second',
        baseRevision: 'older-revision',
        quote: 'y',
      },
    ],
  });

  assert.deepEqual(
    results.map((result) => [result.annotationId, result.status]),
    [
      ['annotation-first', 'orphaned'],
      ['annotation-second', 'ambiguous'],
    ],
  );
});
