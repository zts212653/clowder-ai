import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ContextAttachment } from '@cat-cafe/shared';
import { projectTakeoverFixture } from './helpers/video-project-message-takeover.js';

for (const changed of ['project', 'screening', 'input', 'media'] as const)
  test(`F326 raw mixed ${changed} source is refused by takeover without creating Task or importing opinions`, async (t) => {
    const f = await projectTakeoverFixture();
    t.after(f.cleanup);
    const second = structuredClone(f.attachment);
    second.id = 'other-attachment';
    second.selections = second.selections.map((selection) => ({ ...selection, id: `${selection.id}-other` }));
    if (changed === 'project') second.contentRef = 'video-project:other';
    if (changed === 'screening') second.screeningId = 'other-screening';
    if (changed === 'input') second.input.ownerRevision += 1;
    if (changed === 'media') second.media.contentRef = 'video-project-media:other';
    const message = f.messages.append({
      userId: f.principal.userId,
      threadId: f.principal.threadId,
      catId: null,
      mentions: [f.principal.actor.actorId],
      content: 'Mixed source admission probe',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'context_attachment', attachment: f.attachment },
        { type: 'context_attachment', attachment: second },
      ],
    });
    f.turns.bindCoveredMessageIds(f.principal.invocationId, [f.message.id, message.id]);
    const before = f.store.ledgers.getByContent(f.principal.userId, f.attachment.contentRef);
    await assert.rejects(f.requests.takeOver({ sourceMessageId: message.id, operationId: randomUUID() }, f.principal), {
      code: 'invalid_patch',
    });
    assert.equal(f.tasks.listByThread(f.principal.threadId).length, 0);
    assert.deepEqual(f.store.ledgers.getByContent(f.principal.userId, f.attachment.contentRef), before);
  });

test('F326 two actual marks on one frozen source remain actionable through one real takeover Task', async (t) => {
  const f = await projectTakeoverFixture();
  t.after(f.cleanup);
  const second = structuredClone(f.attachment);
  second.id = 'second-mark';
  second.selections = second.selections.map((selection) => ({ ...selection, id: `${selection.id}-second` }));
  const message = f.messages.append({
    userId: f.principal.userId,
    threadId: f.principal.threadId,
    catId: null,
    mentions: [f.principal.actor.actorId],
    content: 'Two same-source marks',
    timestamp: Date.now(),
    contentBlocks: [
      { type: 'context_attachment', attachment: f.attachment },
      { type: 'context_attachment', attachment: second },
    ],
  });
  f.turns.bindCoveredMessageIds(f.principal.invocationId, [f.message.id, message.id]);
  const result = await f.requests.takeOver({ sourceMessageId: message.id, operationId: randomUUID() }, f.principal);
  assert.equal(result.stage, 'accepted');
  assert.equal(f.tasks.listByThread(f.principal.threadId).length, 1);
  const source = result.record.payload.source;
  assert.equal(source.kind, 'video-project');
  if (source.kind !== 'video-project') throw new Error('Expected actual frozen project source');
  assert.equal(source.annotationIds.length, 2);
  const view = await f.importer.reviews.read({ principal: f.principal, reviewId: source.reviewId });
  assert.equal(view.review.annotations.filter((annotation) => source.annotationIds.includes(annotation.id)).length, 2);
  assert.equal(
    view.review.annotations.filter((annotation) => annotation.projectMessage?.source.messageId === message.id).length,
    2,
  );
  assert.equal(view.review.revision, source.expectedReviewRevision);
});

for (const kind of ['thread', 'workspace_file'] as const)
  test(`F326 original ${kind} context and words survive one real frozen-source takeover`, async (t) => {
    const f = await projectTakeoverFixture();
    t.after(f.cleanup);
    const earlier = f.threads.create(f.principal.userId, 'Original context', f.root);
    await writeFile(join(f.root, 'context.md'), 'Original read-only context');
    const context: ContextAttachment =
      kind === 'thread'
        ? { v: 1, kind, id: 'original-thread', threadId: earlier.id, title: earlier.title }
        : { v: 1, kind, id: 'original-file', worktreeId: 'root', path: 'context.md' };
    const message = f.messages.append({
      userId: f.principal.userId,
      threadId: f.principal.threadId,
      catId: null,
      mentions: [f.principal.actor.actorId],
      content: 'Keep the original context and these words with the frozen movie position',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'context_attachment', attachment: context },
        { type: 'context_attachment', attachment: f.attachment },
      ],
    });
    const original = structuredClone(message);
    f.turns.bindCoveredMessageIds(f.principal.invocationId, [f.message.id, message.id]);
    const result = await f.requests.takeOver({ sourceMessageId: message.id, operationId: randomUUID() }, f.principal);
    assert.equal(result.stage, 'accepted');
    assert.equal(result.record.payload.source.kind, 'video-project');
    assert.ok(result.record.progress.task);
    assert.equal(f.tasks.listByThread(f.principal.threadId).length, 1);
    assert.equal(result.record.payload.intent.body, original.content);
    assert.deepEqual(f.messages.getById(message.id), original);
  });
