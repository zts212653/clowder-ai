import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ContentModificationRecord } from '@cat-cafe/shared';
import { readModificationExecution } from '../src/domains/collaborative-content/modification/execution-view.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';

test('execution projection consumes the exact canonical child and rejects missing/foreign/unrelated child facts', async (t) => {
  const f = createPersistedQueueFixture();
  t.after(() => f.close());
  const receiptRef = 'review-receipt:execution';
  const record: ContentModificationRecord = {
    requestId: 'request',
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      operationId: crypto.randomUUID(),
      targetCatId: 'codex-astra',
      threadId: 'thread',
      intent: { body: '修改原文' },
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
        reviewId: 'file-review',
        expectedReviewRevision: 1,
      },
    },
    progress: {
      task: { taskId: 'task', revision: 1, receiptRef: 'task-receipt' },
      review: { reviewId: 'review', receiptRef },
    },
  };
  const delivered = await f.delivery.deliver({
    ownerAuthProvenance: 'strict',
    ownerUserId: 'operator',
    threadId: 'thread',
    targetCatId: 'codex-astra',
    idempotencyKey: `f309-return:${createHash('sha256').update(receiptRef).digest('hex')}`,
    content: '原修改请求',
    source: {
      connector: 'content-review',
      label: '作品修改',
      icon: 'cat-cafe',
      meta: { reviewReceiptRef: receiptRef, taskId: 'task' },
    },
  });
  assert.ok(delivered.message);
  const childId = await f.waitForAwakening(delivered.message.id);
  const child = f.turns.get(childId)!;
  assert.notEqual(child.invocationId, child.parentInvocationId);
  const actual = await readModificationExecution({ messages: f.messages, turnExecutions: f.turns }, record);
  assert.equal(actual?.parentInvocationId, child.parentInvocationId);
  assert.equal(actual?.queueEntryId, delivered.message.queueCustody?.entryId);
  assert.equal(
    (await readModificationExecution({ messages: f.messages, turnExecutions: f.turns }, record))?.state,
    'running',
  );
  for (const returned of [
    null,
    { ...child, userId: 'other' },
    { ...child, catId: 'other' as typeof child.catId },
    { ...child, causal: { triggerMessageId: 'unrelated' } },
  ]) {
    const view = await readModificationExecution(
      { messages: f.messages, turnExecutions: { get: () => returned } },
      record,
    );
    assert.equal(view?.state, 'unknown', 'an admitted queue is not evidence of a matching running child');
    assert.equal(view?.parentInvocationId, undefined, 'a foreign/unrelated child must not provide a stop target');
  }
  assert.equal((await readModificationExecution({ messages: f.messages }, record))?.state, 'unknown');
  f.turns.transitionTerminal(childId, { status: 'succeeded', endedAt: Date.now() });
  assert.equal(
    (await readModificationExecution({ messages: f.messages, turnExecutions: f.turns }, record))?.state,
    'finished',
  );
  delivered.message.source!.meta!.reviewReceiptRef = 'foreign-receipt';
  assert.equal(await readModificationExecution({ messages: f.messages, turnExecutions: f.turns }, record), undefined);
});
