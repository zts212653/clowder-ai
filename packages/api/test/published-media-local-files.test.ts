import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { workPublicationContentRef } from '../src/domains/video-studio/content-owner/publication.js';
import { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.js';
import type { WorkPublicationScopeV1 } from '../src/domains/video-studio/content-owner/types.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';
import { fileActionHarness } from './helpers/published-media-file-actions.js';
import { screeningFixture } from './helpers/video-project-screening.js';

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const png = () =>
  sharp({ create: { width: 96, height: 64, channels: 3, background: '#aabbcc' } })
    .png()
    .toBuffer();

test('workspace movie uses its registered exact-byte original for all native actions', async (t) => {
  const video = await screeningFixture();
  t.after(video.cleanup);
  const f = createReviewFixture(video.dataDir, video.root);
  const sources = new PublishedMediaSource({
    access: f.access,
    artifacts: f.artifacts,
    messages: f.messageStore,
    uploadDir: video.root,
    workspace: video.workspace,
  });
  const media = new PublishedMediaService({ access: f.access, owner: f.owner, sources });
  const asset = await media.prepare({
    source: { kind: 'workspace-snapshot', threadId: 'thread-cover', ...video.request.source },
    operationId: 'movie-file-actions',
    principal: reviewHuman,
  });
  const h = await fileActionHarness(t, media, asset);
  const metadata = await h.target();
  assert.equal(metadata.path, await realpath(video.path));
  assert.equal(extname(metadata.path), '.mp4');
  assert.equal(digest(await readFile(metadata.path)), asset.blobDigest);
  assert.ok(!metadata.path.includes('/blobs/'));
});

test(
  'Living Work keeps version bytes safe when the source drifts or an external copy is edited',
  { skip: process.platform === 'win32' ? 'Requires POSIX private native export files' : false },
  async (t) => {
    const video = await screeningFixture();
    t.after(video.cleanup);
    const f = createReviewFixture(video.dataDir, video.root);
    const scope: WorkPublicationScopeV1 = {
      kind: 'work',
      ownerUserId: 'operator',
      threadId: 'thread-cover',
      createdBy: { kind: 'cat', actorId: 'codex-astra' },
      creationOperationId: 'work-video-v1',
    };
    const contentRef = workPublicationContentRef(scope);
    const description = await video.workspace.describe({
      principal: { userId: 'operator' },
      locator: { worktreeId: 'root', path: 'movie.mp4' },
    });
    await f.owner.importContent({
      contentRef,
      operationId: 'work-video-v1',
      mediaType: 'video/mp4',
      bytes: video.bytes,
      actor: scope.createdBy,
      publicationScope: scope,
      sourcePublication: {
        artifactRef: description.contentRef,
        sourceRef: 'workspace:root:movie.mp4',
        revision: description.revision,
        threadId: 'thread-cover',
      },
    });
    const sources = new PublishedMediaSource({
      access: f.access,
      artifacts: f.artifacts,
      messages: f.messageStore,
      uploadDir: video.root,
      workspace: video.workspace,
    });
    const media = new PublishedMediaService({
      access: f.access,
      owner: f.owner,
      sources,
      workTitle: () => '守望猫讲解片 v1',
    });
    const asset = await media.read(contentRef, 1, reviewHuman);
    const h = await fileActionHarness(t, media, asset);
    const original = await h.target();
    assert.equal(original.path, await realpath(video.path));
    await appendFile(original.path, Buffer.from([0]));
    assert.deepEqual(
      await media.bytes(contentRef, 1, reviewHuman),
      video.bytes,
      'external source edits cannot rewrite publication bytes',
    );
    const exported = await h.target();
    assert.notEqual(exported.path, original.path);
    assert.equal(exported.filename, '守望猫讲解片 v1.mp4');
    assert.ok(!exported.path.includes('content-owner-v1'));
    assert.equal((await lstat(exported.path)).mode & 0o222, 0);
    await chmod(exported.path, 0o644);
    await appendFile(exported.path, Buffer.from([1]));
    assert.deepEqual(
      await media.bytes(contentRef, 1, reviewHuman),
      video.bytes,
      'even deliberately changing the copy cannot damage the canonical version',
    );
    const repaired = await h.target();
    assert.equal(repaired.path, exported.path);
    assert.equal(digest(await readFile(repaired.path)), asset.blobDigest);
  },
);

for (const changed of [false, true]) {
  test(
    `upload publication ${changed ? 'with changed source exports a read-only PNG' : 'keeps the matching PNG original'}`,
    { skip: changed && process.platform === 'win32' },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'published-local-png-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const uploads = join(root, 'uploads');
      await mkdir(uploads);
      const bytes = await png();
      await writeFile(join(uploads, 'cover.png'), bytes);
      const f = createReviewFixture(root, uploads);
      const asset = await f.media.prepare(f.prepare);
      if (changed) await writeFile(join(uploads, 'cover.png'), Buffer.concat([bytes, Buffer.from([0])]));
      const h = await fileActionHarness(t, f.media, asset);
      const result = await h.target();
      assert.equal(extname(result.path), '.png');
      assert.equal(digest(await readFile(result.path)), asset.blobDigest);
      assert.ok(!result.path.includes('/blobs/'));
      if (changed) {
        assert.equal((await lstat(result.path)).mode & 0o222, 0);
        assert.notEqual(result.path, await realpath(join(uploads, 'cover.png')));
      } else assert.equal(result.path, await realpath(join(uploads, 'cover.png')));
      f.task.current = null;
      for (const action of ['open', 'reveal'] as const) assert.equal((await h.action(action)).statusCode, 403);
    },
  );
}

test(
  'missing safe export directory gives disabled actions and no internal path',
  { skip: process.platform === 'win32' ? 'Requires POSIX private native export files' : false },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'published-local-refuse-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const uploads = join(root, 'uploads');
    await mkdir(uploads);
    const bytes = await png();
    await writeFile(join(uploads, 'cover.png'), bytes);
    const f = createReviewFixture(root, uploads);
    const asset = await f.media.prepare(f.prepare);
    await writeFile(join(uploads, 'cover.png'), 'source changed');
    await symlink(uploads, f.owner.localExportDirectory);
    const h = await fileActionHarness(t, f.media, asset);
    const info = await h.info();
    assert.equal(info.statusCode, 200);
    assert.deepEqual(info.json(), {
      local: false,
      canOpen: false,
      canReveal: false,
      reason: '无法准备可安全交给本机应用的作品副本。',
    });
    for (const action of ['open', 'reveal'] as const) assert.equal((await h.action(action)).statusCode, 403);
    assert.ok(!info.body.includes('/blobs/'));
  },
);

test('workspace original lookup requires a registered owner source, not equal bytes by filename', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'published-local-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await png();
  await writeFile(join(root, 'cover.png'), bytes);
  let allowed = true;
  const workspace = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async (id) => {
      if (!allowed || id !== 'registered') throw new Error('unregistered root');
      return { root, canonicalWorktreeId: 'registered' };
    },
  });
  const f = createReviewFixture(root, root);
  const sources = new PublishedMediaSource({
    access: f.access,
    artifacts: f.artifacts,
    messages: f.messageStore,
    uploadDir: root,
    workspace,
  });
  const description = await workspace.describe({
    principal: { userId: 'operator' },
    locator: { worktreeId: 'registered', path: 'cover.png' },
  });
  const publication = {
    artifactRef: description.contentRef,
    sourceRef: 'workspace:registered:cover.png',
    revision: description.revision,
  };
  assert.equal(
    await sources.localOriginalFile(publication, description.revision, reviewHuman, 'image/png'),
    await realpath(join(root, 'cover.png')),
  );
  assert.equal(
    await sources.localOriginalFile(
      { ...publication, artifactRef: 'workspace-content:wrong-owner' },
      description.revision,
      reviewHuman,
      'image/png',
    ),
    null,
  );
  assert.equal(
    await sources.localOriginalFile(
      { ...publication, sourceRef: 'workspace:unregistered:cover.png' },
      description.revision,
      reviewHuman,
      'image/png',
    ),
    null,
  );
  allowed = false;
  assert.equal(await sources.localOriginalFile(publication, description.revision, reviewHuman, 'image/png'), null);
});
