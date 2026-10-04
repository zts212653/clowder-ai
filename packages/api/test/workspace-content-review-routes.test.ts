import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import sharp from 'sharp';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('ordinary MP4 review serves revision-bound byte ranges to the authorized owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-workspace-mp4-range-'));
  roots.push(root);
  const path = join(root, 'review-input.mp4');
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=25:d=2',
    '-c:v',
    'libx264',
    '-movflags',
    '+faststart',
    path,
  ]);
  const bytes = await readFile(path);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async (id) => {
      if (id !== 'worktree-a') throw new Error('unknown worktree');
      return { root, canonicalWorktreeId: id };
    },
  });
  const openedStreams: import('node:stream').Readable[] = [];
  const openMedia = source.openMedia.bind(source);
  source.openMedia = async (input) => {
    const media = await openMedia(input);
    openedStreams.push(media.stream);
    return media;
  };
  const store = new WorkspaceContentReviewStore(join(root, 'reviews.sqlite'));
  const app = Fastify();
  registerWorkspaceContentReviewRoutes(app, { reviews: new WorkspaceContentReviewService({ store, source }) });
  try {
    const owner = { 'x-cat-cafe-user': 'operator' };
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/workspace/content-reviews/prepare',
      headers: owner,
      payload: { locator: { worktreeId: 'worktree-a', path: 'review-input.mp4' }, operationId: 'open-mp4' },
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    const { review } = prepared.json();
    const url = `/api/workspace/content-reviews/${review.reviewId}/media?expectedSourceRevision=${review.source.revision}`;
    const requestRange = (range: string, headers = owner) =>
      app.inject({ method: 'GET', url, headers: { ...headers, range } });

    assert.equal((await requestRange('bytes=0-1', {})).statusCode, 401);
    assert.equal((await requestRange('bytes=0-1', { 'x-cat-cafe-user': 'other' })).statusCode, 403);
    assert.equal(openedStreams.length, 0, 'denied requests must not open an owner snapshot');

    for (const [range, start, end] of [
      ['bytes=0-1', 0, 1],
      ['bytes=300-499', 300, 499],
      [`bytes=${bytes.length - 17}-`, bytes.length - 17, bytes.length - 1],
      ['bytes=-13', bytes.length - 13, bytes.length - 1],
    ] as const) {
      const response = await requestRange(range);
      assert.equal(response.statusCode, 206, range);
      assert.equal(response.headers['accept-ranges'], 'bytes');
      assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
      assert.equal(response.headers['content-length'], String(end - start + 1));
      assert.equal(response.headers['content-type'], 'video/mp4');
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.deepEqual(response.rawPayload, bytes.subarray(start, end + 1));
      assert.equal(openedStreams.at(-1)?.destroyed, true, 'a completed partial response closes its source stream');
    }

    for (const range of ['bytes=0-1,3-4', `bytes=${bytes.length}-`, 'bytes=-0']) {
      const response = await requestRange(range);
      assert.equal(response.statusCode, 416, range);
      assert.equal(response.headers['content-range'], `bytes */${bytes.length}`);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(openedStreams.at(-1)?.destroyed, true, 'a rejected range closes its source stream');
    }
    const full = await app.inject({ method: 'GET', url, headers: owner });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.deepEqual(full.rawPayload, bytes);

    const wrongRevision = await app.inject({
      method: 'GET',
      url: url.replace(review.source.revision, `sha256:${'0'.repeat(64)}`),
      headers: { ...owner, range: 'bytes=0-1' },
    });
    assert.equal(wrongRevision.statusCode, 409);
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=25:d=2',
      '-c:v',
      'libx264',
      '-movflags',
      '+faststart',
      path,
    ]);
    assert.equal((await requestRange('bytes=0-1')).statusCode, 409, 'changed owner bytes reject the old revision');
  } finally {
    store.close();
    await app.close();
  }
});

test('ordinary Workspace reviews persist without Task admission and media responses are revision-bound no-store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-workspace-routes-'));
  roots.push(root);
  await writeFile(join(root, 'notes.md'), '# Notes\n\nA unique source quote.\n');
  await writeFile(
    join(root, 'cover.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
      .png()
      .toBuffer(),
  );
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async (id) => {
      if (id !== 'worktree-a') throw new Error('unknown worktree');
      return { root, canonicalWorktreeId: id };
    },
  });
  const store = new WorkspaceContentReviewStore(join(root, 'reviews.sqlite'));
  const app = Fastify();
  app.get('/before-workspace-content-review-routes', async () => ({ before: true }));
  registerWorkspaceContentReviewRoutes(app, { reviews: new WorkspaceContentReviewService({ store, source }) });
  app.get('/after-workspace-content-review-routes', async () => ({ after: true }));
  try {
    const headers = { 'x-cat-cafe-user': 'operator' };
    const opened = await app.inject({
      method: 'POST',
      url: '/api/workspace/content-reviews/prepare',
      headers,
      payload: { locator: { worktreeId: 'worktree-a', path: 'notes.md' }, operationId: 'open-notes' },
    });
    assert.equal(opened.statusCode, 200);
    const view = opened.json();
    assert.equal(view.review.task, undefined);
    assert.equal(view.review.source.kind, 'text');

    const annotated = await app.inject({
      method: 'POST',
      url: `/api/workspace/content-reviews/${view.review.reviewId}/annotations`,
      headers,
      payload: {
        expectedRevision: view.review.revision,
        operationId: 'annotate-notes',
        body: 'Please clarify this sentence.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      },
    });
    assert.equal(annotated.statusCode, 200);
    assert.equal(annotated.json().review.annotations.length, 1);
    const receiptUrl = `/api/workspace/content-reviews/${view.review.reviewId}/operations/annotate-notes`;
    const proof = await app.inject({ method: 'GET', url: receiptUrl, headers });
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.json().receipt.operationId, 'annotate-notes');
    assert.equal(proof.json().receipt.revision, 2);
    const absent = await app.inject({
      method: 'GET',
      url: receiptUrl.replace('annotate-notes', 'never-submitted'),
      headers,
    });
    assert.equal(absent.json().receipt, null);
    const wrongUser = await app.inject({
      method: 'GET',
      url: receiptUrl,
      headers: { 'x-cat-cafe-user': 'other-owner' },
    });
    assert.equal(wrongUser.statusCode, 403);

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/workspace/content-reviews/${view.review.reviewId}`,
      headers: { 'x-cat-cafe-user': 'other-owner' },
    });
    assert.equal(forbidden.statusCode, 403);

    const mediaOpened = await app.inject({
      method: 'POST',
      url: '/api/workspace/content-reviews/prepare',
      headers,
      payload: { locator: { worktreeId: 'worktree-a', path: 'cover.png' }, operationId: 'open-cover' },
    });
    assert.equal(mediaOpened.statusCode, 200);
    const mediaView = mediaOpened.json();
    const mark = await app.inject({
      method: 'POST',
      url: `/api/workspace/content-reviews/${mediaView.review.reviewId}/actions`,
      headers,
      payload: {
        expectedRevision: mediaView.review.revision,
        operationId: 'mark-cover',
        action: {
          kind: 'add_visual_marks',
          marks: [
            {
              id: 'cover-rectangle',
              kind: 'rectangle',
              x: 16,
              y: 24,
              width: 48,
              height: 30,
              color: '#d04a3a',
              strokeWidth: 4,
            },
          ],
        },
      },
    });
    assert.equal(mark.statusCode, 200);
    assert.equal(mark.json().review.visualMarks[0].drawing.id, 'cover-rectangle');
    const taskBoundAction = await app.inject({
      method: 'POST',
      url: `/api/workspace/content-reviews/${mediaView.review.reviewId}/actions`,
      headers,
      payload: {
        expectedRevision: mark.json().review.revision,
        operationId: 'must-not-create-task',
        action: { kind: 'request_image_edit', annotationId: 'not-a-workspace-action' },
      },
    });
    assert.equal(taskBoundAction.statusCode, 400, 'ordinary files must reject Task-bound artifact actions');
    const media = await app.inject({
      method: 'GET',
      url: `/api/workspace/content-reviews/${mediaView.review.reviewId}/media?expectedSourceRevision=${mediaView.review.source.revision}`,
      headers,
    });
    assert.equal(media.statusCode, 200);
    assert.equal(media.headers['cache-control'], 'private, no-store');
    assert.equal(media.headers['content-type'], 'image/png');
    assert.ok(media.rawPayload.length > 0);

    await writeFile(
      join(root, 'cover.png'),
      await sharp({ create: { width: 320, height: 200, channels: 3, background: '#a0563d' } })
        .png()
        .toBuffer(),
    );
    const staleMedia = await app.inject({
      method: 'GET',
      url: `/api/workspace/content-reviews/${mediaView.review.reviewId}/media?expectedSourceRevision=${mediaView.review.source.revision}`,
      headers,
    });
    assert.equal(staleMedia.statusCode, 409, 'a changed source must not serve a mutable path under its old revision');
    assert.equal(staleMedia.headers['cache-control'], 'private, no-store');

    const [before, after] = await Promise.all([
      app.inject({ method: 'GET', url: '/before-workspace-content-review-routes' }),
      app.inject({ method: 'GET', url: '/after-workspace-content-review-routes' }),
    ]);
    assert.equal(before.headers['cache-control'], undefined);
    assert.equal(after.headers['cache-control'], undefined);
  } finally {
    store.close();
    await app.close();
  }
});
