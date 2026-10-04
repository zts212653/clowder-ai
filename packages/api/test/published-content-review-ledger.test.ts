import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';

test('a message version uses one task-free ledger; equal-byte next versions retain distinct read-only history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-publication-ledger-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#cab123' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'cover.png'), bytes);
  const f = createReviewFixture(root, uploads);
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
    principal: reviewHuman,
    operationId: 'message-open',
  });
  const dbPath = join(root, 'artifact-reviews.sqlite');
  const store = new ArtifactReviewStore(dbPath);
  const independent = new ArtifactReviewStore(dbPath);
  t.after(async () => {
    store.close();
    independent.close();
    await rm(root, { recursive: true, force: true });
  });
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      throw new Error('message content must not invent a workspace locator');
    },
  });
  const reviews = new WorkspaceContentReviewService({ source, store: store.ledgers, publications: f.media });
  const other = new WorkspaceContentReviewService({ source, store: independent.ledgers, publications: f.media });
  const publication = { contentRef: asset.contentRef, ownerRevision: 1 };
  const first = await reviews.prepare({ principal: reviewHuman, publication, operationId: 'open-chat' });
  assert.equal(first.review.source.kind, 'publication');
  await reviews.annotate({
    principal: reviewHuman,
    reviewId: first.review.reviewId,
    expectedRevision: 1,
    operationId: 'point-1',
    body: '保留暖光',
    target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 20 } },
  });
  const reopened = await other.prepare({ principal: reviewHuman, publication, operationId: 'open-artifacts' });
  assert.equal(reopened.review.reviewId, first.review.reviewId);
  assert.equal(reopened.review.annotations[0]?.body, '保留暖光');
  assert.equal(f.task.current, null);
  await f.owner.settle({
    contentRef: asset.contentRef,
    expectedOwnerRevision: 1,
    bytes,
    actor: { kind: 'cat', actorId: 'codex-astra' },
    operationId: 'owner-version-2',
    sourcePublication: asset.sourcePublication,
  });
  const next = await reviews.prepare({
    principal: reviewHuman,
    publication: { ...publication, ownerRevision: 2 },
    operationId: 'open-v2',
  });
  assert.notEqual(next.review.reviewId, first.review.reviewId);
  assert.equal(next.review.annotations.length, 0, 'same bytes do not carry old anchors into a new version');
  const historical = await other.read({ principal: reviewHuman, reviewId: first.review.reviewId });
  assert.equal(historical.canWrite, false);
  assert.equal(historical.historyReadOnly, true);
  assert.equal(historical.review.annotations[0]?.body, '保留暖光');
  await assert.rejects(
    reviews.annotate({
      principal: reviewHuman,
      reviewId: first.review.reviewId,
      expectedRevision: 2,
      operationId: 'late-comment',
      body: 'cannot write old version',
      target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 20 } },
    }),
    /source_changed/,
  );
  f.publication.recall = { recalledAt: 2000, recalledBy: 'operator' };
  await assert.rejects(other.read({ principal: reviewHuman, reviewId: first.review.reviewId }), /access_denied/);
});
