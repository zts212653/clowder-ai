import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvolutionMediaLocator } from '@cat-cafe/shared';
import sharp from 'sharp';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';
import { fileActionHarness, reviewFileActionHarness } from './helpers/published-media-file-actions.js';

const image = () =>
  sharp({ create: { width: 96, height: 64, channels: 3, background: '#cadbde' } })
    .png()
    .toBuffer();
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test(
  'task review round native actions use an independent PNG and preserve source revocation',
  { skip: process.platform === 'win32' ? 'Requires POSIX private native export files' : false },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'review-native-file-'));
    const original = await image();
    await writeFile(join(root, 'review-input.png'), original);
    const f = await createLiveReviewFixture(root);
    t.after(async () => {
      await f.dispatch.close();
      f.store.close();
      await rm(root, { recursive: true, force: true });
    });
    const review = await f.reviews.prepare(f.prepare, f.human);
    const asset = review.review.rounds[0]?.asset;
    assert.ok(asset);
    await writeFile(join(root, 'review-input.png'), 'changed source');
    const h = await reviewFileActionHarness(t, f, review.review.reviewId, 1);
    const file = await h.target();
    assert.match(file.filename, /\.png$/);
    assert.equal(digest(await readFile(file.path)), asset.blobDigest);
    assert.ok(!file.path.includes('/blobs/'));
    assert.equal((await lstat(file.path)).mode & 0o222, 0);
    await chmod(file.path, 0o644);
    await appendFile(file.path, 'external edit');
    assert.deepEqual(await f.media.bytes(asset.contentRef, asset.ownerRevision, f.human), original);
    f.messages.softDelete(f.publication.id, 'operator');
    for (const action of ['open', 'reveal'] as const) assert.equal((await h.action(action)).statusCode, 403);
  },
);

test(
  'evolution snapshot native actions export the exact retained image and recheck source access',
  { skip: process.platform === 'win32' ? 'Requires POSIX private native export files' : false },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-native-file-'));
    const bytes = await image();
    const ref = (name: string, version = 'v1') => ({
      ownerFeatureId: 'native-file-test',
      ownerStateRef: `evidence:${name}`,
      version,
    });
    const locator: EvolutionMediaLocator = {
      programId: `evolution-program:${'a'.repeat(32)}`,
      experimentRef: ref('experiment'),
      recordRef: ref('record'),
      mediaRef: ref('image', digest(bytes).slice(7)),
    };
    let allowed = true;
    const f = await createLiveReviewFixture(root, 'image/png', undefined, undefined, {
      read: async (target, principal) => {
        assert.deepEqual(target, locator);
        assert.equal(principal.userId, 'operator');
        if (!allowed) throw new WorkspaceContentReviewError('access_denied');
        return { bytes, mime: 'image/png', media: { kind: 'image', width: 96, height: 64 }, label: '实验封面' };
      },
    });
    t.after(async () => {
      await f.dispatch.close();
      f.store.close();
      await rm(root, { recursive: true, force: true });
    });
    const asset = await f.media.prepare({
      source: { kind: 'evolution-snapshot', threadId: f.thread.id, locator },
      operationId: 'native-evolution',
      principal: f.human,
    });
    const h = await fileActionHarness(t, f.media, asset);
    const file = await h.target();
    assert.equal(file.filename, '实验封面.png');
    assert.ok(!file.path.includes('/blobs/'));
    assert.equal(digest(await readFile(file.path)), asset.blobDigest);
    allowed = false;
    for (const action of ['open', 'reveal'] as const) assert.equal((await h.action(action)).statusCode, 403);
  },
);

test(
  'private message images with no local original get a safe PNG, then revoke with the message',
  { skip: process.platform === 'win32' ? 'Requires POSIX private native export files' : false },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'private-native-file-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = await image();
    const f = createReviewFixture(root, root);
    const imageId = `dot_img_${'a'.repeat(64)}`,
      url = `/api/plugins/chatgpt-dot/images/${imageId}.png`;
    f.publication.extra = undefined;
    f.publication.contentBlocks = [{ type: 'image', url }];
    const sources = new PublishedMediaSource({
      access: f.access,
      artifacts: f.artifacts,
      messages: f.messageStore,
      uploadDir: root,
      readPrivateMessageImage: async (id, principal) => {
        assert.equal(id, imageId);
        assert.equal(principal.userId, 'operator');
        return bytes;
      },
    });
    const media = new PublishedMediaService({ access: f.access, owner: f.owner, sources });
    const asset = await media.prepare({
      source: {
        kind: 'message',
        threadId: f.publication.threadId,
        messageId: f.publication.id,
        messageRevision: String(f.publication.timestamp),
        expectedUrl: url,
        item: { kind: 'content-block', index: 0 },
      },
      operationId: 'private-native-file',
      principal: reviewHuman,
    });
    const h = await fileActionHarness(t, media, asset);
    const file = await h.target();
    assert.match(file.filename, /\.png$/);
    assert.ok(!file.path.includes('/blobs/'));
    assert.equal(digest(await readFile(file.path)), asset.blobDigest);
    f.publication.recall = { recalledAt: 2000, recalledBy: 'operator' };
    for (const action of ['open', 'reveal'] as const) assert.equal((await h.action(action)).statusCode, 403);
  },
);
