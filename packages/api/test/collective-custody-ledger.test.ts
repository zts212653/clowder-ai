import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { prepareCanonicalWorkspaceReview } from '../src/domains/collaborative-content/workspace-review/workspace-review-preparation.js';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { baseConstraint, fixture, scope } from './collective-markdown.fixture.js';

test('the scoped ledger snapshot preserves annotations, retained history and operation replay after local owner rebinding', async (t) => {
  const f = await fixture(t);
  const command = {
    kind: 'annotate',
    messageEventId: 'feedback-bob',
    body: 'Please clarify.',
    quote: 'A unique shared quote.',
    location: { channelId: 'general', rootEventId: scope.sourceEventId },
    expectedReviewRevision: 1,
  };
  const annotated = await f.execute(
    { ...baseConstraint, action: 'annotate', humanId: 'human-bob' },
    command,
    'bob-note',
  );
  assert.equal(annotated.status, 'ok');
  const scopeRef = collectiveContentScopeRef(scope);
  const source = f.reviews.getByContent('real-local-owner', scope.contentRef, scopeRef);
  assert.ok(source);
  f.reviews.retained.retain(source.reviewId, source.revision);
  const snapshot = f.reviews.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef);
  assert.ok(snapshot);
  const dir = await mkdtemp(join(tmpdir(), 'f290-custody-ledger-'));
  const destination = new WorkspaceContentReviewStore(join(dir, 'target.sqlite'));
  t.after(async () => {
    destination.close();
    await rm(dir, { recursive: true, force: true });
  });
  destination.collectiveCustody.installSnapshot(snapshot, scopeRef, scope.contentRef, 'target-real-local-owner');
  destination.collectiveCustody.installSnapshot(snapshot, scopeRef, scope.contentRef, 'target-real-local-owner');
  const restored = destination.get(source.reviewId);
  assert.deepEqual(restored, { ...source, ownerUserId: 'target-real-local-owner' });
  assert.deepEqual(
    destination.operationReceipt(source.reviewId, 'bob-note'),
    f.reviews.operationReceipt(source.reviewId, 'bob-note'),
  );
  assert.deepEqual(destination.retained.get(source.reviewId, source.revision), restored);
  assert.equal(destination.getByContent('target-real-local-owner', scope.contentRef), null);
  const invalid = {
    ...snapshot,
    review: {
      ...snapshot.review,
      annotations: snapshot.review.annotations.map((annotation) => ({
        ...annotation,
        projectMessage: { threadId: 'private-thread' },
      })),
    },
  };
  assert.throws(() => destination.collectiveCustody.validateSnapshot(invalid, scopeRef, scope.contentRef));
  assert.throws(() => destination.collectiveCustody.validateSnapshot(snapshot, 'wrong-scope', scope.contentRef));
  const forgedReceipt = structuredClone(snapshot);
  forgedReceipt.operations[0].receipt.receiptRef = 'forged-receipt';
  assert.throws(() => destination.collectiveCustody.validateSnapshot(forgedReceipt, scopeRef, scope.contentRef));
  const changed = structuredClone(snapshot);
  changed.review.annotations[0].body = 'A colliding different ledger';
  assert.throws(() =>
    destination.collectiveCustody.installSnapshot(changed, scopeRef, scope.contentRef, 'target-real-local-owner'),
  );
  assert.deepEqual(destination.get(source.reviewId), restored);
});

test('all three durable receipt generations retain their original replay behavior across custody', () => {
  const db = new Database(':memory:');
  const targetDb = new Database(':memory:');
  const source = new WorkspaceContentReviewStore(db);
  const target = new WorkspaceContentReviewStore(targetDb);
  try {
    const scopeRef = collectiveContentScopeRef(scope);
    let review = prepareCanonicalWorkspaceReview(
      source,
      {
        contentRef: scope.contentRef,
        source: {
          kind: 'collective-artifact',
          revision: baseConstraint.blobDigest,
          ownerRevision: 1,
          mime: 'text/markdown',
          byteLength: 30,
        },
      },
      {
        principal: { userId: 'source-local-owner', actor: { kind: 'human', actorId: 'human-alice' } },
        operationId: 'prepare',
        request: {},
        collaborationScope: {
          kind: 'collective-artifact',
          scopeRef,
          serviceInstanceId: scope.serviceInstanceId,
          collectiveId: scope.collectiveId,
          artifactId: scope.artifactId,
        },
      },
      '2026-10-16T19:00:00.000Z',
    );
    const inputs = ['legacy', 'result', 'receipt'].map((kind, index) => ({
      reviewId: review.reviewId,
      expectedRevision: index + 1,
      operationId: kind,
      actor: { kind: 'cat', actorId: 'codex61-sol' } as const,
      now: review.createdAt,
      kind: 'test-history',
      request: { kind },
    }));
    for (const input of inputs) {
      review = source.mutate(input, (current) => ({ ...current, revision: current.revision + 1 })).review;
      source.retained.retain(review.reviewId, review.revision);
    }
    db.prepare(
      `INSERT INTO workspace_content_review_operations SELECT review_id,operation_id,fingerprint,receipt,result_revision FROM workspace_content_review_operation_receipts WHERE operation_id='legacy'`,
    ).run();
    db.prepare(
      `INSERT INTO workspace_content_review_operation_results SELECT review_id,operation_id,fingerprint,receipt,? FROM workspace_content_review_operation_receipts WHERE operation_id='result'`,
    ).run(JSON.stringify(source.retained.get(review.reviewId, 3)));
    db.prepare(
      `DELETE FROM workspace_content_review_operation_receipts WHERE operation_id IN ('legacy','result')`,
    ).run();
    const snapshot = source.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef);
    assert.ok(snapshot);
    target.collectiveCustody.installSnapshot(snapshot, scopeRef, scope.contentRef, 'destination-local-owner');
    assert.equal(target.replay(inputs[0])?.review.revision, 4);
    assert.equal(target.replay(inputs[1])?.review.revision, 3);
    assert.equal(target.replay(inputs[2])?.review.revision, 4);
    for (const input of inputs) assert.deepEqual(target.replay(input)?.receipt, source.replay(input)?.receipt);
    const wrong = {
      ...snapshot,
      operations: snapshot.operations.map((item) => ({
        ...item,
        receipt: { ...item.receipt, preparationSource: { kind: 'human_message', threadId: 'private-thread' } },
      })),
    };
    assert.throws(() => target.collectiveCustody.validateSnapshot(wrong, scopeRef, scope.contentRef));
    assert.equal(JSON.stringify(snapshot).includes('private-thread'), false);
  } finally {
    db.close();
    targetDb.close();
  }
});
