import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { messageMediaPublicationSourceSchema } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { ArtifactVersionResponseService } from '../src/domains/collaborative-content/artifact-review/version-response-service.js';
import { mediaPublicationFixture } from './helpers/media-publication-fixture.js';

type Fixture = Awaited<ReturnType<typeof mediaPublicationFixture>>;
function storedReview(f: Fixture, reviewId: string) {
  const review = f.store.get(reviewId);
  assert.ok(review);
  return review;
}
async function ledgerContinuation(t: Parameters<typeof mediaPublicationFixture>[0]) {
  const f = await mediaPublicationFixture(t, false, { publicationLedger: true });
  assert.equal(f.request.record.payload.source.kind, 'publication');
  assert.equal(f.request.record.progress.sourceMessageId, f.humanMessage.id);
  assert.equal(f.request.record.progress.sourceKind, 'human_message');
  f.publish('append');
  await f.recover();
  assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
  const carrier = f.carriers()[0];
  assert.ok(carrier);
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  return { f, childId };
}

function inputFor(f: Fixture, childId: string) {
  const credentials = f.dispatch.credentials.get(childId);
  assert.ok(credentials);
  const publication = f.messages.getById(String(f.carriers()[0]?.source?.meta?.publicationMessageId));
  assert.ok(publication);
  const reviewId = f.request.record.progress.review?.reviewId;
  assert.ok(reviewId);
  const review = storedReview(f, reviewId);
  const round = review.rounds.at(-1);
  assert.ok(round);
  assert.ok(round.ledgerRef, 'the response must exercise the real canonical publication ledger');
  assert.ok(round.ledgerRevision && round.ledgerRevision >= 2);
  return {
    method: 'POST' as const,
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: {
      requestId: f.request.record.requestId,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      expectedTaskRevision: review.task.observedRevision,
      expectedOwnerRevision: round.asset.ownerRevision,
      expectedLedgerRevision: round.ledgerRevision,
      artifactRef: f.image.urlPath,
      expectedArtifactRevision: String(publication.timestamp),
      operationId: randomUUID(),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '保留原作品及批注来源，提交新版。',
      })),
    },
  };
}

test('a native publication with a linked ledger returns a candidate and replays the same operation receipt', async (t) => {
  const { f, childId } = await ledgerContinuation(t);
  const input = inputFor(f, childId);
  const old = storedReview(f, input.payload.reviewId);
  const response = await f.app.inject(input);
  assert.equal(response.statusCode, 200, response.body);
  const next = storedReview(f, old.reviewId);
  assert.equal(next.rounds.length, 2);
  assert.deepEqual(next.rounds[0]?.asset, old.rounds[0]?.asset);
  assert.ok(next.rounds[1]?.ledgerRef);
  assert.notEqual(next.rounds[1]?.ledgerRef, old.rounds[0]?.ledgerRef);
  assert.equal(next.rounds[1]?.asset.ownerRevision, 2);
  const replay = await f.app.inject(input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().receipt, response.json().receipt);
  assert.equal(storedReview(f, old.reviewId).revision, next.revision);
  const changed = await f.app.inject({ ...input, payload: { ...input.payload, artifactRef: '/uploads/other.png' } });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json().error, 'operation_reused');
  assert.equal(f.store.pendingVersion(old.reviewId), null);
  await f.recover();
  await f.recover();
  const receipts = f.messages
    .getByThread(f.thread.id, 100, 'operator')
    .filter(
      (message) =>
        message.extra?.contentModificationReceiptV1?.requestId === f.request.record.requestId &&
        message.extra.contentModificationReceiptV1.state === 'candidate',
    );
  assert.equal(receipts.length, 1, f.errors.map(String).join('; '));
  assert.equal(receipts[0]?.replyTo, f.humanMessage.id);
  assert.deepEqual(f.errors, []);
  assert.equal(f.carriers().length, 1);
});

test('a ledger-backed accepted native selector survives durable reservation and recovery through a reopened store', async (t) => {
  const { f, childId } = await ledgerContinuation(t);
  const input = inputFor(f, childId);
  const publish = f.media.publishVersion.bind(f.media);
  f.media.publishVersion = async () => {
    throw new Error('fixture_owner_unavailable');
  };
  const failed = await f.app.inject(input);
  assert.equal(failed.statusCode, 500, failed.body);
  const pending = f.store.pendingVersion(input.payload.reviewId);
  assert.ok(pending);
  assert.ok(pending.payload && typeof pending.payload === 'object' && 'publicationSource' in pending.payload);
  f.media.publishVersion = publish;
  const reopened = new ArtifactReviewStore(f.store.database.name);
  try {
    assert.deepEqual(reopened.pendingVersion(input.payload.reviewId), pending);
    const recovery = new ArtifactVersionResponseService({
      store: reopened,
      media: f.media,
      now: () => new Date().toISOString(),
    });
    const acceptedReview = reopened.get(input.payload.reviewId);
    assert.ok(acceptedReview);
    const recovered = await recovery.recover(acceptedReview, f.human);
    assert.ok(recovered);
    assert.equal(reopened.pendingVersion(input.payload.reviewId), null);
    assert.equal(reopened.get(input.payload.reviewId)?.rounds.at(-1)?.asset.ownerRevision, 2);
    const replay = await f.app.inject(input);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json().receipt, recovered.receipt);
  } finally {
    reopened.close();
  }
});

test('a native ledger return retains the exact ledger revision fence', async (t) => {
  const { f, childId } = await ledgerContinuation(t);
  const input = inputFor(f, childId);
  const stale = await f.app.inject({
    ...input,
    payload: { ...input.payload, expectedLedgerRevision: input.payload.expectedLedgerRevision - 1 },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error, 'revision_conflict');
  assert.equal(f.store.pendingVersion(input.payload.reviewId), null);
  assert.equal(storedReview(f, input.payload.reviewId).rounds.length, 1);
});

test('the external callback rejects even a well-formed caller-provided publicationSource on a ledger return', async (t) => {
  const { f, childId } = await ledgerContinuation(t);
  const input = inputFor(f, childId);
  const publicationSource = messageMediaPublicationSourceSchema.parse({
    kind: 'message',
    threadId: f.thread.id,
    messageId: f.carriers()[0]?.source?.meta?.publicationMessageId,
    messageRevision: input.payload.expectedArtifactRevision,
    item: { kind: 'media-gallery', blockId: f.image.richBlock.id, itemIndex: 0 },
    expectedUrl: input.payload.artifactRef,
  });
  const forged = await f.app.inject({ ...input, payload: { ...input.payload, publicationSource } });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.deepEqual(forged.json().details[0].keys, ['publicationSource']);
  assert.equal(f.store.pendingVersion(input.payload.reviewId), null);
  assert.equal(storedReview(f, input.payload.reviewId).rounds.length, 1);
});
