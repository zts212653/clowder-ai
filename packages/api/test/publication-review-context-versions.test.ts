import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('a context at another version cannot block a readable exact-version context or create a new ledger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-context-versions-'));
  await writeFile(
    join(root, 'review-input.png'),
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#abc123' } })
      .png()
      .toBuffer(),
  );
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  assert.ok(f.ledgers);
  t.after(async () => {
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const view = await f.reviews.prepare(f.prepare, f.human);
  const target = view.review.rounds[0]!.asset;
  // Isolate the directory join from media production: this second authorized projection only has another version.
  const other = structuredClone(view);
  other.review.reviewId = `review-${'a'.repeat(64)}`;
  other.review.rounds[0]!.asset.ownerRevision = 2;
  const read = f.reviews.readCurrent.bind(f.reviews);
  t.mock.method(f.reviews, 'readCurrent', async (id: string, principal: Parameters<typeof read>[1]) =>
    id === other.review.reviewId ? other : read(id, principal),
  );
  const candidates = t.mock.method(f.store.directory, 'forPublication', () => [other.review, view.review]);
  const contexts = await f.ledgers.resolvePublication(target, f.human);
  assert.deepEqual(
    contexts.map((item) => [item.reviewId, item.round, item.state, item.taskState]),
    [[view.review.reviewId, 1, 'draft', 'active']],
  );
  const before = f.store.listReviewIds('operator');
  await assert.rejects(
    f.ledgers.prepare({ publication: target, operationId: 'open-existing', principal: f.human }),
    /existing_contexts/,
  );
  assert.deepEqual(f.store.listReviewIds('operator'), before);
  candidates.mock.mockImplementation(() => [other.review]);
  await assert.rejects(
    f.ledgers.resolvePublication(target, f.human),
    /version_pending/,
    'no exact context is not permission to manufacture an empty ledger',
  );
});

test('a publication that no longer exists resolves to not_found, not an unknown server error', async (t) => {
  // Real page 2026-09-23: a restored review tab kept polling resolve for a publication missing from
  // this data root; every poll came back 500 workspace_content_unavailable.
  const root = await mkdtemp(join(tmpdir(), 'f309-missing-publication-'));
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  assert.ok(f.ledgers);
  t.after(async () => {
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    f.ledgers.resolvePublication({ contentRef: `prepared-media:${'b'.repeat(64)}`, ownerRevision: 1 }, f.human),
    (error: unknown) => (error as { code?: string }).code === 'not_found',
  );
});
