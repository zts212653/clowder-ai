import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { ArtifactReview } from '../../shared/src/types/artifact-review.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';

const actor = { kind: 'human', actorId: 'operator' } as const;
const now = '2026-09-07T12:30:00.000Z';
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
