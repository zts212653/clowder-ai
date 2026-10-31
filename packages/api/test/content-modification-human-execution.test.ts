import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { type ContentModificationRecord, contentModificationRequestCarrierV1Schema } from '@cat-cafe/shared';
import { deriveGrowingSourceMessageRevision } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { readModificationExecution } from '../src/domains/collaborative-content/modification/execution-view.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';

async function humanExecutionFixture() {
  const f = createPersistedQueueFixture();
  const human = await f.messages.append({
    userId: 'operator',
    threadId: 'thread',
    from: { kind: 'user', userId: 'operator' },
    mentions: ['codex61-sol'],
    content: '请按引用修改文档，先返回候选。',
    timestamp: Date.now(),
  });
  const receiptRef = 'review-receipt:human-execution';
  const record: ContentModificationRecord = {
    requestId: `f309-modification-${'a'.repeat(64)}`,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      operationId: randomUUID(),
      targetCatId: 'codex61-sol',
      threadId: 'thread',
      intent: { body: human.content },
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
        reviewId: 'file-review',
        expectedReviewRevision: 1,
      },
    },
    progress: {
      sourceKind: 'human_message',
      sourceMessageId: human.id,
      sourceMessageRevision: deriveGrowingSourceMessageRevision(human) as `sha256:${string}`,
      task: { taskId: 'task', revision: 1, receiptRef: 'task-receipt' },
      review: { reviewId: 'review', receiptRef },
    },
  };
  const delivered = await f.delivery.deliver({
    ownerAuthProvenance: 'strict',
    ownerUserId: 'operator',
    threadId: 'thread',
    targetCatId: 'codex61-sol',
    idempotencyKey: `f309-return:${createHash('sha256').update(receiptRef).digest('hex')}`,
    content: '原修改请求',
    source: {
      connector: 'content-review',
      label: '作品修改',
      icon: 'cat-cafe',
      meta: {
        v: 1,
        kind: 'request_text_edit',
        requestId: record.requestId,
        sourceMessageId: human.id,
        targetCatId: record.payload.targetCatId,
        taskId: 'task',
        expectedTaskRevision: 1,
        requestReceiptRef: receiptRef,
      },
    },
  });
  assert.ok(delivered.message);
  contentModificationRequestCarrierV1Schema.parse(delivered.message.source?.meta);
  const childId = await f.waitForAwakening(delivered.message.id);
  const child = f.turns.get(childId);
  assert.ok(child);
  // The recorded Alpha same-turn fact covers the triggering Human, not the derived Host carrier.
  const sameTurn = { ...child, causal: { triggerMessageId: human.id, coveredMessageIds: [human.id] } };
  return { ...f, human, record, carrier: delivered.message, child, sameTurn };
}

test('Human takeover projects the current canonical same-turn execution, including cancellation, without candidate inference', async (t) => {
  const f = await humanExecutionFixture();
  t.after(() => f.close());
  for (const [status, state] of [
    ['running', 'running'],
    ['succeeded', 'finished'],
    ['canceled', 'cancelled'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
  ] as const) {
    const execution = { ...f.sameTurn, status, ...(status === 'running' ? {} : { endedAt: Date.now() }) };
    const view = await readModificationExecution(
      { messages: f.messages, turnExecutions: { get: () => execution } },
      f.record,
    );
    assert.equal(view?.state, state, `the canonical ${status} child covers the request's original Human`);
    assert.equal(view?.invocationId, execution.invocationId);
    assert.equal(view?.parentInvocationId, execution.parentInvocationId);
    assert.equal(view?.messageId, f.carrier.id, 'native queue withdrawal still names the actual carrier');
    assert.equal(view?.evidenceRef, `turn-execution:${execution.invocationId}`);
  }
});

test('Human execution binding retains owner/thread/cat/coverage and exact request-carrier fences', async (t) => {
  const f = await humanExecutionFixture();
  t.after(() => f.close());
  for (const foreign of [
    { ...f.sameTurn, userId: 'other' },
    { ...f.sameTurn, threadId: 'other' },
    { ...f.sameTurn, catId: 'codex-astra' as typeof f.sameTurn.catId },
    { ...f.sameTurn, causal: { triggerMessageId: 'other', coveredMessageIds: ['other'] } },
  ]) {
    const view = await readModificationExecution(
      { messages: f.messages, turnExecutions: { get: () => foreign } },
      f.record,
    );
    assert.equal(view?.state, 'unknown');
    assert.equal(view?.parentInvocationId, undefined, 'invalid evidence supplies no native stop target');
  }
  const source = f.carrier.source;
  assert.ok(source);
  const meta = source.meta;
  assert.ok(meta);
  for (const patch of [
    { sourceMessageId: 'other-human' },
    { requestId: 'other-request' },
    { taskId: 'other-task' },
    { targetCatId: 'codex-astra' },
    { expectedTaskRevision: 2 },
    { requestReceiptRef: 'other-receipt' },
  ]) {
    source.meta = { ...meta, ...patch };
    assert.equal(
      await readModificationExecution({ messages: f.messages, turnExecutions: { get: () => f.sameTurn } }, f.record),
      undefined,
    );
  }
  source.meta = meta;
  assert.ok(f.record.progress.review);
  source.meta = { reviewReceiptRef: f.record.progress.review.receiptRef, taskId: 'task' };
  assert.equal(
    (await readModificationExecution({ messages: f.messages, turnExecutions: { get: () => f.sameTurn } }, f.record))
      ?.state,
    'unknown',
    'a legacy carrier cannot attest original-Human coverage',
  );
  source.meta = meta;
  const generated = { ...f.record, progress: { ...f.record.progress, sourceKind: 'generated_request' as const } };
  assert.equal(
    (await readModificationExecution({ messages: f.messages, turnExecutions: { get: () => f.sameTurn } }, generated))
      ?.state,
    'unknown',
  );
});

test('a later carrier execution is selected without falling back to the earlier Human execution', async (t) => {
  const f = await humanExecutionFixture();
  t.after(() => f.close());
  const later = {
    ...f.child,
    invocationId: randomUUID(),
    causal: { triggerMessageId: f.carrier.id },
    status: 'running' as const,
  };
  const ref =
    f.carrier.lifecycle?.kind === 'input'
      ? f.carrier.lifecycle.dispatchRefs?.find((ref) => ref.targetId === f.child.catId)
      : undefined;
  assert.ok(ref);
  const receiver = f.messages.getById(ref.statusMessageId);
  assert.ok(receiver?.lifecycle?.kind === 'response');
  receiver.lifecycle.invocationId = later.invocationId;
  const messages = f.messages;
  const requested: string[] = [];
  const get = (id: string) => {
    requested.push(id);
    return later;
  };
  const view = await readModificationExecution({ messages, turnExecutions: { get } }, f.record);
  assert.equal(view?.state, 'running');
  assert.deepEqual(requested, [later.invocationId]);
  assert.equal(
    (await readModificationExecution({ messages, turnExecutions: { get: () => null } }, f.record))?.state,
    'unknown',
  );
});
