import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ArtifactReview, ReviewedMediaAsset } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { appendRespondedVersion } from '../src/domains/collaborative-content/artifact-review/reducer.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';

const now = '2026-10-20T20:00:00.000Z';
const actor = { kind: 'cat' as const, actorId: 'director' };
function asset(ownerRevision: number): ReviewedMediaAsset {
  return {
    contentRef: 'work:one-film',
    ownerRevision,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'video/mp4',
    media: {
      kind: 'video',
      width: 100,
      height: 100,
      codedWidth: 100,
      codedHeight: 100,
      rotation: 0,
      pixelAspectRatio: { numerator: 1, denominator: 1 },
      streamId: `stream-${ownerRevision}`,
      streamIndex: 0,
      timebase: { numerator: 1, denominator: 1000 },
      startTick: 0,
      durationTicks: 10000,
      containerStartSeconds: 0,
    },
    sourcePublication: {
      artifactRef: `workspace:film-${ownerRevision}.mp4`,
      sourceRef: 'workspace:root:film.mp4',
      revision: `sha256:${'b'.repeat(64)}`,
    },
    ownerReceiptRef: `owner-receipt-${ownerRevision}`,
  };
}
function review(): ArtifactReview {
  return {
    version: 1,
    reviewId: 'original-review',
    revision: 1,
    title: 'One film',
    contentRef: 'work:one-film',
    task: { taskId: 'original-task', threadId: 'original-thread', ownerUserId: 'operator', observedRevision: 1 },
    createdAt: now,
    updatedAt: now,
    rounds: [
      {
        number: 1,
        asset: asset(1),
        openedAt: now,
        state: 'changes_requested',
        responses: [],
        annotations: [
          {
            id: 'old-opinion',
            body: 'Shorten this passage',
            state: 'open',
            author: { kind: 'human', actorId: 'operator' },
            createdAt: now,
            updatedAt: now,
            replies: [],
            anchor: { kind: 'video-range', streamId: 'stream-1', startTick: 8000, endTick: 9000 },
          },
        ],
      },
      { number: 2, asset: asset(3), openedAt: now, state: 'draft', responses: [], annotations: [] },
    ],
  };
}
const response = {
  annotationId: 'old-opinion',
  disposition: 'addressed' as const,
  explanation: 'Shortened in v4',
  resultAnchor: { kind: 'video-range' as const, streamId: 'stream-4', startTick: 2000, endTick: 3000 },
};

test('a v1 opinion responding at v4 retains its source round independently of the v3 submit baseline', () => {
  const original = review();
  const result = appendRespondedVersion(original, {
    asset: asset(4),
    responses: [response],
    sourceRound: 1,
    actor,
    now,
  });
  assert.deepEqual(result.rounds[0], original.rounds[0]);
  assert.deepEqual(result.rounds[2]?.responseSource, { round: 1, ownerRevision: 1, reviewRevision: 1 });
  assert.equal(result.rounds[2]?.asset.ownerRevision, 4);
  assert.deepEqual(result.rounds[2]?.responses[0]?.resultAnchor, response.resultAnchor);
  assert.equal(result.rounds[0]?.annotations[0]?.state, 'open', 'an author response is not Human acceptance');
  assert.equal(result.rounds[2]?.decision, undefined);
  assert.equal(result.rounds[2]?.annotations.length, 0, 'the original opinion is not copied to the result ledger');
});

test('a new position must fit the actual result clock, and an absent mapping never reuses the old position', () => {
  assert.throws(
    () =>
      appendRespondedVersion(review(), {
        asset: asset(4),
        sourceRound: 1,
        actor,
        now,
        responses: [{ ...response, resultAnchor: { ...response.resultAnchor, endTick: 10001 } }],
      }),
    /invalid_anchor/,
  );
  const { resultAnchor: _anchor, ...unmapped } = response;
  const result = appendRespondedVersion(review(), {
    asset: asset(4),
    responses: [unmapped],
    sourceRound: 1,
    actor,
    now,
  });
  assert.equal(result.rounds[2]?.responses[0]?.resultAnchor, undefined);
  assert.equal(result.rounds[0]?.annotations[0]?.anchor.kind, 'video-range');
  for (const resultAnchor of [
    { ...response.resultAnchor, streamId: 'stream-1' },
    { ...response.resultAnchor, storyEvidence: { paragraphId: 'old', metadataRevision: 1, quote: 'old quote' } },
  ]) {
    assert.throws(
      () =>
        appendRespondedVersion(review(), {
          asset: asset(4),
          sourceRound: 1,
          actor,
          now,
          responses: [{ ...response, resultAnchor }],
        }),
      /invalid_anchor/,
    );
  }
});

test('work metadata, the original response receipt and pending removal commit or roll back together', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f326-work-review-atomic-'));
  const file = join(root, 'reviews.sqlite');
  const store = new ArtifactReviewStore(file);
  const injector = new Database(file);
  t.after(async () => {
    injector.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.create(review(), { actor, operationId: 'prepare', now });
  const input = {
    reviewId: 'original-review',
    expectedRevision: 1,
    operationId: 'submit-v4',
    actor,
    now,
    round: 1,
    kind: 'respond_with_version',
    request: { fullAcceptedCommand: 'fixture-sealed-intent' },
  };
  store.reserveVersion(input, { fullAcceptedCommand: 'fixture-sealed-intent' });
  const version = {
    contentRef: 'work:one-film',
    ownerRevision: 4,
    ownerUserId: 'operator',
    threadId: 'original-thread',
    operationId: 'submit-v4',
    title: 'One film',
    changeSummary: 'Shortened',
    receiptRef: 'owner-receipt-4',
    requestDigest: `sha256:${'c'.repeat(64)}` as const,
    source: { worktreeId: 'root', path: 'film.mp4', expectedSourceRevision: `sha256:${'b'.repeat(64)}` as const },
  };
  const originalVersion = {
    ...version,
    ownerRevision: 1,
    operationId: 'original-version',
    receiptRef: 'owner-receipt-1',
  };
  store.works.recordVersion(originalVersion);
  const finish = () =>
    store.finishVersion(
      input,
      (current) =>
        appendRespondedVersion(current, {
          asset: asset(4),
          responses: [response],
          sourceRound: 1,
          actor,
          now,
        }),
      version,
    );
  injector.exec(
    "CREATE TRIGGER crash_work_projection BEFORE INSERT ON work_version_annotations BEGIN SELECT RAISE(ABORT, 'work projection interrupted'); END",
  );
  assert.throws(finish, /work projection interrupted/);
  assert.equal(store.get(input.reviewId)?.revision, 1);
  assert.ok(store.pendingVersion(input.reviewId));
  assert.equal(store.works.get('operator', version.contentRef, 4), null);
  assert.equal(store.replay(input), null);
  injector.exec('DROP TRIGGER crash_work_projection');
  const committed = finish();
  assert.equal(committed.review.rounds.length, 3);
  assert.equal(store.pendingVersion(input.reviewId), null);
  assert.equal(store.works.get('operator', version.contentRef, 4)?.receiptRef, 'owner-receipt-4');
  assert.deepEqual(finish().receipt, committed.receipt);
  assert.throws(
    () =>
      store.finishVersion(input, (current) => current, {
        ...version,
        ownerRevision: 1,
        receiptRef: 'owner-receipt-1',
      }),
    /operation_reused/,
    'an operation replay cannot annotate its source revision as the submitted result',
  );
  assert.deepEqual(store.works.get('operator', version.contentRef, 1), originalVersion);
  store.mutate(
    {
      ...input,
      expectedRevision: committed.review.revision,
      operationId: 'review-v5',
      round: 3,
      request: { fixtureOwnerReceipt: 'owner-receipt-5' },
    },
    (current) => appendRespondedVersion(current, { asset: asset(5), responses: [], actor, now }),
  );
  assert.deepEqual(finish().receipt, committed.receipt);
  const reopened = new ArtifactReviewStore(file);
  try {
    assert.equal(reopened.get(input.reviewId)?.rounds.at(-1)?.asset.ownerRevision, 5);
    assert.equal(reopened.works.get('operator', version.contentRef, 4)?.receiptRef, 'owner-receipt-4');
    assert.deepEqual(reopened.get(input.reviewId)?.rounds[2]?.responseSource, {
      round: 1,
      ownerRevision: 1,
      reviewRevision: 1,
    });
  } finally {
    reopened.close();
  }
});
