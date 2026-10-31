import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublishedMediaAccess } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.js';
import { resolveWorkspaceSnapshot } from '../src/domains/video-studio/content-owner/published-workspace-media.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('legacy publication reads and open reject the separate project media scope before source/task consumers', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const saved = await fixture.make().register(fixture.request);
  const unavailable = async () => {
    throw new Error('Legacy authority must not consume a project scope');
  };
  const access = new PublishedMediaAccess({
    tasks: { get: unavailable },
    threads: { get: unavailable, list: unavailable },
  });
  const sources = new PublishedMediaSource({
    access,
    uploadDir: fixture.root,
    artifacts: { readPreparedArtifact: unavailable },
    messages: { getById: unavailable },
  });
  const publications = new PublishedMediaService({ owner: fixture.owner, access, sources });
  const { contentRef, ownerRevision } = saved.screening.media;
  for (const read of [
    () => publications.read(contentRef, ownerRevision, fixture.principal),
    () => publications.bytes(contentRef, ownerRevision, fixture.principal),
    () => publications.origin(contentRef, fixture.principal),
    () => publications.currentRevision(contentRef, fixture.principal),
    () =>
      publications.openAsset(
        {
          ...saved.screening.media,
          mediaType: 'video/mp4',
          ownerReceiptRef: 'forged',
          sourcePublication: { sourceRef: 'message:forged', artifactRef: 'forged', revision: 'forged' },
        },
        fixture.principal,
      ),
  ])
    await assert.rejects(read(), /access_denied/);
});

test('project command support leaves workspace-snapshot Human-only admission unchanged', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  await assert.rejects(
    resolveWorkspaceSnapshot(
      fixture.workspace,
      {
        kind: 'workspace-snapshot',
        threadId: 'thread',
        locator: fixture.request.source.locator,
        expectedSourceRevision: fixture.request.source.expectedSourceRevision,
      },
      'ordinary-snapshot',
      { userId: fixture.principal.userId, actor: { kind: 'cat', actorId: 'sol' }, threadId: 'thread' },
    ),
    /access_denied/,
  );
});
