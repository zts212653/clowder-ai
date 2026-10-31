import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { VideoProjectCommand } from '@cat-cafe/shared';
import { z } from 'zod';
import { runProjectCommand } from '../src/domains/collaborative-content/modification/project/command.js';
import { VideoProjectSelfReviewService } from '../src/domains/video-studio/project/self-review.js';
import { projectTakeoverFixture as fixture } from './helpers/video-project-message-takeover.js';

async function acceptedCommand(f: Awaited<ReturnType<typeof fixture>>) {
  const accepted = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  const source = accepted.record.payload.source;
  if (source.kind !== 'video-project') throw new Error('Expected project source');
  const selfReviews = new VideoProjectSelfReviewService({
    projects: f.projects,
    appendSelfReview: (input) => f.projects.appendSelfReview(input),
    authorizeSource: async () => {
      throw new Error('This test never attests a self-review');
    },
  });
  return {
    source,
    command: (command: VideoProjectCommand['command']) =>
      runProjectCommand(
        {
          projects: f.projects,
          reviews: f.importer.reviews,
          takeover: f.project,
          selfReviews,
        },
        { requestId: accepted.record.requestId, command },
        f.principal,
      ),
  };
}

const pageSchema = z.object({
  snapshot: z.string(),
  json: z.string(),
  nextCursor: z.number().int().nonnegative().nullable(),
});
const actionSchema = z.object({
  receipt: z.object({ revision: z.number(), replayed: z.boolean() }).passthrough(),
  review: z.object({ reviewId: z.string(), revision: z.number() }),
});

async function importHidden(f: Awaited<ReturnType<typeof fixture>>, body: string) {
  f.messages.append({
    userId: f.principal.userId,
    threadId: f.message.threadId,
    catId: null,
    mentions: ['codex61-sol'],
    content: body,
    visibility: 'whisper',
    whisperTo: ['codex61-sol'],
    timestamp: Date.now(),
    contentBlocks: [{ type: 'context_attachment', attachment: structuredClone(f.attachment) }],
  });
  await f.importer.synchronize({
    principal: f.request.principal,
    contentRef: f.request.contentRef,
    threadId: f.message.threadId,
  });
}

test('F326 takeover returns the original Cat audience version while the journal keeps its canonical source', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await importHidden(f, 'Private before takeover');
  const result = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  const raw = f.store.requests.get(result.record.requestId, f.principal.userId);
  assert.ok(raw);
  assert.equal(result.stage, 'accepted');
  assert.equal(result.record.payload.source.kind, 'video-project');
  assert.equal(raw.payload.source.kind, 'video-project');
  if (raw.payload.source.kind !== 'video-project' || result.record.payload.source.kind !== 'video-project')
    throw new Error('Expected original project source');
  const view = await f.importer.reviews.read({ principal: f.principal, reviewId: raw.payload.source.reviewId });
  assert.equal(result.record.payload.source.expectedReviewRevision, view.review.revision);
  assert.equal(view.review.annotations.length, 1, 'Only the original public source is visible to this Cat');
  assert.ok(!JSON.stringify(result).includes('Private before takeover'));
  assert.deepEqual(result.record.progress, raw.progress);
  assert.deepEqual(result.record.payload.source.input, raw.payload.source.input);
  assert.deepEqual(result.record.payload.intent, raw.payload.intent);
  const immutableJournal = structuredClone(raw);
  await importHidden(f, 'Private after takeover');
  const replay = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  assert.equal(replay.record.payload.source.kind, 'video-project');
  if (replay.record.payload.source.kind !== 'video-project') throw new Error('Expected project source');
  assert.equal(replay.record.payload.source.expectedReviewRevision, view.review.revision);
  assert.deepEqual(f.store.requests.get(raw.requestId, f.principal.userId), immutableJournal);
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  assert.ok(!JSON.stringify(replay).includes('Private after takeover'));
});

for (const revoked of ['source', 'task'] as const)
  test(`F326 Cat outbound projection revalidates ${revoked} after its awaited review read`, async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const accepted = await f.requests.takeOver(
      { sourceMessageId: f.message.id, operationId: randomUUID() },
      f.principal,
    );
    const read = f.importer.reviews.read.bind(f.importer.reviews);
    f.importer.reviews.read = async (input) => {
      const view = await read(input);
      if (revoked === 'source') {
        const source = f.messages.getById(f.message.id);
        assert.ok(source);
        source.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
      } else {
        const taskId = accepted.record.progress.task?.taskId;
        assert.ok(taskId);
        const task = f.tasks.get(taskId);
        assert.ok(task);
        task.ownerCatId = 'codex' as typeof task.ownerCatId;
      }
      return view;
    };
    await assert.rejects(
      f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal),
      { code: 'access_denied' },
    );
  });

test('F326 a real visible follow-up updates the Cat outbound version without rewriting the accepted journal', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const result = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  const raw = structuredClone(f.store.requests.get(result.record.requestId, f.principal.userId));
  assert.ok(raw);
  if (raw.payload.source.kind !== 'video-project') throw new Error('Expected project source');
  const annotationId = raw.payload.source.annotationIds[0];
  assert.ok(annotationId);
  const human = await f.importer.reviews.read({
    principal: f.request.principal,
    reviewId: raw.payload.source.reviewId,
  });
  await f.importer.reviews.act({
    principal: f.request.principal,
    reviewId: raw.payload.source.reviewId,
    expectedRevision: human.review.revision,
    operationId: 'visible-follow-up',
    action: {
      kind: 'replied',
      annotationId,
      replyId: 'visible-reply',
      body: 'Visible follow-up',
    },
  });
  const visible = await f.importer.reviews.read({ principal: f.principal, reviewId: raw.payload.source.reviewId });
  const replay = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  assert.equal(replay.record.payload.source.kind, 'video-project');
  if (replay.record.payload.source.kind !== 'video-project' || result.record.payload.source.kind !== 'video-project')
    throw new Error('Expected project source');
  assert.equal(replay.record.payload.source.expectedReviewRevision, visible.review.revision);
  assert.ok(visible.review.revision > result.record.payload.source.expectedReviewRevision);
  assert.deepEqual(f.store.requests.get(raw.requestId, f.principal.userId), raw);
});

test('F326 actual command review pages keep one snapshot through hidden activity and fence visible activity', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { source, command } = await acceptedCommand(f);
  const human = await f.importer.reviews.read({ principal: f.request.principal, reviewId: source.reviewId });
  const annotationId = source.annotationIds[0];
  assert.ok(annotationId);
  await f.importer.reviews.act({
    principal: f.request.principal,
    reviewId: source.reviewId,
    expectedRevision: human.review.revision,
    operationId: 'long-visible-reply',
    action: { kind: 'replied', annotationId, replyId: 'long-visible-reply', body: '公开'.repeat(3500) },
  });
  const visible = await f.importer.reviews.read({ principal: f.principal, reviewId: source.reviewId });
  const first = pageSchema.parse(await command({ kind: 'review-read', cursor: 0 }));
  assert.notEqual(first.nextCursor, null, 'The real canonical review must span multiple consumer pages');
  const rawRevision = f.store.ledgers.get(source.reviewId)?.revision;
  assert.ok(rawRevision !== undefined);
  await importHidden(f, 'Private opinion between consumer pages');
  const hiddenRevision = f.store.ledgers.get(source.reviewId)?.revision;
  assert.ok(hiddenRevision !== undefined && hiddenRevision > rawRevision);
  let page = first,
    json = first.json,
    count = 1;
  while (page.nextCursor !== null) {
    page = pageSchema.parse(
      await command({ kind: 'review-read', cursor: page.nextCursor, expectedSnapshot: first.snapshot }),
    );
    assert.equal(page.snapshot, first.snapshot);
    json += page.json;
    count++;
  }
  assert.ok(count > 1);
  assert.deepEqual(JSON.parse(json), visible);
  assert.ok(!json.includes('Private opinion between consumer pages'));
  const humanAfter = await f.importer.reviews.read({ principal: f.request.principal, reviewId: source.reviewId });
  await f.importer.reviews.act({
    principal: f.request.principal,
    reviewId: source.reviewId,
    expectedRevision: humanAfter.review.revision,
    operationId: 'later-visible-reply',
    action: { kind: 'replied', annotationId, replyId: 'later-visible-reply', body: 'Another public follow-up' },
  });
  assert.ok(first.nextCursor !== null);
  await assert.rejects(command({ kind: 'review-read', cursor: first.nextCursor, expectedSnapshot: first.snapshot }), {
    code: 'proposal_changed',
  });
});

test('F326 actual command review-act and replay receipts share the Cat audience CAS despite private ledger writes', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { source, command } = await acceptedCommand(f);
  const before = await f.importer.reviews.read({ principal: f.principal, reviewId: source.reviewId });
  await importHidden(f, 'Private before the Cat command');
  const annotationId = source.annotationIds[0];
  assert.ok(annotationId);
  const request: VideoProjectCommand['command'] = {
    kind: 'review-act',
    expectedRevision: before.review.revision,
    operationId: 'cat-command-reply',
    action: { kind: 'replied', annotationId, replyId: 'cat-command-reply', body: 'A public Cat reply' },
  };
  const result = actionSchema.parse(await command(request));
  const after = await f.importer.reviews.read({ principal: f.principal, reviewId: source.reviewId });
  assert.equal(result.review.revision, before.review.revision + 1);
  assert.equal(result.receipt.revision, result.review.revision);
  assert.equal(result.review.revision, after.review.revision);
  const canonical = f.store.ledgers.operationReceipt(source.reviewId, request.operationId);
  assert.ok(canonical);
  assert.ok(
    canonical.revision > result.receipt.revision,
    'Only the internal receipt retains the unrelated canonical sequence',
  );
  await importHidden(f, 'Private after the Cat command');
  const replay = actionSchema.parse(await command(request));
  assert.deepEqual(replay.review, result.review);
  assert.equal(replay.receipt.revision, result.receipt.revision);
  assert.equal(replay.receipt.replayed, true);
  assert.deepEqual(f.store.ledgers.operationReceipt(source.reviewId, request.operationId), canonical);
});

test('F326 an unrelated whisper withdrawn during a real owner read never enters the Cat command page', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const { command } = await acceptedCommand(f);
  const privateSource = f.messages.append({
    userId: f.principal.userId,
    threadId: f.message.threadId,
    catId: null,
    mentions: [f.principal.actor.actorId],
    visibility: 'whisper',
    whisperTo: [f.principal.actor.actorId],
    content: 'Secret from a separate withdrawn source',
    timestamp: Date.now(),
    contentBlocks: [{ type: 'context_attachment', attachment: structuredClone(f.attachment) }],
  });
  await f.importer.synchronize({
    principal: f.request.principal,
    contentRef: f.request.contentRef,
    threadId: f.message.threadId,
  });
  const load = f.projects.load.bind(f.projects);
  let revoke = true;
  f.projects.load = async (input) => {
    if (input.principal.actor.kind === 'cat' && revoke) {
      revoke = false;
      privateSource.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    }
    return load(input);
  };
  let page = pageSchema.parse(await command({ kind: 'review-read', cursor: 0 }));
  assert.ok(
    !page.json.includes(privateSource.content),
    'The first bounded page cannot disclose the withdrawn whisper body',
  );
  const first = page;
  let json = page.json;
  while (page.nextCursor !== null) {
    page = pageSchema.parse(
      await command({ kind: 'review-read', cursor: page.nextCursor, expectedSnapshot: first.snapshot }),
    );
    json += page.json;
  }
  assert.equal(revoke, false, 'The actual F138 read occurred after the initial annotation visibility checks');
  assert.ok(
    !json.includes(privateSource.content),
    'Current-source withdrawal must not be hidden by a still-valid public Task grant',
  );
  assert.ok(json.includes(f.message.content), 'The original public source remains valid and readable');
});
