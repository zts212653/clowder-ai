import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

test('an explicit workspace snapshot retains bytes in F138, preserves original file and has its own identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-workspace-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#aabbcc' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'cover.png'), original);
  let allowed = true;
  const workspace = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      if (!allowed) throw new Error('registered root removed');
      return { canonicalWorktreeId: 'worktree-original', root };
    },
  });
  const f = createReviewFixture(root, root);
  f.task.current = null;
  f.messages.clear();
  const media = new PublishedMediaService({
    access: f.access,
    owner: f.owner,
    sources: new PublishedMediaSource({
      access: f.access,
      artifacts: f.artifacts,
      messages: f.messageStore,
      uploadDir: root,
      workspace,
    }),
  });
  const locator = { worktreeId: 'worktree-original', path: 'cover.png' };
  const originalDescription = await workspace.describe({ principal: { userId: 'operator' }, locator });
  const source = {
    kind: 'workspace-snapshot' as const,
    threadId: 'thread-cover',
    locator,
    expectedSourceRevision: originalDescription.revision,
  };
  const input = { source, operationId: 'explicit-modification-1', principal: reviewHuman };
  const asset = await media.prepare(input);
  assert.notEqual(asset.contentRef, originalDescription.contentRef);
  assert.equal(asset.sourcePublication.artifactRef, originalDescription.contentRef);
  assert.equal(f.messages.size, 0, 'snapshot admission must not publish a chat message');
  assert.equal(f.task.current, null);
  assert.deepEqual(await media.prepare(input), asset);
  const independent = await media.prepare({ ...input, operationId: 'explicit-modification-2' });
  assert.notEqual(independent.contentRef, asset.contentRef, 'separate explicit snapshots are not merged by bytes');
  assert.equal(
    (await workspace.describe({ principal: { userId: 'operator' }, locator })).revision,
    originalDescription.revision,
  );
  await writeFile(
    join(root, 'cover.png'),
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ccbbbb' } })
      .png()
      .toBuffer(),
  );
  assert.deepEqual(
    await media.bytes(asset.contentRef, 1, reviewCat),
    original,
    'source drift does not rewrite the immutable snapshot',
  );
  assert.deepEqual(
    await media.prepare(input),
    asset,
    'unknown import recovery uses the same snapshot after later file drift',
  );
  await assert.rejects(media.prepare({ ...input, operationId: 'stale-base' }), /revision_changed|publication_changed/);
  allowed = false;
  await assert.rejects(media.bytes(asset.contentRef, 1, reviewHuman), /access_denied|registered root removed/);
});
