import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { ArtifactReview } from '../../shared/src/types/artifact-review.js';
import { publicationLedgerId } from '../src/domains/collaborative-content/artifact-review/canonical-ledger.js';
import { applyArtifactReviewAction } from '../src/domains/collaborative-content/artifact-review/reducer.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { publicationLedgerSource } from '../src/domains/collaborative-content/workspace-review/publication-review-source.js';

const actor = { kind: 'human', actorId: 'operator' } as const;
const now = '2026-09-07T12:30:00.000Z';
test('a first Task review binds an already existing publication ledger inside its creation transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-existing-ledger-first-'));
  const store = new ArtifactReviewStore(join(root, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const candidate = initial(),
    asset = candidate.rounds[0]!.asset;
  const source = publicationLedgerSource(asset),
    reviewId = publicationLedgerId('operator', asset);
  store.ledgers.create(
    {
      version: 1,
      reviewId,
      contentRef: `${asset.contentRef}#version:1`,
      ownerUserId: 'operator',
      revision: 1,
      source,
      createdAt: now,
      updatedAt: now,
      annotations: [
        {
          id: 'existing-discussion',
          body: '先于Task审阅的讨论',
          anchor: { baseRevision: source.revision, anchor: { kind: 'image-point', x: 3, y: 4 } },
          author: actor,
          createdAt: now,
          updatedAt: now,
          state: 'open',
          replies: [],
        },
      ],
    },
    { operationId: 'original-ledger', kind: 'prepare', request: { publication: asset }, actor, now },
  );
  const bound = store.create(candidate, { operationId: 'task-open', actor, now });
  assert.equal(bound.rounds[0]?.ledgerRef, reviewId);
  assert.equal(bound.rounds[0]?.annotations[0]?.body, '先于Task审阅的讨论');
  assert.equal(store.ledgers.get(reviewId)?.revision, 1, 'binding is not a copied comment mutation');
});
function initial(): ArtifactReview {
  return {
    version: 1,
    reviewId: 'review',
    revision: 1,
    title: '正式封面',
    contentRef: 'prepared-media:cover',
    task: { taskId: 'task', threadId: 'thread', ownerUserId: 'operator', observedRevision: 5 },
    createdAt: now,
    updatedAt: now,
    rounds: [
      {
        number: 1,
        asset: {
          contentRef: 'prepared-media:cover',
          ownerRevision: 1,
          blobDigest: `sha256:${'a'.repeat(64)}`,
          mediaType: 'image/png',
          media: { kind: 'image', width: 800, height: 600 },
          sourcePublication: { artifactRef: '/uploads/cover.png', sourceRef: 'message:thread:m1', revision: '1' },
          ownerReceiptRef: 'content-receipt-1',
        },
        openedAt: now,
        state: 'draft',
        annotations: [],
        responses: [],
      },
    ],
  };
}

test('the canonical ledger and human return intent roll back together and replay after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-ledger-return-atomic-'));
  const path = join(root, 'review.sqlite');
  const store = new ArtifactReviewStore(path);
  const database = new Database(path);
  t.after(async () => {
    database.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.create(initial(), { operationId: 'prepare', actor, now });
  const sourceRevision = `sha256:${'a'.repeat(64)}`;
  store.ledgers.create(
    {
      version: 1,
      reviewId: 'canonical-ledger',
      contentRef: 'canonical-content',
      ownerUserId: 'operator',
      revision: 1,
      source: {
        kind: 'media',
        locator: { worktreeId: 'original', path: 'cover.png' },
        revision: sourceRevision,
        mime: 'image/png',
        byteLength: 100,
        media: { kind: 'image', width: 800, height: 600 },
      },
      annotations: [],
      createdAt: now,
      updatedAt: now,
    },
    { operationId: 'prepare-ledger', actor, now, kind: 'prepare', request: {} },
  );
  const input = {
    reviewId: 'review',
    expectedRevision: 1,
    operationId: 'request-1',
    actor,
    now,
    round: 1,
    kind: 'request_image_edit',
    request: { ledgerRef: 'canonical-ledger' },
    returnTarget: { targetCatId: 'codex-astra', expectedTaskRevision: 5 },
  };
  const ledgerInput = {
    reviewId: 'canonical-ledger',
    expectedRevision: 1,
    operationId: input.operationId,
    actor,
    now,
    kind: 'request_image_edit',
    request: { note: '保留暖光' },
  };
  const commit = () =>
    store.mutateWithLedger(input, ledgerInput, {
      ledger: (ledger) => ({
        ...ledger,
        revision: 2,
        updatedAt: now,
        visualMarks: [
          {
            drawing: {
              id: 'mark',
              kind: 'text',
              at: { x: 20, y: 30 },
              text: '保留暖光',
              color: '#d04a3a',
              strokeWidth: 4,
              fontSize: 18,
            },
            baseRevision: sourceRevision,
            author: actor,
            createdAt: now,
            state: 'active',
          },
        ],
      }),
      review: (review, receiptRef) =>
        applyArtifactReviewAction(review, {
          action: {
            kind: 'request_image_edit',
            annotationId: 'request-note',
            edit: { kind: 'aspect-ratio', ratio: '16:9' },
          },
          actor,
          round: 1,
          ownerCatId: 'codex-astra',
          now,
          receiptRef,
        }),
    });
  database.exec(
    "CREATE TRIGGER fail_return BEFORE INSERT ON artifact_review_returns BEGIN SELECT RAISE(ABORT, 'return failed'); END",
  );
  assert.throws(commit, /return failed/);
  assert.equal(store.ledgers.get('canonical-ledger')?.revision, 1);
  assert.equal(store.get('review')?.revision, 1);
  assert.equal(store.returns.pending().length, 0);
  assert.equal(store.ledgers.replay(ledgerInput), null);
  database.exec('DROP TRIGGER fail_return');
  const committed = commit();
  assert.equal(committed.ledger.review.revision, 2);
  assert.equal(store.returns.pending().length, 1);
  assert.equal(commit().review.receipt.receiptRef, committed.review.receipt.receiptRef);
  const restarted = new ArtifactReviewStore(path);
  assert.equal(restarted.ledgers.get('canonical-ledger')?.visualMarks?.length, 1);
  assert.equal(restarted.returns.pending()[0]?.receiptRef, committed.review.receipt.receiptRef);
  assert.throws(
    () =>
      restarted.mutateWithLedger(
        input,
        { ...ledgerInput, request: { changed: true } },
        { ledger: (value) => value, review: (value) => value },
      ),
    /operation_reused/,
  );
  restarted.close();
});

test('two connections CAS the same aggregate; restart preserves operation, history, and exact replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-review-store-'));
  const path = join(root, 'review.sqlite');
  const first = new ArtifactReviewStore(path);
  const other = new ArtifactReviewStore(path);
  t.after(async () => {
    first.close();
    other.close();
    await rm(root, { recursive: true, force: true });
  });
  first.create(initial(), { operationId: 'prepare', actor, now });
  const command = {
    reviewId: 'review',
    expectedRevision: 1,
    operationId: 'edit',
    actor,
    now,
    round: 1,
    kind: 'edit',
    request: { text: 'first' },
  };
  const transition = (review: ArtifactReview) => ({ ...review, revision: review.revision + 1, title: '已修订' });
  const committed = first.mutate(command, transition);
  assert.equal(committed.review.revision, 2);
  assert.throws(() => other.mutate({ ...command, operationId: 'other' }, transition), /revision_conflict/);
  assert.deepEqual(other.mutate(command, transition).receipt, committed.receipt);
  assert.throws(() => other.mutate({ ...command, request: { text: 'different' } }, transition), /operation_reused/);
  assert.throws(
    () => other.mutate({ ...command, actor: { kind: 'cat', actorId: 'codex-astra' } }, transition),
    /operation_reused/,
  );
  const restarted = new ArtifactReviewStore(path);
  assert.equal(restarted.get('review')?.title, '已修订');
  assert.equal(restarted.history('review').length, 2);
  assert.deepEqual(restarted.history('review')[1]?.receipt, committed.receipt);
  assert.equal(restarted.listForOwner('another-user').length, 0);
  assert.equal(restarted.listForOwner('operator').length, 1);
  assert.deepEqual(restarted.listForTask('operator', 'task'), [restarted.get('review')]);
  assert.deepEqual(restarted.listForTask('another-user', 'task'), []);
  assert.deepEqual(restarted.listForTask('operator', 'another-task'), []);
  restarted.close();
});

test('failure while writing a receipt rolls back the aggregate and audit as one transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-review-atomic-'));
  const path = join(root, 'review.sqlite');
  const store = new ArtifactReviewStore(path);
  const database = new Database(path);
  t.after(async () => {
    database.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.create(initial(), { operationId: 'prepare', actor, now });
  database.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON artifact_review_operations WHEN NEW.operation_id = 'crash' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END",
  );
  assert.throws(
    () =>
      store.mutate(
        {
          reviewId: 'review',
          expectedRevision: 1,
          operationId: 'crash',
          actor,
          now,
          round: 1,
          kind: 'edit',
          request: { value: 'new' },
        },
        (review) => ({ ...review, revision: 2, title: 'must roll back' }),
      ),
    /simulated disk failure/,
  );
  assert.equal(store.get('review')?.revision, 1);
  assert.equal(store.get('review')?.title, '正式封面');
  assert.equal(store.history('review').length, 1);
});

test('a durable media response intent fences other writes until its owner receipt is projected once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-review-pending-'));
  const path = join(root, 'review.sqlite');
  const store = new ArtifactReviewStore(path);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.create(initial(), { operationId: 'prepare', actor, now });
  const intent = {
    reviewId: 'review',
    expectedRevision: 1,
    operationId: 'version-2',
    actor,
    now,
    round: 1,
    kind: 'respond_with_version',
    request: { responses: ['title-addressed'] },
  };
  store.reserveVersion(intent, { source: 'message:thread:version-2' });
  assert.equal(store.pendingVersion('review')?.input.operationId, 'version-2');
  assert.throws(
    () => store.mutate({ ...intent, operationId: 'comment-race' }, (review) => ({ ...review, revision: 2 })),
    /version_pending/,
  );
  assert.throws(() => store.reserveVersion({ ...intent, request: { different: true } }, {}), /operation_reused/);
  const restarted = new ArtifactReviewStore(path);
  assert.equal(restarted.pendingVersion('review')?.input.operationId, 'version-2');
  const committed = restarted.finishVersion(intent, (review) => ({ ...review, revision: 2 }));
  assert.equal(committed.receipt.outcome, 'applied');
  assert.equal(store.pendingVersion('review'), null);
  assert.deepEqual(store.finishVersion(intent, (review) => review).receipt, committed.receipt);
  restarted.close();
});
