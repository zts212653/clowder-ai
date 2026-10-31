import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

test('real Human media takeover keeps both PNG ranges and the original Task in one request', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const before = await readFile(join(f.root, 'review-input.png'));
  const tasks = f.tasks.listByThread(f.thread.id).length;
  const result = await f.takeOver(message.id);
  assert.equal(result.stage, 'queued');
  assert.equal(result.record.progress.sourceMessageId, message.id);
  assert.equal(result.record.progress.sourceKind, 'human_message');
  assert.equal(result.record.progress.task?.taskId, f.taskId);
  assert.equal(f.tasks.listByThread(f.thread.id).length, tasks);
  const round = f.store.get(result.record.progress.review?.reviewId ?? '')?.rounds[0];
  assert.deepEqual(
    round?.annotations.map((item) => item.anchor),
    f.attachment.selections.map((item) => item.selection),
  );
  assert.deepEqual(
    round?.annotations.map((item) => item.body),
    f.attachment.selections.map((item) => item.instruction),
  );
  assert.ok(result.delivery?.messageId);
  assert.equal(f.store.returns.get(result.record.progress.review?.receiptRef ?? '')?.state, 'queued');
  const replay = await f.takeOver(message.id);
  assert.equal(replay.record.requestId, result.record.requestId);
  assert.equal(replay.delivery?.messageId, result.delivery?.messageId);
  assert.equal(f.messages.getById(message.id)?.content, message.content);
  assert.equal(
    f.messages.getByThread(f.thread.id).filter((item) => item.from?.kind === 'user' && item.from.userId === 'operator')
      .length,
    1,
  );
  assert.deepEqual(await readFile(join(f.root, 'review-input.png')), before);
});

test('whole image, stale source, invalid second range and recall-before-takeover use canonical media identity', async (t) => {
  const f = await mediaMessageFixture(t);
  assert.ok(f.attachment.taskContext);
  const stale = f.send({
    ...f.attachment,
    source: { ...f.attachment.source, expectedReviewRevision: 99 },
    taskContext: { ...f.attachment.taskContext, expectedReviewRevision: 99 },
  });
  await assert.rejects(f.takeOver(stale.id), /source_changed/);
  const firstSelection = f.attachment.selections[0];
  assert.ok(firstSelection);
  const wrong = f.send({
    ...f.attachment,
    selections: [firstSelection, { id: 'bad', selection: { kind: 'image-point', x: 170, y: 10 } }],
  });
  await assert.rejects(f.takeOver(wrong.id), /invalid_anchor/);
  assert.equal(f.store.get(f.attachment.taskContext?.reviewId ?? '')?.revision, 1);
  const removed = f.send();
  removed.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
  await assert.rejects(f.takeOver(removed.id), /not_found/);
  const whole = f.send({ ...f.attachment, selections: [] }, '整体改为暖色。');
  const result = await f.takeOver(whole.id);
  assert.deepEqual(f.store.get(result.record.progress.review?.reviewId ?? '')?.rounds[0]?.annotations[0]?.anchor, {
    kind: 'image-region',
    x: 0,
    y: 0,
    width: 160,
    height: 100,
  });
});

test('a real returned media candidate has one durable Host record pointing to the original Human source', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const request = await f.takeOver(message.id);
  const returned = await f.candidate(request.record.requestId);
  await f.integration.receipts.recover();
  const receipts = f.messages.getByThread(f.thread.id).filter((item) => item.extra?.contentModificationReceiptV1);
  assert.equal(receipts.length, 1, 'media candidates must participate in the same durable Host projection');
  const receipt = receipts[0];
  assert.equal(receipt?.userId, 'operator');
  assert.deepEqual(receipt?.from, { kind: 'system', service: 'content-modification' });
  assert.equal(receipt?.catId, null);
  assert.equal(receipt?.source, undefined);
  assert.equal(receipt?.replyTo, message.id);
  assert.equal(receipt?.visibility, 'whisper');
  assert.deepEqual(receipt?.whisperTo, message.whisperTo);
  assert.equal(
    receipt?.extra?.contentModificationReceiptV1?.candidateRef,
    returned.view.review.rounds.at(-1)?.asset.ownerReceiptRef,
  );
  await f.integration.receipts.recover();
  assert.equal(
    f.messages.getByThread(f.thread.id).filter((item) => item.extra?.contentModificationReceiptV1).length,
    1,
  );
  await assert.rejects(
    f.integration.requests.takeOver(
      { sourceMessageId: message.id, operationId: randomUUID() },
      { ...f.cat, actor: { kind: 'cat', actorId: 'codex' } },
    ),
    /not_found/,
  );
});
