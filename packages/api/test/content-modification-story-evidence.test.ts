import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { workMediaPrincipal } from '../src/domains/collaborative-content/works/access.js';
import { WorkVideoContextService } from '../src/domains/collaborative-content/works/video-context.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

test('the legacy single-selection request cannot bypass paragraph verification', async (t) => {
  const f = await mediaMessageFixture(t, 'video/mp4', undefined, { publicationLedger: true });
  const selection = f.attachment.selections[0]?.selection;
  assert.ok(selection?.kind === 'video-range');
  const anchor = { ...selection, storyEvidence: { metadataRevision: 1, paragraphId: 'forged', quote: '不存在' } };
  const count = f.tasks.listByThread(f.thread.id).length;
  await assert.rejects(
    f.integration.requests.submit(
      {
        operationId: randomUUID(),
        source: f.attachment.source,
        threadId: f.thread.id,
        targetCatId: f.cat.actor.actorId,
        taskContext: f.attachment.taskContext,
        intent: { body: '这一段有问题', selection: anchor },
      },
      f.human,
    ),
    /invalid_media/,
  );
  assert.equal(f.tasks.listByThread(f.thread.id).length, count);
});

test('original Human message takeover rejects unverified story evidence before mutation and preserves admitted evidence in the original ledger', async (t) => {
  const f = await mediaMessageFixture(t, 'video/mp4', undefined, { publicationLedger: true });
  const selection = f.attachment.selections[0];
  assert.ok(selection?.selection.kind === 'video-range');
  const anchor = {
    ...selection.selection,
    storyEvidence: { metadataRevision: 1, paragraphId: 'opening', quote: '原台词' },
  };
  const attachment = { ...f.attachment, selections: [{ ...selection, selection: anchor }] };
  const message = f.send(attachment);
  const count = f.tasks.listByThread(f.thread.id).length;
  // No verifier is not permission to trust a client quote.
  await assert.rejects(f.takeOver(message.id), /invalid_media/);
  assert.equal(f.tasks.listByThread(f.thread.id).length, count);
  assert.equal(attachment.source.kind, 'publication');
  if (attachment.source.kind !== 'publication') throw new Error('Expected publication');
  const reference = { contentRef: attachment.source.contentRef, ownerRevision: attachment.source.ownerRevision };
  const contexts = new WorkVideoContextService({
    store: f.store.works.contexts,
    authorize: async (ref, principal) => {
      await f.media.read(ref.contentRef, ref.ownerRevision, workMediaPrincipal(principal));
    },
    media: async (ref, principal) => {
      const asset = await f.media.read(ref.contentRef, ref.ownerRevision, workMediaPrincipal(principal));
      if (asset.media.kind !== 'video') throw new Error('Expected video');
      return asset.media;
    },
  });
  const principal = { ...f.human, threadId: f.thread.id };
  await contexts.save(
    {
      action: 'set-context',
      reference,
      operationId: 'real-story',
      expectedMetadataRevision: 0,
      context: {
        format: 'video',
        extractorVersion: 'fixture',
        assets: [],
        provenance: [{ ref: 'fixture', digest: `sha256:${'a'.repeat(64)}` }],
        story: [
          {
            id: anchor.storyEvidence.paragraphId,
            title: '片头',
            text: anchor.storyEvidence.quote,
            streamId: anchor.streamId,
            startPts: anchor.startTick,
            endPts: anchor.endTick,
          },
        ],
      },
    },
    principal,
  );
  let verified = 0;
  f.media.setAnchorEvidenceVerifier(async (ref, actual, actor) => {
    verified++;
    await contexts.verifyStory(ref, actual, { ...actor, threadId: f.thread.id });
  });
  const forged = f.send({
    ...attachment,
    selections: [
      { ...selection, selection: { ...anchor, storyEvidence: { ...anchor.storyEvidence, quote: '伪造原话' } } },
    ],
  });
  await assert.rejects(f.takeOver(forged.id), /invalid_media/);
  assert.equal(f.tasks.listByThread(f.thread.id).length, count);
  assert.equal((await f.messages.getById(message.id))?.content, message.content);
  const result = await f.takeOver(message.id);
  assert.ok(verified > 1, 'Both initial admission and commit recheck retained evidence');
  const record = f.store.requests.get(result.record.requestId, 'operator');
  assert.ok(record?.progress.review);
  const view = await f.reviews.readCurrent(record.progress.review.reviewId, f.cat);
  assert.deepEqual(view.review.rounds.at(-1)?.annotations.at(-1)?.anchor, anchor);
});

test('direct publication and Task annotation actions use the same canonical story verifier', async (t) => {
  const f = await mediaMessageFixture(t, 'video/mp4', undefined, { publicationLedger: true });
  const source = f.attachment.source;
  assert.equal(source.kind, 'publication');
  if (source.kind !== 'publication') throw new Error('Expected linked publication');
  const selection = f.attachment.selections[0]?.selection;
  assert.ok(selection?.kind === 'video-range');
  const anchor = { ...selection, storyEvidence: { metadataRevision: 1, paragraphId: 'forged', quote: '不存在' } };
  const ledger = f.ledgers;
  assert.ok(ledger);
  registerWorkspaceContentReviewRoutes(f.app, { reviews: ledger, namespace: 'publication' });
  await assert.rejects(
    ledger.annotate({
      principal: f.human,
      reviewId: source.ledgerRef,
      expectedRevision: source.expectedLedgerRevision,
      operationId: randomUUID(),
      body: '意见',
      target: { kind: 'media_anchor', anchor },
    }),
    /invalid_action/,
  );
  const refused = await f.app.inject({
    method: 'POST',
    url: `/api/content-reviews/${source.ledgerRef}/annotations`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: {
      expectedRevision: source.expectedLedgerRevision,
      operationId: randomUUID(),
      body: '意见',
      target: { kind: 'media_anchor', anchor },
    },
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(refused.json().error.code, 'invalid_action');
  const review = await f.reviews.readCurrent(f.attachment.taskContext!.reviewId, f.human);
  await assert.rejects(
    f.reviews.act(
      {
        reviewId: review.review.reviewId,
        expectedRevision: review.review.revision,
        expectedTaskRevision: review.authority.taskRevision,
        expectedLedgerRevision: review.review.rounds[0]?.ledgerRevision,
        round: 1,
        operationId: randomUUID(),
        action: { kind: 'annotate', annotationId: 'forged', body: '意见', anchor },
      },
      f.human,
    ),
    /invalid_media/,
  );
  assert.equal((await f.reviews.readCurrent(review.review.reviewId, f.human)).review.revision, review.review.revision);
});
