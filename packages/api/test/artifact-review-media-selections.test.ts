import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  type ArtifactReview,
  artifactReviewActionSchema,
  type ImmutableMedia,
} from '../../shared/src/types/artifact-review.js';
import { publicationLedgerId } from '../src/domains/collaborative-content/artifact-review/canonical-ledger.js';
import { commitReviewAction } from '../src/domains/collaborative-content/artifact-review/linked-review-action.js';
import { applyArtifactReviewAction } from '../src/domains/collaborative-content/artifact-review/reducer.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';

const actor = { kind: 'human', actorId: 'operator' } as const;
const now = '2026-10-03T06:00:00.000Z';
const selections = [
  {
    id: 'first',
    selection: { kind: 'image-region', x: 10, y: 20, width: 100, height: 80 },
    instruction: '移除左侧文字',
  },
  { id: 'second', selection: { kind: 'image-point', x: 600, y: 400 }, instruction: '这里增加一颗星星' },
] as const;
function command(items: readonly unknown[] = selections) {
  return artifactReviewActionSchema.parse({
    kind: 'request_media_edit',
    mediaType: 'image/png',
    annotationId: 'request-annotations',
    body: '保留整体风格，请一起修改这两处。',
    selections: items,
  });
}
function initial(media: ImmutableMedia = { kind: 'image', width: 800, height: 600 }): ArtifactReview {
  const asset = {
    contentRef: 'prepared-media:cover',
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: media.kind === 'image' ? ('image/png' as const) : ('video/mp4' as const),
    media,
    sourcePublication: { artifactRef: '/uploads/cover.png', sourceRef: 'message:thread:cover', revision: '1' },
    ownerReceiptRef: 'content-receipt-1',
  };
  return {
    version: 3,
    reviewId: 'review-cover',
    revision: 1,
    title: '封面',
    task: { taskId: 'task-cover', threadId: 'thread', ownerUserId: 'operator', observedRevision: 1 },
    contentRef: asset.contentRef,
    rounds: [
      {
        number: 1,
        asset,
        ledgerRef: publicationLedgerId('operator', asset),
        openedAt: now,
        state: 'draft',
        annotations: [],
        responses: [],
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
function apply(review: ArtifactReview, action = command(), principal = actor) {
  return applyArtifactReviewAction(review, {
    action,
    actor: principal,
    round: 1,
    ownerCatId: 'codex61-sol',
    now,
    receiptRef: 'request-receipt',
  });
}

test('two independent PNG ranges form one revision and one human decision', () => {
  const before = initial();
  const next = apply(before);
  const round = next.rounds[0];
  assert.ok(round);
  assert.equal(next.revision, 2);
  assert.deepEqual(
    round.annotations.map((item) => item.anchor),
    selections.map((item) => item.selection),
  );
  assert.deepEqual(
    round.annotations.map((item) => item.body),
    selections.map((item) => item.instruction),
  );
  assert.equal(new Set(round.annotations.map((item) => item.id)).size, 2);
  assert.ok(round.annotations.every((item) => item.id.length <= 128));
  assert.deepEqual(round.decision?.actor, actor);
  assert.equal(round.decision?.explanation, '保留整体风格，请一起修改这两处。');
  assert.equal(round.state, 'changes_requested');
  assert.equal(before.rounds[0]?.annotations.length, 0);
});

test('invalid second range rejects the whole action without changing the predecessor', () => {
  const before = initial();
  const snapshot = structuredClone(before);
  assert.throws(
    () =>
      apply(before, command([selections[0], { ...selections[1], selection: { kind: 'image-point', x: 900, y: 20 } }])),
    /invalid_anchor/,
  );
  assert.deepEqual(before, snapshot);
});

test('selection identity, mixed media, legacy alias and bounds are validated', () => {
  assert.throws(() => command([selections[0], selections[0]]));
  assert.throws(() => command([]));
  assert.throws(() => command(Array.from({ length: 13 }, (_, i) => ({ ...selections[0], id: String(i) }))));
  assert.throws(() => command([{ ...selections[0], instruction: '' }]));
  assert.throws(() =>
    artifactReviewActionSchema.parse({
      ...command(),
      anchor: { kind: 'image-point', x: 1, y: 1 },
    }),
  );
  assert.throws(
    () =>
      apply(
        initial(),
        command([
          selections[0],
          { id: 'video', selection: { kind: 'video-range', streamId: 'v', startTick: 0, endTick: 1 } },
        ]),
      ),
    /invalid_anchor/,
  );
});

test('whole image and existing single MP4 anchor keep their original action behavior', () => {
  const whole = artifactReviewActionSchema.parse({
    kind: 'request_media_edit',
    mediaType: 'image/png',
    annotationId: 'whole',
    body: '整体改为暖色。',
  });
  assert.deepEqual(apply(initial(), whole).rounds[0]?.annotations[0]?.anchor, {
    kind: 'image-region',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
  const video: ImmutableMedia = {
    kind: 'video',
    width: 800,
    height: 600,
    codedWidth: 800,
    codedHeight: 600,
    rotation: 0,
    pixelAspectRatio: { numerator: 1, denominator: 1 },
    streamId: 'main',
    streamIndex: 0,
    timebase: { numerator: 1, denominator: 1000 },
    startTick: 0,
    durationTicks: 10000,
    containerStartSeconds: 0,
  };
  const anchor = { kind: 'video-range', streamId: 'main', startTick: 100, endTick: 900 } as const;
  const action = artifactReviewActionSchema.parse({
    kind: 'request_media_edit',
    mediaType: 'video/mp4',
    annotationId: 'clip',
    body: '调整这一段。',
    anchor,
  });
  assert.deepEqual(apply(initial(video), action).rounds[0]?.annotations[0]?.anchor, anchor);
});

test('linked media ledger, request return and audit roll back together and replay once after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-media-selections-'));
  const path = join(root, 'review.sqlite');
  const store = new ArtifactReviewStore(path);
  const db = new Database(path);
  t.after(async () => {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const review = initial();
  const ledgerRef = review.rounds[0]?.ledgerRef;
  assert.ok(ledgerRef);
  store.create(review, { operationId: 'prepare', actor, now });
  const action = command();
  const input = {
    reviewId: review.reviewId,
    expectedRevision: 1,
    operationId: 'single-request',
    actor,
    now,
    round: 1,
    kind: action.kind,
    request: { requestId: 'f309-single-request', action },
    returnTarget: { targetCatId: 'codex61-sol', expectedTaskRevision: 1, requestId: 'f309-single-request' },
  };
  const commit = (owner = store) =>
    owner.replay(input) ??
    commitReviewAction(
      owner,
      input,
      (value, receiptRef) =>
        applyArtifactReviewAction(value, { action, actor, round: 1, ownerCatId: 'codex61-sol', now, receiptRef }),
      1,
    );
  db.exec(
    "CREATE TRIGGER fail_media_return BEFORE INSERT ON artifact_review_returns BEGIN SELECT RAISE(ABORT, 'return failed'); END",
  );
  assert.throws(() => commit(), /return failed/);
  assert.equal(store.get(review.reviewId)?.revision, 1);
  assert.equal(store.ledgers.get(ledgerRef)?.annotations.length, 0);
  assert.equal(store.history(review.reviewId).length, 1);
  assert.equal(store.returns.pending().length, 0);
  db.exec('DROP TRIGGER fail_media_return');
  const first = commit();
  assert.equal(first.review.rounds[0]?.annotations.length, 2);
  assert.equal(store.ledgers.get(ledgerRef)?.annotations.length, 2);
  assert.equal(store.returns.pending().length, 1);
  const restarted = new ArtifactReviewStore(path);
  t.after(() => restarted.close());
  assert.deepEqual(commit(restarted).receipt, first.receipt);
  assert.equal(restarted.history(review.reviewId).length, 2);
  assert.equal(restarted.returns.pending().length, 1);
  assert.equal(restarted.get(review.reviewId)?.rounds[0]?.annotations.length, 2);
});
