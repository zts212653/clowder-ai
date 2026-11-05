import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MediaContextAttachment } from '@cat-cafe/shared';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

test('named gallery takeover changes only its exact original work and keeps sibling requests separate', async (t) => {
  const f = await mediaMessageFixture(t);
  await copyFile(join(f.root, 'review-input.png'), join(f.root, 'second.png'));
  const secondReview = await f.files.prepare({
    principal: f.human,
    locator: { worktreeId: 'media-worktree', path: 'second.png' },
    operationId: randomUUID(),
  });
  assert.equal(secondReview.review.source.kind, 'media');
  const second: MediaContextAttachment = {
    v: 1,
    id: 'image-two',
    kind: 'media',
    title: '第二张',
    mediaType: 'image/png',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'media-worktree', path: 'second.png' },
      expectedSourceRevision: secondReview.review.source.revision,
      reviewId: secondReview.review.reviewId,
      expectedReviewRevision: secondReview.review.revision,
    },
    selections: [{ id: '3', selection: { kind: 'image-point', x: 40, y: 40 }, instruction: '仅第二张加星星' }],
  };
  const message = f.send();
  message.contentBlocks?.push({ type: 'context_attachment', attachment: second });
  const originalRevision = f.store.get(f.attachment.taskContext!.reviewId)!.revision;
  await assert.rejects(f.takeOver(message.id), /invalid_patch/, 'ambiguous sources never choose the first work');
  const operationId = randomUUID();
  const result = await f.integration.requests.takeOver(
    { sourceMessageId: message.id, attachmentId: second.id, operationId },
    f.cat,
  );
  assert.equal(result.stage, 'queued', JSON.stringify(result.record.issue));
  assert.deepEqual(result.record.payload.source, second.source);
  assert.deepEqual(result.record.payload.intent.selections, second.selections);
  assert.equal(result.record.payload.intent.body, message.content);
  assert.equal(
    f.store.get(f.attachment.taskContext!.reviewId)!.revision,
    originalRevision,
    'unselected owner stays unchanged',
  );
  const replay = await f.integration.requests.takeOver(
    { sourceMessageId: message.id, attachmentId: second.id, operationId },
    f.cat,
  );
  assert.equal(replay.record.requestId, result.record.requestId);
  await assert.rejects(
    f.integration.requests.takeOver({ sourceMessageId: message.id, attachmentId: f.attachment.id, operationId }, f.cat),
    /operation_reused/,
    'one retry UUID cannot switch the selected attachment',
  );
  const competingOperationId = randomUUID();
  const competing = await f.integration.requests.takeOver(
    { sourceMessageId: message.id, attachmentId: second.id, operationId: competingOperationId },
    f.cat,
  );
  assert.equal(competing.record.requestId, result.record.requestId);
  await assert.rejects(
    f.integration.requests.takeOver(
      { sourceMessageId: message.id, attachmentId: f.attachment.id, operationId: competingOperationId },
      f.cat,
    ),
    /operation_reused/,
    'even a competing retry alias is permanently bound',
  );
  await assert.rejects(
    f.integration.requests.takeOver(
      { sourceMessageId: message.id, attachmentId: 'missing', operationId: randomUUID() },
      f.cat,
    ),
    /invalid_patch/,
  );
  const first = await f.integration.requests.takeOver(
    { sourceMessageId: message.id, attachmentId: f.attachment.id, operationId: randomUUID() },
    f.cat,
  );
  assert.equal(first.stage, 'queued', JSON.stringify(first.record.issue));
  assert.notEqual(first.record.requestId, result.record.requestId);
  assert.deepEqual(first.record.payload.source, f.attachment.source);
  assert.equal(first.record.progress.task?.taskId, f.taskId);
  assert.equal(f.messages.getById(message.id)?.content, message.content);
});
