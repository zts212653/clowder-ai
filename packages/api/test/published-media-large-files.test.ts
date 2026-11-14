import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { workPublicationContentRef } from '../src/domains/video-studio/content-owner/publication.js';
import { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.js';
import type { WorkPublicationScopeV1 } from '../src/domains/video-studio/content-owner/types.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';
import { fileActionHarness } from './helpers/published-media-file-actions.js';
import { screeningFixture } from './helpers/video-project-screening.js';

for (const drifted of [false, true]) {
  test(
    `a 257 MiB published movie ${drifted ? 'exports once when its original changes' : 'keeps its matching original'}`,
    { skip: process.platform === 'win32' ? 'Requires POSIX private native export files' : false },
    async (t) => {
      const video = await screeningFixture();
      t.after(video.cleanup);
      const byteLength = 257 * 1024 * 1024;
      // A legal trailing ISO-BMFF free box; sparse padding and stream import keep the test memory bounded.
      const padding = Buffer.alloc(8);
      padding.writeUInt32BE(byteLength - video.bytes.length);
      padding.write('free', 4, 'latin1');
      const file = await open(video.path, 'r+');
      try {
        await file.write(padding, 0, padding.length, video.bytes.length);
        await file.truncate(byteLength);
      } finally {
        await file.close();
      }
      const f = createReviewFixture(video.dataDir, video.root);
      const description = await video.workspace.describe({
        principal: { userId: 'operator' },
        locator: { worktreeId: 'root', path: 'movie.mp4' },
      });
      const scope: WorkPublicationScopeV1 = {
        kind: 'work',
        ownerUserId: 'operator',
        threadId: 'thread-cover',
        createdBy: { kind: 'cat', actorId: 'codex61-sol' },
        creationOperationId: 'large-native-movie',
      };
      const contentRef = workPublicationContentRef(scope);
      await f.owner.importStream({
        contentRef,
        operationId: scope.creationOperationId,
        mediaType: 'video/mp4',
        stream: createReadStream(video.path),
        byteLength,
        blobDigest: description.revision,
        actor: scope.createdBy,
        publicationScope: scope,
        sourcePublication: {
          artifactRef: description.contentRef,
          sourceRef: 'workspace:root:movie.mp4',
          revision: description.revision,
          threadId: 'thread-cover',
        },
        authorizeEffect: async () => {},
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
        workTitle: () => '大视频 v1',
      });
      const asset = await media.read(contentRef, 1, reviewHuman);
      if (drifted) await appendFile(video.path, Buffer.from([0]));
      const h = await fileActionHarness(t, media, asset);
      const target = await h.target(); // Real file-info/Open/Reveal must all resolve this version successfully.
      const original = await realpath(video.path);
      const before = await lstat(target.path, { bigint: true });
      assert.equal(before.size, BigInt(byteLength));
      for (let read = 0; read < 3; read++) {
        const response = await h.info();
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().path, target.path);
      }
      const after = await lstat(target.path, { bigint: true });
      assert.equal(after.ino, before.ino, 'repeated metadata reads must not recopy the movie');
      assert.equal(after.mtimeNs, before.mtimeNs);
      if (drifted) {
        assert.notEqual(target.path, original);
        assert.equal(target.filename, '大视频 v1.mp4');
        assert.equal(after.mode & 0o222n, 0n);
        assert.deepEqual(await readdir(dirname(target.path)), ['大视频 v1.mp4']);
      } else {
        assert.equal(target.path, original);
        await assert.rejects(readdir(f.owner.localExportDirectory), { code: 'ENOENT' });
      }
    },
  );
}
