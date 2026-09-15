import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-delivery-'));
  await writeFile(
    join(root, 'review-input.png'),
    await sharp({ create: { width: 200, height: 120, channels: 3, background: '#aa7259' } })
      .png()
      .toBuffer(),
  );
  const f = await createLiveReviewFixture(root);
  t.after(async () => {
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  let view = await f.reviews.prepare(f.prepare, f.human);
  view = (
    await f.reviews.act(
      {
        reviewId: view.review.reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 1,
        round: 1,
        operationId: 'request-final-judgment',
        action: { kind: 'request_judgment', summary: '封面完成', judgmentNeeded: '请确认发布' },
      },
      f.cat,
    )
  ).view;
  const decision = {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: 1,
    round: 1,
    operationId: 'accept-cover',
    action: { kind: 'decide', outcome: 'approved', explanation: '这版通过，请继续原任务。' },
  };
  return { ...f, view, decision };
}

test('F310 reads the real content owner; one committed decision returns to the same owner queue and typed Task closure', async (t) => {
  const f = await fixture(t);
  const needed = await f.ownerReads.listNeedsMeForOwner('operator');
  assert.equal(needed.length, 1);
  assert.match(needed[0]?.preparedArtifact?.openInWorkspaceRef ?? '', /^workspace:content-review:/);
  const accepted = await f.reviews.act(f.decision, f.human);
  await f.changed('operator', f.view.review.reviewId);
  const delivery = f.store.returns.get(accepted.receipt.receiptRef);
  assert.equal(delivery?.state, 'queued');
  assert.ok(delivery?.messageId);
  const message = f.messages.getById(delivery.messageId);
  await f.dispatch.waitForAwakening(delivery.messageId);
  assert.equal(f.starts.length, 1);
  assert.equal(message?.source?.connector, 'content-review');
  assert.equal(message?.threadId, f.thread.id);
  assert.deepEqual(message?.mentions, ['codex-astra']);
  assert.match(message?.content ?? '', new RegExp(f.taskId));
  await f.reviews.act(f.decision, f.human);
  await f.dispatcher.drain();
  assert.equal(f.starts.length, 1);
  assert.equal((await f.ownerReads.listNeedsMeForOwner('operator')).length, 0);
  const before = f.tasks.get(f.taskId);
  assert.ok(before?.entrustedWork);
  assert.notEqual(before.status, 'done');
  const closed = await f.lifecycle.close({
    taskId: f.taskId,
    expectedRevision: before.entrustedWork.revision,
    closure: {
      state: 'satisfied',
      condition: before.entrustedWork.closure.condition,
      expectedSignal: before.entrustedWork.closure.expectedSignal,
      evidenceRefs: [accepted.receipt.receiptRef, `message:${f.thread.id}:${f.publication.id}`],
    },
  });
  assert.equal(closed.id, f.taskId);
  assert.equal(closed.status, 'done');
  assert.equal((await f.reviews.read(f.view.review.reviewId, f.human)).authority.state, 'task_closed');
});

test('a crash after durable carrier append cannot enqueue a second owner invocation on recovery', async (t) => {
  const f = await fixture(t);
  const accepted = await f.reviews.act(f.decision, f.human);
  const mark = f.store.returns.queued.bind(f.store.returns);
  f.store.returns.queued = () => {
    throw new Error('receipt mark crash');
  };
  await assert.rejects(f.dispatcher.drain(), /durably pending/);
  assert.equal(f.store.returns.pending().length, 1);
  const count = f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .filter((message) => message.source?.connector === 'content-review').length;
  assert.equal(count, 1);
  const carrier = f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .find((message) => message.source?.connector === 'content-review');
  assert.ok(carrier);
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  f.store.returns.queued = mark;
  await f.dispatcher.drain();
  assert.equal(f.store.returns.get(accepted.receipt.receiptRef)?.state, 'queued');
  assert.equal(f.starts.length, 1, 'recovery must drive the admitted carrier into the original owner queue');
  assert.equal(await f.dispatch.waitForAwakening(carrier.id), childId);
  await f.dispatcher.drain();
  assert.equal(f.starts.length, 1, 'an already reconciled return must not start another owner invocation');
  assert.equal(
    f.messages
      .getByThreadIncludingQueued(f.thread.id)
      .filter((message) => message.source?.connector === 'content-review').length,
    1,
  );
});

test('a rejected foreign-thread owner read never enumerates the producer catalog', async (t) => {
  const f = await fixture(t);
  let enumerations = 0;
  const list = f.catalog.listCurrentReceipts.bind(f.catalog);
  f.catalog.listCurrentReceipts = async (ownerUserId) => {
    enumerations += 1;
    return list(ownerUserId);
  };
  await assert.rejects(
    f.ownerReads.read({
      taskId: f.taskId,
      viewer: { surface: 'cat', userId: 'operator', catId: 'codex-astra', threadId: 'foreign-thread' },
    }),
    /belongs to another thread/,
  );
  assert.equal(enumerations, 0);
});

test('catalog and owner reads project stale attention without mutating its review or audit', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.update({ taskId: f.taskId, expectedRevision: 1, status: 'doing' });
  const before = f.store.get(f.view.review.reviewId);
  const audit = f.store.history(f.view.review.reviewId);
  await assert.rejects(
    f.ownerReads.read({
      taskId: f.taskId,
      viewer: { surface: 'cat', userId: 'operator', catId: 'codex-astra', threadId: 'foreign-thread' },
    }),
    /belongs to another thread/,
  );
  assert.deepEqual(f.store.get(f.view.review.reviewId), before, 'denied reads are inert');
  assert.deepEqual(await f.catalog.listCurrentReceipts('operator'), []);
  const receipt = await f.producer.readCurrentReceipt({
    ownerUserId: 'operator',
    producerSubjectRef: f.view.review.reviewId,
  });
  assert.equal(receipt?.eligible, false);
  await f.ownerReads.listForOwner('operator');
  await f.ownerReads.listNeedsMeForOwner('operator');
  assert.deepEqual(f.store.get(f.view.review.reviewId), before, 'authorized catalog reads are also inert');
  assert.deepEqual(f.store.history(f.view.review.reviewId), audit);
});

test('producer recovery retires stale attention and publishes one user-scoped projection invalidation', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.update({ taskId: f.taskId, expectedRevision: 1, status: 'doing' });
  f.events.length = 0;
  await f.recoverySpec.run.execute(null, 'artifact-review-recovery', {
    signal: new AbortController().signal,
    assignedCatId: null,
  });
  const review = f.store.get(f.view.review.reviewId);
  assert.equal(review?.rounds.at(-1)?.attentionRetiredReason, 'task_changed');
  const invalidations = () => f.events.filter((event) => event.event === 'entrusted_work_projection_invalidated');
  assert.deepEqual(invalidations(), [
    { userId: 'operator', event: 'entrusted_work_projection_invalidated', data: { ownerUserId: 'operator' } },
  ]);
  await f.recoverySpec.run.execute(null, 'artifact-review-recovery', {
    signal: new AbortController().signal,
    assignedCatId: null,
  });
  assert.deepEqual(f.store.get(f.view.review.reviewId), review);
  assert.equal(invalidations().length, 1, 'an unchanged recovery pass does not manufacture another owner change');
});

test('successful typed Task updates and closure invalidate only the owning user, while stale writes stay inert', async (t) => {
  const f = await fixture(t);
  f.events.length = 0;
  const updated = await f.lifecycle.update({ taskId: f.taskId, expectedRevision: 1, status: 'doing' });
  const notice = {
    userId: 'operator',
    event: 'entrusted_work_projection_invalidated',
    data: { ownerUserId: 'operator' },
  };
  assert.deepEqual(f.events, [notice]);
  await assert.rejects(
    f.lifecycle.update({ taskId: f.taskId, expectedRevision: 1, status: 'blocked' }),
    /revision is no longer current/,
  );
  assert.deepEqual(f.events, [notice]);
  assert.ok(updated.entrustedWork);
  await f.lifecycle.close({
    taskId: f.taskId,
    expectedRevision: updated.entrustedWork.revision,
    closure: {
      ...updated.entrustedWork.closure,
      state: 'satisfied',
      evidenceRefs: [`message:${f.thread.id}:${f.publication.id}`],
    },
  });
  assert.deepEqual(f.events, [notice, notice]);
  const history = await f.reviews.read(f.view.review.reviewId, f.human);
  assert.equal(history.authority.state, 'task_closed');
  assert.equal(history.review.rounds.length, 1, 'closing the Task preserves its review history');
});

test('the content reader never borrows human visibility for an unscoped cat or a withdrawn publication', async (t) => {
  const f = await fixture(t);
  const ownerRead = await f.ownerReads.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'operator' } });
  assert.ok(ownerRead.preparedArtifact);
  const input = {
    artifactRef: f.prepare.artifactRef,
    taskThreadId: f.thread.id,
    taskSubjectRef: `task:work:${f.taskId}`,
    taskOwnerRef: `task:item:${f.taskId}`,
    taskRevision: 1,
    ownerUserId: 'operator',
  };
  assert.equal(await f.artifactReader.readPreparedArtifact(input), null);
  assert.equal(
    await f.artifactReader.readPreparedArtifact({
      ...input,
      viewer: { surface: 'cat', userId: 'operator', threadId: 'another-thread', catId: 'codex-astra' },
    }),
    null,
  );
});
