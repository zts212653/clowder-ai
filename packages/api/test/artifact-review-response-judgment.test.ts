import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type ArtifactReview,
  artifactReviewCommandSchema,
  type ReviewedMediaAsset,
  workReviewResponseSchema,
} from '@cat-cafe/shared';
import {
  ensureRoundLedgers,
  ledgerFromRound,
  publicationLedgerId,
} from '../src/domains/collaborative-content/artifact-review/canonical-ledger.js';
import { commitReviewAction } from '../src/domains/collaborative-content/artifact-review/linked-review-action.js';
import {
  appendRespondedVersion,
  applyArtifactReviewAction,
} from '../src/domains/collaborative-content/artifact-review/reducer.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { publicationLedgerSource } from '../src/domains/collaborative-content/workspace-review/publication-review-source.js';

const now = '2026-10-20T21:10:00.000Z';
const human = { kind: 'human' as const, actorId: 'operator' };
const cat = { kind: 'cat' as const, actorId: 'director' };
const asset: ReviewedMediaAsset = {
  contentRef: 'work:judgment',
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 100, height: 100 },
  sourcePublication: { artifactRef: 'cover.png', sourceRef: 'workspace:work:cover.png', revision: '1' },
  ownerReceiptRef: 'owner-v1',
};
function initial(): ArtifactReview {
  return {
    version: 3,
    reviewId: 'review',
    revision: 1,
    title: 'Original opinion',
    task: { taskId: 'original', threadId: 'production', ownerUserId: 'operator', observedRevision: 1 },
    contentRef: asset.contentRef,
    createdAt: now,
    updatedAt: now,
    rounds: [
      {
        number: 1,
        asset,
        openedAt: now,
        state: 'changes_requested',
        responses: [],
        ledgerRef: publicationLedgerId('operator', asset),
        annotations: [
          {
            id: 'opinion',
            body: 'Move title',
            anchor: { kind: 'image-point', x: 10, y: 20 },
            author: human,
            createdAt: now,
            updatedAt: now,
            state: 'open',
            replies: [],
          },
        ],
      },
    ],
  };
}
function responded(review = initial(), ownerRevision = 4) {
  return appendRespondedVersion(review, {
    asset: { ...asset, ownerRevision, ownerReceiptRef: `owner-v${ownerRevision}` },
    sourceRound: 1,
    actor: cat,
    now,
    responses: [
      {
        annotationId: 'opinion',
        disposition: 'addressed',
        explanation: 'Moved',
        resultAnchor: { kind: 'image-point', x: 30, y: 40 },
      },
    ],
  });
}
function command(review: ArtifactReview, outcome = 'accepted', operationId = outcome) {
  return artifactReviewCommandSchema.parse({
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    expectedTaskRevision: 1,
    expectedLedgerRevision: review.rounds[0]!.ledgerRevision,
    round: 2,
    operationId,
    action: { kind: 'judge_response', sourceRound: 1, annotationId: 'opinion', resultOwnerRevision: 4, outcome },
  });
}
function transition(review: ArtifactReview, raw: unknown, actor = human) {
  const input = artifactReviewCommandSchema.parse(raw);
  return applyArtifactReviewAction(review, {
    action: input.action,
    round: input.round,
    actor,
    ownerCatId: 'director',
    now,
    receiptRef: `receipt:${input.operationId}`,
  });
}

test('a Human judgment binds v1 opinion to exact v4 response, separately from cat addressed and whole-version approval', () => {
  const review = responded();
  assert.equal(review.rounds[0]!.annotations[0]!.state, 'open');
  const input = command(review);
  const accepted = transition(review, input);
  assert.equal(accepted.rounds[0]!.annotations[0]!.state, 'resolved');
  assert.deepEqual(accepted.rounds[1]!.responses[0]!.judgment, {
    outcome: 'accepted',
    actor: human,
    decidedAt: now,
    receiptRef: 'receipt:accepted',
  });
  assert.equal(accepted.rounds[1]!.state, 'draft');
  const reopened = transition(accepted, command(accepted, 'reopened'));
  assert.equal(reopened.rounds[0]!.annotations[0]!.state, 'open');
  assert.equal(reopened.rounds[1]!.responses[0]!.judgment?.outcome, 'reopened');
  assert.equal(review.rounds[1]!.responses[0]!.judgment, undefined);
  assert.equal(
    workReviewResponseSchema.safeParse({
      reviewId: 'review',
      sourceRound: 1,
      expectedReviewRevision: 1,
      expectedTaskRevision: 1,
      responses: accepted.rounds[1]!.responses,
    }).success,
    false,
    'A cat cannot submit a forged Human judgment',
  );
  assert.throws(() => transition(review, input, cat), /human_required/);
  assert.throws(
    () => transition(review, { ...input, action: { ...input.action, resultOwnerRevision: 5 } }),
    /asset_changed/,
  );
  const newer = responded(review, 5);
  assert.throws(
    () => transition(newer, command(newer)),
    { code: 'asset_changed' },
    'A stale v4 button cannot resolve the same opinion after a newer response exists',
  );
});

test('response judgment atomically writes original canonical ledger and review audit, replays once and survives reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f326-response-judgment-'));
  const db = join(root, 'review.sqlite');
  let store = new ArtifactReviewStore(db);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const review = responded();
  const source = publicationLedgerSource(asset);
  const ledger = {
    version: 1 as const,
    reviewId: publicationLedgerId('operator', asset),
    ownerUserId: 'operator',
    contentRef: `${asset.contentRef}#version:1`,
    source,
    sourceHistory: [source],
    revision: 1,
    annotations: [],
    createdAt: now,
    updatedAt: now,
  };
  store.ledgers.create(
    { ...ledgerFromRound(ledger, review.rounds[0]!, 'original', now), revision: 1 },
    { operationId: 'original', actor: human, now, kind: 'prepare', request: {} },
  );
  store.create(initial(), { operationId: 'prepare', actor: human, now });
  ensureRoundLedgers(store.ledgers, responded(store.get('review')!), cat);
  store.mutate(
    {
      reviewId: 'review',
      expectedRevision: 1,
      operationId: 'response',
      actor: cat,
      now,
      round: 1,
      kind: 'respond_with_version',
      request: {},
    },
    (current) => responded(current),
  );
  function apply(outcome: string, operationId: string, expectedLedgerRevision?: number) {
    const before = store.get('review')!;
    const input = command(before, outcome, operationId);
    const mutation = {
      reviewId: input.reviewId,
      expectedRevision: input.expectedRevision,
      operationId,
      actor: human,
      now,
      round: input.round,
      kind: input.action.kind,
      request: input,
    };
    return {
      input,
      mutation,
      result: commitReviewAction(
        store,
        mutation,
        (current) => transition(current, input),
        expectedLedgerRevision ?? input.expectedLedgerRevision,
      ),
    };
  }
  const accepted = apply('accepted', 'accept');
  assert.equal(store.ledgers.get(ledger.reviewId)!.annotations[0]!.state, 'resolved');
  const audit = store.history('review').at(-1)!;
  assert.equal(audit.kind, 'judge_response');
  assert.equal(audit.round, 2);
  assert.equal(store.replay(accepted.mutation)!.replayed, true);
  const ledgerRevision = store.ledgers.get(ledger.reviewId)!.revision;
  assert.throws(() => apply('reopened', 'stale', ledgerRevision - 1), /revision_conflict/);
  assert.equal(store.get('review')!.rounds[1]!.responses[0]!.judgment?.outcome, 'accepted');
  apply('reopened', 'reopen');
  store.close();
  store = new ArtifactReviewStore(db);
  assert.equal(store.get('review')!.rounds[1]!.responses[0]!.judgment?.outcome, 'reopened');
  assert.equal(store.ledgers.get(ledger.reviewId)!.annotations[0]!.state, 'open');
  assert.equal(store.ledgers.get(ledger.reviewId)!.annotations.length, 1);
});
