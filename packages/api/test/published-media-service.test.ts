import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-published-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'cover.png'), bytes);
  return { ...createReviewFixture(root, uploads), root, uploads, bytes };
}

test('explicit preparation uses the original publication and owner; re-import never changes Task or media history', async (t) => {
  const f = await fixture(t);
  const asset = await f.media.prepare(f.prepare);
  assert.equal(asset.ownerRevision, 1);
  assert.equal(asset.sourcePublication.sourceRef, 'message:thread-cover:media-1');
  assert.deepEqual(await f.media.bytes(asset.contentRef, 1, reviewCat), f.bytes);
  assert.deepEqual(await f.media.prepare({ ...f.prepare, operationId: 'another-open' }), asset);
  assert.equal((await f.owner.listOutbox(asset.contentRef)).length, 1);
  assert.deepEqual(f.task.current?.entrustedWork?.artifactRefs, ['/uploads/cover.png']);
  await f.media.assertVisible(
    asset,
    { ownerUserId: 'operator', threadId: 'thread-cover', taskId: 'task-cover' },
    reviewHuman,
  );
});

test('fresh owner/thread/source authorization fences cached metadata and retained bytes after revocation', async (t) => {
  const f = await fixture(t);
  const asset = await f.media.prepare(f.prepare);
  await assert.rejects(
    f.media.read(asset.contentRef, 1, { userId: 'other', actor: { kind: 'human', actorId: 'other' } }),
    /access_denied/,
  );
  await assert.rejects(f.media.read(asset.contentRef, 1, { ...reviewCat, threadId: 'other-thread' }), /access_denied/);
  f.publication.visibility = 'whisper';
  f.publication.whisperTo = [];
  await assert.rejects(f.media.read(asset.contentRef, 1, reviewCat), /access_denied/);
  assert.deepEqual(await f.media.bytes(asset.contentRef, 1, reviewHuman), f.bytes);
  f.publication.recall = { recalledAt: 1100, recalledBy: 'operator' };
  await assert.rejects(f.media.bytes(asset.contentRef, 1, reviewHuman), /access_denied/);
});

test('unsettled stream publications, symlinks, traversal, stale publication and foreign task pointers are rejected', async (t) => {
  const f = await fixture(t);
  f.publication.deliveryStatus = 'queued';
  f.publication.origin = 'stream';
  await assert.rejects(f.media.prepare(f.prepare), /publication_changed|access_denied/);
  f.publication.deliveryStatus = 'delivered';
  await assert.rejects(f.media.prepare({ ...f.prepare, expectedArtifactRevision: 'old' }), /publication_changed/);
  await assert.rejects(
    f.media.prepare({ ...f.prepare, artifactRef: '/uploads/../secret.png' }),
    /publication_changed|invalid_media/,
  );
  await rm(join(f.uploads, 'cover.png'));
  await writeFile(join(f.root, 'private.png'), f.bytes);
  await symlink(join(f.root, 'private.png'), join(f.uploads, 'cover.png'));
  await assert.rejects(f.media.prepare(f.prepare), /media_unavailable/);
  if (f.task.current) f.task.current = { ...f.task.current, threadId: 'foreign-thread' };
  await assert.rejects(f.media.prepare(f.prepare), /access_denied|publication_changed/);
});
