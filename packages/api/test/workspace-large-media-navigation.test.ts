import assert from 'node:assert/strict';
import { chmod, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createWorkspaceContentReviewComposition } from '../src/domains/collaborative-content/workspace-review/composition.js';
import { MAX_WORKSPACE_COLLABORATION_BYTES } from '../src/domains/workspace/workspace-content-source.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';

test('large media navigation preserves the registered file and range reader without enlarging collaboration snapshots', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f309-large-video-')));
  const previousRoots = process.env.WORKSPACE_LINKED_ROOTS;
  const previousData = process.env.CAT_CAFE_DATA_DIR;
  process.env.WORKSPACE_LINKED_ROOTS = `large_video:${root}`;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
  const app = Fastify();
  const content = createWorkspaceContentReviewComposition({ dataDir: join(root, 'state'), ownerUserId: 'operator' });
  const headers = { 'x-cat-cafe-user': 'operator' };
  const path = 'master.mp4';
  const size = MAX_WORKSPACE_COLLABORATION_BYTES + 123;
  try {
    const handle = await open(join(root, path), 'w');
    await handle.write(Buffer.from('bounded-video-reader'));
    await handle.truncate(size);
    await handle.close();
    await app.register(workspaceRoutes);
    registerWorkspaceContentReviewRoutes(app, { reviews: content.reviews });
    const params = new URLSearchParams({ worktreeId: 'linked_large_video', path });
    const preview = await app.inject({ method: 'GET', url: `/api/workspace/file?${params}`, headers });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().size, size);
    const raw = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?${params}`,
      headers: { ...headers, range: 'bytes=0-6' },
    });
    assert.equal(raw.statusCode, 206);
    assert.equal(raw.headers['content-range'], `bytes 0-6/${size}`);
    assert.equal(raw.rawPayload.toString(), 'bounded');

    for (const selection of [
      { worktreeId: 'linked_large_video', path },
      { root, path },
      { selectedRoot: root, path },
      { path: join(root, path) },
    ]) {
      const resolved = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-file-source',
        headers,
        payload: selection,
      });
      assert.equal(resolved.statusCode, 200, `${JSON.stringify(selection)}: ${resolved.body}`);
      const locator = { worktreeId: resolved.json().worktreeId, path: resolved.json().path };
      assert.match(locator.worktreeId, /^f063_root_v1_[a-f0-9]{64}$/);
      assert.equal(locator.path, path);
      const denied = await app.inject({
        method: 'POST',
        url: '/api/workspace/content-reviews/prepare',
        headers,
        payload: { locator, operationId: 'large-media-prepare' },
      });
      assert.equal(denied.statusCode, 413, denied.body);
      assert.equal(denied.json().error.code, 'too_large');
    }

    await chmod(join(root, path), 0);
    const unreadable = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { worktreeId: 'linked_large_video', path },
    });
    assert.equal(unreadable.statusCode, 403, 'navigation must still verify read access');
  } finally {
    await app.close();
    content.store.close();
    if (previousRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = previousRoots;
    if (previousData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousData;
    await rm(root, { recursive: true, force: true });
  }
});
