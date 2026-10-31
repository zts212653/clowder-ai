import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { type ArtifactReviewAction, type ArtifactReviewView, createCatId } from '@cat-cafe/shared';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

function command(view: ArtifactReviewView, action: ArtifactReviewAction) {
  const round = view.review.rounds.at(-1);
  assert.ok(round);
  return {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedLedgerRevision: round.ledgerRevision,
    expectedTaskRevision: view.authority.taskRevision,
    round: round.number,
    operationId: randomUUID(),
    action,
  };
}
function receipts(f: Awaited<ReturnType<typeof mediaMessageFixture>>) {
  return f.messages.getByThread(f.thread.id).filter((item) => item.extra?.contentModificationReceiptV1);
}

test('authenticated real media return and original-round human decisions project live exactly once and survive reopen', async (t) => {
  const f = await mediaMessageFixture(t);
  const request = await f.takeOver(f.send().id);
  const payload = await f.candidateCommand(request.record.requestId);
  const headers = { 'x-invocation-id': f.actor.invocationId, 'x-callback-token': f.actor.callbackToken };
  const returned = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/respond',
    headers,
    payload,
  });
  assert.equal(returned.statusCode, 200, returned.body);
  assert.deepEqual(
    receipts(f).map((message) => message.extra?.contentModificationReceiptV1?.state),
    ['candidate'],
  );
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/callbacks/artifact-review/respond', headers, payload }))
      .statusCode,
    200,
  );
  let view = await f.reviews.readCurrent(payload.reviewId, f.human);
  await f.lifecycle.update({
    taskId: f.taskId,
    expectedRevision: view.authority.taskRevision,
    artifactRefs: [view.continuation.artifactRef],
  });
  view = await f.reviews.readCurrent(payload.reviewId, f.cat);
  view = (
    await f.reviews.act(
      command(view, { kind: 'request_judgment', summary: '两处修改完成。', judgmentNeeded: '请确认本版。' }),
      f.cat,
    )
  ).view;
  await assert.rejects(
    f.reviews.act(
      { ...command(view, { kind: 'decide', outcome: 'approved', explanation: '过期轮不能通过' }), round: 1 },
      f.human,
    ),
    /asset_changed/,
  );
  const changes = command(view, { kind: 'decide', outcome: 'changes_requested', explanation: '第二处再改一下。' });
  view = (await f.reviews.act(changes, f.human)).view;
  assert.equal(
    (await f.reviews.act(changes, f.human)).receipt.receiptRef,
    view.review.rounds.at(-1)?.decision?.receiptRef,
  );
  view = (await f.reviews.act(command(view, { kind: 'reopen', explanation: '重新核对本版。' }), f.human)).view;
  view = (
    await f.reviews.act(
      command(view, { kind: 'request_judgment', summary: '本版可确认。', judgmentNeeded: '请确认。' }),
      f.cat,
    )
  ).view;
  const approved = await f.reviews.act(
    command(view, { kind: 'decide', outcome: 'approved', explanation: '本版通过。' }),
    f.human,
  );
  const before = receipts(f);
  assert.deepEqual(
    before.map((message) => message.extra?.contentModificationReceiptV1?.state),
    ['candidate', 'changes_requested', 'approved'],
  );
  const candidateRef = approved.view.review.rounds.at(-1)?.asset.ownerReceiptRef;
  for (const message of before) {
    assert.equal(message.extra?.contentModificationReceiptV1?.candidateRef, candidateRef);
    assert.deepEqual(message.extra?.contentModificationReceiptV1?.followUp, { kind: 'none', reason: 'not_applicable' });
    assert.deepEqual(message.mentions, []);
    assert.equal(message.replyTo, request.record.progress.sourceMessageId);
    assert.equal(message.source, undefined);
  }
  await f.integration.receipts.recover();
  assert.deepEqual(
    receipts(f).map((item) => item.id),
    before.map((item) => item.id),
  );
  assert.equal(
    f.tasks.get(f.taskId)?.entrustedWork?.closure.state,
    'open',
    'media decisions do not close the original Task',
  );
  assert.deepEqual(f.errors, []);
});

test('lost Host append recovers from canonical media operations; recalled source never emits a new Host record', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const request = await f.takeOver(message.id);
  const append = f.messages.appendIdempotent.bind(f.messages);
  let fail = true;
  f.messages.appendIdempotent = async (input) => {
    if (input.extra?.systemKind === 'content_modification_receipt' && fail)
      throw new Error('simulated Host append loss');
    return append(input);
  };
  const returned = await f.candidate(request.record.requestId);
  assert.equal(returned.view.review.rounds.length, 2);
  assert.equal(receipts(f).length, 0);
  assert.match(String(f.errors[0]), /Host append loss/);
  fail = false;
  message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
  await f.integration.receipts.recover();
  assert.equal(receipts(f).length, 0);
  delete message.recall;
  await f.integration.receipts.recover();
  assert.equal(receipts(f).length, 1);
  await f.integration.receipts.recover();
  assert.equal(receipts(f).length, 1);
});

test('selection join excludes older round annotations and rejects changed/private source coordinates', async (t) => {
  const f = await mediaMessageFixture(t);
  assert.ok(f.attachment.taskContext);
  const original = await f.reviews.readCurrent(f.attachment.taskContext.reviewId, f.human);
  const annotated = await f.reviews.act(
    command(original, {
      kind: 'annotate',
      annotationId: 'old-note',
      anchor: { kind: 'image-point', x: 2, y: 2 },
      body: '已有批注',
    }),
    f.human,
  );
  const attachment = {
    ...f.attachment,
    source: { ...f.attachment.source, expectedReviewRevision: annotated.view.review.revision },
    taskContext: { ...f.attachment.taskContext, expectedReviewRevision: annotated.view.review.revision },
  };
  const mixed = f.send(attachment);
  mixed.contentBlocks?.push({
    type: 'context_attachment',
    attachment: {
      ...attachment,
      id: 'other-version',
      source: { ...attachment.source, expectedReviewRevision: 99 },
      taskContext: { ...attachment.taskContext, expectedReviewRevision: 99 },
    },
  });
  await assert.rejects(f.takeOver(mixed.id), /invalid_patch/);
  const forged = f.send({ ...attachment, mediaType: 'video/mp4', selections: [] });
  await assert.rejects(f.takeOver(forged.id), /source_changed/);
  const message = f.send(attachment);
  const request = await f.takeOver(message.id);
  const round = f.store.get(request.record.progress.review?.reviewId ?? '')?.rounds[0];
  assert.equal(round?.annotations.length, 3);
  assert.deepEqual(
    request.selectionAnnotations?.map((item) => item.selectionId),
    ['1', '2'],
  );
  assert.ok(request.selectionAnnotations?.every((item) => item.annotationId !== 'old-note'));
  f.publication.visibility = 'whisper';
  f.publication.whisperTo = [createCatId('codex')];
  await assert.rejects(f.reviews.readCurrent(original.review.reviewId, f.cat), /access_denied/);
  message.whisperTo = [createCatId('codex')];
  await assert.rejects(f.takeOver(message.id), /not_found/);
  await assert.rejects(
    f.reviews.readCurrent(original.review.reviewId, {
      userId: 'stranger',
      actor: { kind: 'human', actorId: 'stranger' },
    }),
    /access_denied/,
  );
});

test('recall after canonical candidate lookup wins the final Host append authorization', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const request = await f.takeOver(message.id);
  const project = f.integration.receipts.projectMedia.bind(f.integration.receipts);
  f.integration.receipts.projectMedia = async () => {};
  await f.candidate(request.record.requestId);
  f.integration.receipts.projectMedia = project;
  const read = f.media.read.bind(f.media);
  f.media.read = async (...args) => {
    const asset = await read(...args);
    message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    return asset;
  };
  await f.integration.receipts.recover();
  assert.equal(receipts(f).length, 0);
});
