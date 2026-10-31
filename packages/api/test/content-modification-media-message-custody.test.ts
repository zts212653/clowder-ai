import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

async function originalMessageReview(t: Parameters<typeof mediaMessageFixture>[0]) {
  const f = await mediaMessageFixture(t);
  assert.ok(f.ledgers);
  await writeFile(join(f.root, 'standalone.png'), await readFile(join(f.root, 'review-input.png')));
  const publication = f.publish('standalone.png');
  const asset = await f.media.prepare({
    principal: f.human,
    operationId: 'prepare-original-message-publication',
    source: {
      kind: 'message',
      threadId: f.thread.id,
      messageId: publication.id,
      messageRevision: String(publication.timestamp),
      expectedUrl: '/uploads/standalone.png',
      item: { kind: 'media-gallery', blockId: 'standalone.png', itemIndex: 0 },
    },
  });
  const ledger = await f.ledgers.prepare({
    principal: f.human,
    publication: asset,
    operationId: 'original-message-ledger',
  });
  const task = await f.lifecycle.update({
    taskId: f.taskId,
    expectedRevision: 1,
    artifactRefs: [`content:${asset.contentRef}`],
  });
  assert.ok(task.entrustedWork);
  const original = await f.reviews.prepare(
    {
      taskId: f.taskId,
      expectedTaskRevision: task.entrustedWork.revision,
      artifactRef: `content:${asset.contentRef}`,
      expectedArtifactRevision: String(asset.ownerRevision),
      operationId: 'original-message-task-review',
    },
    f.human,
  );
  assert.equal(original.review.rounds[0]?.ledgerRef, ledger.review.reviewId);
  assert.equal(f.store.requests.recentForProjection(100).length, 0);
  return { f, asset, ledger, original };
}

test('message-owned publication with an original linked review reuses that Task without a prior modification request', async (t) => {
  const { f, asset, ledger, original } = await originalMessageReview(t);
  const message = f.send({
    ...f.attachment,
    taskContext: undefined,
    source: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
      ledgerRef: ledger.review.reviewId,
      expectedLedgerRevision: ledger.review.revision,
    },
  });
  const count = f.tasks.listByThread(f.thread.id).length;
  const result = await f.takeOver(message.id);
  assert.equal(result.stage, 'queued', JSON.stringify(result.record.issue));
  assert.equal(
    result.record.progress.task?.taskId,
    f.taskId,
    'canonical original review is custody even before the first modification request',
  );
  assert.equal(result.record.progress.review?.reviewId, original.review.reviewId);
  assert.equal(f.tasks.listByThread(f.thread.id).length, count);
  assert.equal(
    (await f.integration.requests.takeOver({ sourceMessageId: message.id, operationId: randomUUID() }, f.cat)).record
      .requestId,
    result.record.requestId,
  );
});

test('multiple canonical Tasks for a message publication require explicit custody instead of guessing', async (t) => {
  const { f, asset, ledger } = await originalMessageReview(t);
  const authority = f.send();
  const admitted = await f.lifecycle.admitOrResume({
    task: {
      userId: 'operator',
      threadId: f.thread.id,
      ownerCatId: 'codex-astra',
      createdBy: 'user',
      title: '另一个具名媒体责任',
      why: '独立审阅同一出版物',
    },
    admission: {
      basis: 'explicit_entrustment',
      idempotencyKey: randomUUID(),
      sourceRefs: [`message:${authority.id}`],
      intendedOutcome: '独立审阅本作品',
    },
    closure: { condition: '审阅本作品', expectedSignal: 'reviewed' },
    artifactRefs: [`content:${asset.contentRef}`],
  });
  assert.ok('subjectRef' in admitted && admitted.subjectRef);
  const taskId = admitted.subjectRef.replace(/^task:work:/, '');
  await f.reviews.prepare(
    {
      taskId,
      expectedTaskRevision: 1,
      artifactRef: `content:${asset.contentRef}`,
      expectedArtifactRevision: String(asset.ownerRevision),
      operationId: 'second-original-review',
    },
    f.human,
  );
  const message = f.send({
    ...f.attachment,
    taskContext: undefined,
    source: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
      ledgerRef: ledger.review.reviewId,
      expectedLedgerRevision: ledger.review.revision,
    },
  });
  const count = f.tasks.listByThread(f.thread.id).length;
  await assert.rejects(f.takeOver(message.id), /task_changed/);
  assert.equal(f.tasks.listByThread(f.thread.id).length, count);
  assert.equal(f.store.requests.recentForProjection(100).length, 0);
});

test('overlong aggregate media instructions return a typed input error before request reservation', async (t) => {
  const f = await mediaMessageFixture(t);
  const selection = f.attachment.selections[0];
  assert.ok(selection);
  const message = f.send(
    { ...f.attachment, selections: [{ ...selection, instruction: '局'.repeat(1000) }] },
    '全'.repeat(3500),
  );
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': f.actor.invocationId, 'x-callback-token': f.actor.callbackToken },
    payload: { sourceMessageId: message.id, operationId: randomUUID() },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'invalid_patch');
  assert.equal(f.store.requests.recentForProjection(100).length, 0);
  assert.equal(f.store.get(f.attachment.taskContext?.reviewId ?? '')?.rounds[0]?.annotations.length, 0);
});
