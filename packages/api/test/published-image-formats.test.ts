import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { probeImmutableMedia } from '../src/domains/video-studio/content-owner/published-media-probe.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';

const formats = [
  { extension: 'jpg', mime: 'image/jpeg', format: 'jpeg' },
  { extension: 'webp', mime: 'image/webp', format: 'webp' },
] as const;
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function image(format: 'jpeg' | 'webp', orientation = 1) {
  return sharp({ create: { width: 12, height: 8, channels: 3, background: '#824bd6' } })
    .withMetadata({ orientation })
    .toFormat(format)
    .toBuffer();
}
for (const { extension, mime, format } of formats) {
  for (const orientation of [1, 2, 6, 7]) {
    test(`${mime}: immutable probe uses actual EXIF display geometry ${orientation} without rewriting bytes`, async () => {
      const bytes = await image(format, orientation);
      const before = digest(bytes);
      assert.deepEqual(await probeImmutableMedia(bytes, mime), {
        kind: 'image',
        width: orientation >= 5 ? 8 : 12,
        height: orientation >= 5 ? 12 : 8,
      });
      assert.equal(digest(bytes), before);
    });
  }
  test(`${mime}: corrupt, mismatched and animated content cannot acquire still-image admission`, async () => {
    const bytes = await image(format);
    await assert.rejects(
      probeImmutableMedia(bytes, mime === 'image/jpeg' ? 'image/webp' : 'image/jpeg'),
      /invalid_media/,
    );
    await assert.rejects(probeImmutableMedia(bytes.subarray(0, 20), mime), /invalid_media/);
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
    await assert.rejects(probeImmutableMedia(animated, mime), /invalid_media/);
  });
  test(`${mime}: original F063 source keeps MIME, locator, SHA and bytes, and refuses changed source or principal`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-image-source-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = `original.${extension}`,
      bytes = await image(format, 6);
    await writeFile(join(root, path), bytes);
    const owner = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'original-root' }),
    });
    const input = { principal: { userId: 'operator' }, locator: { worktreeId: 'original-root', path } };
    const source = await owner.describeMedia(input);
    assert.equal(source.mime, mime);
    assert.equal(source.revision, digest(bytes));
    assert.deepEqual(source.locator, input.locator);
    assert.deepEqual(source.media, { kind: 'image', width: 8, height: 12 });
    const opened = await owner.openMedia({ ...input, expectedRevision: source.revision });
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.deepEqual(await readFile(join(root, path)), bytes);
    await assert.rejects(owner.describeMedia({ ...input, principal: { userId: 'other' } }), /access_denied/);
    await writeFile(join(root, path), await image(format, 2));
    await assert.rejects(owner.openMedia({ ...input, expectedRevision: source.revision }), /revision_changed/);
  });
  test(`${mime}: exact published message reopens original bytes and revocation still defeats retained content`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-image-publication-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const uploads = join(root, 'uploads');
    await mkdir(uploads);
    const name = `original.${extension}`,
      bytes = await image(format, 7);
    await writeFile(join(uploads, name), bytes);
    const f = createReviewFixture(root, uploads);
    f.task.current = null;
    const publication = f.publish(`/uploads/${name}`);
    const source = {
      kind: 'message' as const,
      threadId: publication.threadId,
      messageId: publication.id,
      messageRevision: String(publication.timestamp),
      expectedUrl: `/uploads/${name}`,
      item: { kind: 'media-gallery' as const, blockId: 'image', itemIndex: 0 },
    };
    const input = { source, operationId: 'open-original-format', principal: reviewHuman };
    const asset = await f.media.prepare(input);
    assert.equal(asset.mediaType, mime);
    assert.equal(asset.blobDigest, digest(bytes));
    assert.deepEqual(asset.media, { kind: 'image', width: 8, height: 12 });
    assert.deepEqual(await f.media.bytes(asset.contentRef, asset.ownerRevision, reviewHuman), bytes);
    assert.deepEqual(await f.media.prepare({ ...input, operationId: 'reopen' }), asset);
    // The display projection is disposable; the original authorized media read is byte exact.
    const app = Fastify();
    t.after(() => app.close());
    registerPublishedContentRoutes(app, { media: f.media });
    const headers = { 'x-cat-cafe-user': 'operator' };
    const url = `/api/content-publications/${encodeURIComponent(asset.contentRef)}/media/${asset.ownerRevision}`;
    assert.deepEqual((await app.inject({ url, headers })).rawPayload, bytes);
    if (mime === 'image/webp') {
      const display = await app.inject({ url: `${url}?display=oriented`, headers });
      assert.equal(display.statusCode, 200, display.body);
      assert.equal(display.headers['content-type'], 'image/png');
      assert.equal(display.headers['cache-control'], 'private, no-store');
      const actual = await sharp(display.rawPayload).raw().toBuffer({ resolveWithObject: true });
      const expected = await sharp(bytes).autoOrient().raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual(actual, expected);
      assert.equal(
        (await app.inject({ url: `${url}?display=oriented`, headers: { 'x-cat-cafe-user': 'other' } })).statusCode,
        403,
      );
    }
    publication.recall = { recalledAt: 2000, recalledBy: 'operator' };
    assert.equal((await app.inject({ url: `${url}?display=oriented`, headers })).statusCode, 403);
    await assert.rejects(f.media.bytes(asset.contentRef, asset.ownerRevision, reviewHuman), /access_denied/);
    assert.deepEqual(await readFile(join(uploads, name)), bytes);
  });
}
