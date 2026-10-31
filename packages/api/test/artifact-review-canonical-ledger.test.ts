import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

test('Task binding references the original publication ledger; both entry points edit one durable body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-linked-ledger-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  await writeFile(
    join(uploads, 'cover.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abc123' } })
      .png()
      .toBuffer(),
  );
  const dbPath = join(root, 'reviews.sqlite');
  const store = new ArtifactReviewStore(dbPath);
  const f = createReviewFixture(root, uploads, store);
  const task = f.task.current;
  assert.ok(task?.entrustedWork);
  f.task.current = null;
  const asset = await f.media.prepare({
    source: {
      kind: 'message',
      threadId: 'thread-cover',
      messageId: f.publication.id,
      messageRevision: String(f.publication.timestamp),
      expectedUrl: '/uploads/cover.png',
      item: { kind: 'media-gallery', blockId: 'image', itemIndex: 0 },
    },
    operationId: 'open-message',
    principal: reviewHuman,
  });
  const raw = new Database(dbPath);
  t.after(async () => {
    raw.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const ledgerService = new WorkspaceContentReviewService({
    store: store.ledgers,
    publications: f.media,
    source: new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => {
        throw new Error('no fake file locator');
      },
    }),
  });
  const ledger = (
    await ledgerService.prepare({ publication: asset, principal: reviewHuman, operationId: 'open-ledger' })
  ).review;
  const annotated = await ledgerService.annotate({
    principal: reviewHuman,
    reviewId: ledger.reviewId,
    expectedRevision: 1,
    operationId: 'point',
    body: '保留暖光',
    target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 20 } },
  });
  task.entrustedWork.artifactRefs = [`content:${asset.contentRef}`];
  f.task.current = task;
  const reviews = new ArtifactReviewService({ store, media: f.media });
  const bound = await reviews.prepare(
    {
      taskId: task.id,
      expectedTaskRevision: 1,
      artifactRef: `content:${asset.contentRef}`,
      expectedArtifactRevision: '1',
      operationId: 'bind-task',
    },
    reviewHuman,
  );
  const round = bound.review.rounds[0];
  assert.equal(round?.ledgerRef, ledger.reviewId);
  assert.equal(round?.annotations[0]?.id, annotated.review.annotations[0]?.id);
  const annotationId = round?.annotations[0]?.id;
  assert.ok(annotationId);
  const result = await reviews.act(
    {
      reviewId: bound.review.reviewId,
      expectedRevision: 1,
      expectedLedgerRevision: 2,
      expectedTaskRevision: 1,
      round: 1,
      operationId: 'reply-through-task',
      action: { kind: 'reply', annotationId, replyId: 'reply', body: '也保留左边的猫' },
    },
    reviewHuman,
  );
  assert.equal(result.view.review.rounds[0]?.annotations[0]?.replies.length, 1);
  assert.equal(store.ledgers.get(ledger.reviewId)?.annotations[0]?.replies?.[0]?.body, '也保留左边的猫');
  const persisted = JSON.parse(
    (
      raw.prepare('SELECT body FROM artifact_reviews WHERE review_id = ?').get(bound.review.reviewId) as {
        body: string;
      }
    ).body,
  );
  assert.deepEqual(
    persisted.rounds[0].annotations,
    [],
    'round is a reference, never a second writable annotation body',
  );
  assert.equal(persisted.rounds[0].ledgerRevision, undefined, 'projection revisions are not copied into the round');
  await ledgerService.act({
    principal: reviewHuman,
    reviewId: ledger.reviewId,
    expectedRevision: 3,
    operationId: 'resolve-from-message',
    action: { kind: 'set_annotation_state', annotationId, state: 'resolved' },
  });
  assert.equal(
    (await reviews.read(bound.review.reviewId, reviewHuman)).review.rounds[0]?.annotations[0]?.state,
    'resolved',
  );
  await assert.rejects(
    reviews.act(
      {
        reviewId: bound.review.reviewId,
        expectedRevision: 2,
        expectedLedgerRevision: 3,
        expectedTaskRevision: 1,
        round: 1,
        operationId: 'stale-ledger',
        action: { kind: 'reply', annotationId, replyId: 'stale', body: 'stale' },
      },
      reviewHuman,
    ),
    /revision_conflict/,
  );
  const requested = await reviews.act(
    {
      reviewId: bound.review.reviewId,
      expectedRevision: 2,
      expectedLedgerRevision: 4,
      expectedTaskRevision: 1,
      round: 1,
      operationId: 'erase-request',
      action: {
        kind: 'request_image_edit',
        annotationId: 'erase',
        edit: { kind: 'erase-region', region: { x: 30, y: 30, width: 20, height: 20 } },
      },
    },
    reviewHuman,
  );
  assert.equal(store.returns.pending().length, 1);
  assert.equal(store.ledgers.get(ledger.reviewId)?.annotations[1]?.imageEdit?.kind, 'erase-region');
  // This ledger-focused fixture restores a committed human binding. End-to-end admission/outbox sequencing
  // is covered by content-modification-service and published-media-modification-return, not forged Task strings.
  const binding = store.requests.reserve('operator', {
    operationId: randomUUID(),
    threadId: task.threadId,
    targetCatId: 'codex-astra',
    intent: { body: '移除圈选区域' },
    source: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: 1,
      ledgerRef: ledger.reviewId,
      expectedLedgerRevision: 4,
    },
  });
  f.messages.set('confirmed-human-request', {
    id: 'confirmed-human-request',
    userId: 'operator',
    threadId: task.threadId,
    catId: null,
    mentions: [],
    content: binding.payload.intent.body,
    timestamp: Date.now(),
    extra: {
      contentModificationRequestV1: {
        v: 1,
        requestId: binding.requestId,
        requestFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(binding.payload)).digest('hex')}`,
        contentTitle: '活动封面',
        targetCatId: 'codex-astra',
        targetName: '小星星',
        executionThreadTitle: '活动发布',
        completionRule: 'published-result-ready',
      },
    },
  });
  const lease = store.requests.acquire(binding.requestId, 'operator');
  assert.ok(lease);
  store.requests.advance(binding.requestId, lease.token, {
    sourceMessageId: 'confirmed-human-request',
    prepared: { kind: 'media', contentRef: asset.contentRef, ownerRevision: 1, ledgerRef: ledger.reviewId },
    task: { taskId: task.id, revision: 1, receiptRef: task.entrustedWork.admission.receiptRef },
  });
  store.requests.bindReview(binding.requestId, lease.token, () => ({
    reviewId: bound.review.reviewId,
    round: 1,
    receiptRef: requested.receipt.receiptRef,
  }));
  store.requests.release(binding.requestId, lease.token);
  await writeFile(
    join(uploads, 'returned.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer(),
  );
  const returned = f.publish('/uploads/returned.png');
  const response = {
    requestId: binding.requestId,
    reviewId: bound.review.reviewId,
    expectedRevision: requested.view.review.revision,
    expectedLedgerRevision: 5,
    expectedTaskRevision: 1,
    expectedOwnerRevision: 1,
    operationId: 'return-version',
    artifactRef: '/uploads/returned.png',
    expectedArtifactRevision: String(returned.timestamp),
    responses: [{ annotationId: 'erase', disposition: 'addressed' as const, explanation: '圈选区域已移除' }],
  };
  store.reserveVersion(reviews.versions.mutation(response, reviewCat.actor, 1), response);
  await assert.rejects(
    ledgerService.act({
      principal: reviewHuman,
      reviewId: ledger.reviewId,
      expectedRevision: 5,
      operationId: 'reply-during-return',
      action: { kind: 'reply', annotationId, replyId: 'too-late', body: '不能在版本返回中间插入' },
    }),
    /version_pending/,
  );
  raw.exec(
    "CREATE TRIGGER crash_return BEFORE INSERT ON artifact_review_operations WHEN NEW.operation_id = 'return-version' BEGIN SELECT RAISE(ABORT, 'projection crash'); END",
  );
  await assert.rejects(reviews.respond(response, reviewCat), /projection crash/);
  assert.equal((await f.owner.load(asset.contentRef)).ownerRevision, 2);
  assert.equal(store.get(bound.review.reviewId)?.rounds.length, 1);
  raw.exec('DROP TRIGGER crash_return');
  const recovered = await reviews.read(bound.review.reviewId, reviewHuman);
  const nextRound = recovered.review.rounds[1];
  assert.ok(nextRound?.ledgerRef);
  assert.notEqual(nextRound.ledgerRef, ledger.reviewId);
  assert.equal(nextRound.annotations.length, 0);
  assert.equal(recovered.review.rounds[0]?.annotations[1]?.imageEdit?.kind, 'erase-region');
  assert.equal((await reviews.respond(response, reviewCat)).receipt.outcome, 'applied');
  const reopened = await ledgerService.prepare({
    principal: reviewHuman,
    publication: nextRound.asset,
    operationId: 'open-returned-from-chat',
  });
  assert.equal(reopened.review.reviewId, nextRound.ledgerRef);
  const restarted = new ArtifactReviewStore(dbPath);
  try {
    assert.equal(restarted.get(bound.review.reviewId)?.rounds[0]?.annotations[0]?.state, 'resolved');
  } finally {
    restarted.close();
  }
  const oldLedger = store.ledgers.get(ledger.reviewId);
  assert.ok(oldLedger && nextRound?.ledgerRef);
  const latestBefore = store.ledgers.get(nextRound.ledgerRef);
  const priorReturn = store.returns.latest(recovered.review.reviewId);
  const replied = await reviews.act(
    {
      reviewId: recovered.review.reviewId,
      expectedRevision: recovered.review.revision,
      expectedTaskRevision: 1,
      expectedLedgerRevision: oldLedger.revision,
      round: 1,
      operationId: 'history-reply',
      action: { kind: 'reply', annotationId, replyId: 'history-reply', body: '旧版的光线仍然值得保留' },
    },
    reviewHuman,
  );
  assert.equal(replied.view.review.rounds[0]?.annotations[0]?.replies.at(-1)?.body, '旧版的光线仍然值得保留');
  assert.deepEqual(
    store.ledgers.get(nextRound.ledgerRef),
    latestBefore,
    'historical reply cannot touch the current version',
  );
  const historicalView = await ledgerService.read({ principal: reviewHuman, reviewId: ledger.reviewId });
  assert.equal(historicalView.canWrite, false);
  assert.equal(historicalView.canReply, true);
  await ledgerService.act({
    principal: reviewHuman,
    reviewId: ledger.reviewId,
    expectedRevision: historicalView.review.revision,
    operationId: 'reply-on-original-ledger',
    action: { kind: 'reply', annotationId, replyId: 'other-entry', body: '从原作品入口继续讨论旧版' },
  });
  assert.deepEqual(store.ledgers.get(nextRound.ledgerRef), latestBefore);
  await assert.rejects(
    ledgerService.act({
      principal: reviewHuman,
      reviewId: ledger.reviewId,
      expectedRevision: historicalView.review.revision + 1,
      operationId: 'history-state-edit',
      action: { kind: 'set_annotation_state', annotationId, state: 'open' },
    }),
    /source_changed/,
  );
  assert.deepEqual(
    store.returns.latest(recovered.review.reviewId),
    priorReturn,
    'history reply does not enqueue or reopen custody',
  );
  const independent = new ArtifactReviewStore(dbPath);
  try {
    assert.equal(
      independent.get(recovered.review.reviewId)?.rounds[0]?.annotations[0]?.replies.at(-1)?.body,
      '从原作品入口继续讨论旧版',
    );
  } finally {
    independent.close();
  }
  f.publication._tombstone = true;
  await assert.rejects(
    ledgerService.act({
      principal: reviewHuman,
      reviewId: ledger.reviewId,
      expectedRevision: historicalView.review.revision + 1,
      operationId: 'revoked-history-reply',
      action: { kind: 'reply', annotationId, replyId: 'denied', body: '撤权不能继续' },
    }),
    /access_denied/,
  );
});
