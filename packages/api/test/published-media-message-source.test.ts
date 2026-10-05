import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-message-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'cover.png'), bytes);
  const f = createReviewFixture(root, uploads);
  f.task.current = null;
  const source = {
    kind: 'message' as const,
    threadId: f.publication.threadId,
    messageId: f.publication.id,
    messageRevision: String(f.publication.timestamp),
    expectedUrl: '/uploads/cover.png',
    item: { kind: 'media-gallery' as const, blockId: 'image', itemIndex: 0 },
  };
  return { ...f, root, uploads, bytes, source };
}

test('a persisted message publication opens without any Task and reopens the same immutable owner', async (t) => {
  const f = await fixture(t);
  const input = { source: f.source, operationId: 'message-open', principal: reviewHuman };
  const asset = await f.media.prepare(input);
  assert.equal(f.task.current, null);
  assert.deepEqual(await f.media.bytes(asset.contentRef, 1, reviewCat), f.bytes);
  assert.deepEqual(await f.media.prepare({ ...input, operationId: 'open-from-artifacts' }), asset);
  assert.equal((await f.owner.listOutbox(asset.contentRef)).length, 1);
  const second = f.publish();
  const another = await f.media.prepare({
    ...input,
    operationId: 'different-message',
    source: { ...f.source, messageId: second.id, messageRevision: String(second.timestamp) },
  });
  assert.notEqual(another.contentRef, asset.contentRef, 'same bytes in another publication never merge ledgers');
});

test('task-free message admission rejects stale items and fresh revocation even after content is retained', async (t) => {
  const f = await fixture(t);
  const input = { source: f.source, operationId: 'message-open', principal: reviewHuman };
  await assert.rejects(
    f.media.prepare({ ...input, source: { ...f.source, expectedUrl: '/uploads/foreign.png' } }),
    /publication_changed/,
  );
  await assert.rejects(
    f.media.prepare({ ...input, source: { ...f.source, messageRevision: '999' } }),
    /publication_changed/,
  );
  const asset = await f.media.prepare(input);
  f.publication.visibility = 'whisper';
  f.publication.whisperTo = [];
  await assert.rejects(f.media.bytes(asset.contentRef, 1, reviewCat), /access_denied/);
  assert.deepEqual(await f.media.bytes(asset.contentRef, 1, reviewHuman), f.bytes);
  f.publication.recall = { recalledAt: 2000, recalledBy: 'operator' };
  await assert.rejects(f.media.bytes(asset.contentRef, 1, reviewHuman), /access_denied/);
  await assert.rejects(f.media.currentRevision(asset.contentRef, reviewHuman), /access_denied/);
});

test('human content-block uploads have exact item identity; a queued publication is not admitted', async (t) => {
  const f = await fixture(t);
  f.publication.catId = null;
  f.publication.extra = undefined;
  f.publication.contentBlocks = [{ type: 'image', url: '/uploads/cover.png' }];
  const input = {
    source: { ...f.source, item: { kind: 'content-block' as const, index: 0 } },
    operationId: 'human-upload',
    principal: reviewHuman,
  };
  const asset = await f.media.prepare(input);
  assert.deepEqual(await f.media.bytes(asset.contentRef, 1, reviewHuman), f.bytes);
  f.publication.deliveryStatus = 'queued';
  await assert.rejects(f.media.read(asset.contentRef, 1, reviewHuman), /access_denied/);
});
