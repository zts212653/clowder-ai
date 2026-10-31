import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchProposedActionInputSchema } from '@cat-cafe/shared';
import {
  ACTION_TERMINAL_CAPABILITY_REGISTRY,
  canonicalizeActionTerminalPredicate,
} from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';

test('plugin removal leaves ordinary Task completion without a GitHub review admission protocol', () => {
  assert.deepEqual(
    ACTION_TERMINAL_CAPABILITY_REGISTRY.map(({ kind }) => kind),
    ['task_done'],
  );
  const predicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: 'subject:task:work',
    predicate: { kind: 'task_done' },
  });
  assert.equal(predicate.freshnessKey, 'task:work');
  const review = {
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    subjectRef: 'pr:owner/repo#1',
    terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
  };
  assert.equal(dispatchProposedActionInputSchema.safeParse(review).success, false);
  assert.throws(
    () => canonicalizeActionTerminalPredicate({ ...review, predicate: review.terminalPredicate }),
    /not allowed/,
  );
});
