import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { WorkspaceHtmlPreviews } from '../src/domains/workspace/workspace-html-preview.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { registerWorkspaceHtmlPreviewRoutes } from '../src/routes/workspace-html-preview.js';
import { resolveDirectLocalAuthorizationUserId } from '../src/utils/request-identity.js';

test('an authenticated HTML opening grants only its registered directory assets and revokes on close', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'html-preview-')));
  const previousRoots = process.env.WORKSPACE_LINKED_ROOTS;
  const previousData = process.env.CAT_CAFE_DATA_DIR;
  process.env.WORKSPACE_LINKED_ROOTS = `html_page:${root}`;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
  const app = Fastify();
  const headers = { 'x-cat-cafe-user': 'operator' };
  try {
    await mkdir(join(root, 'report/shots'), { recursive: true });
    await writeFile(join(root, 'report/index.html'), '<h1>Evidence</h1>');
    await writeFile(join(root, 'report/style.css'), 'h1 { color: green }');
    await writeFile(join(root, 'report/app.js'), 'document.body.dataset.loaded = "yes"');
    await writeFile(join(root, 'report/empty.js'), '');
    const oversized = await open(join(root, 'report/oversized.png'), 'w');
    await oversized.truncate(11 * 1024 * 1024);
    await oversized.close();
    await writeFile(join(root, 'report/shots/图 %.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, 'report/.env'), 'private-fixture');
    await writeFile(join(root, 'outside.js'), 'outside-fixture');
    await symlink(join(root, 'outside.js'), join(root, 'report/escape.js'));
    await app.register(workspaceRoutes);
    const payload = { worktreeId: 'linked_html_page', path: 'report/index.html' };
    const prepare = '/api/workspace/html-preview';
    const opened = await app.inject({ method: 'POST', url: prepare, headers, payload });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal((await app.inject({ method: 'POST', url: prepare, payload })).statusCode, 401);
    for (const request of [
      { remoteAddress: '203.0.113.10', headers },
      { headers: { ...headers, origin: 'null' } },
      { headers: { ...headers, 'x-invocation-id': 'callback-fixture' } },
    ])
      assert.equal((await app.inject({ method: 'POST', url: prepare, payload, ...request })).statusCode, 401);
    const { id, assetPath } = opened.json();
    assert.equal(assetPath, `/api/workspace/html-preview/${id}/`);
    for (const [path, mime] of [
      ['style.css', 'text/css'],
      ['app.js', 'javascript'],
      ['shots/图 %.png', 'image/png'],
    ]) {
      const resource = await app.inject(`${assetPath}${path.split('/').map(encodeURIComponent).join('/')}`);
      assert.equal(resource.statusCode, 200, path);
      assert.ok(resource.headers['content-type']?.includes(mime), path);
      assert.equal(resource.headers['access-control-allow-origin'], 'null');
      assert.equal(resource.headers['cache-control'], 'private, no-store');
    }
    for (const path of ['.env', 'escape.js', '%2e%2e/outside.js', '%2fetc/passwd', 'index.html']) {
      const denied = await app.inject(`${assetPath}${path}`);
      assert.ok([400, 403, 404, 415].includes(denied.statusCode), `${path}: ${denied.statusCode}`);
    }
    const empty = await app.inject(`${assetPath}empty.js`);
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.rawPayload.length, 0);
    assert.equal((await app.inject(`${assetPath}oversized.png`)).statusCode, 403);
    assert.equal((await app.inject('/api/workspace/html-preview/not-a-grant/style.css')).statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'DELETE', url: assetPath.slice(0, -1), headers: { 'x-cat-cafe-user': 'other' } }))
        .statusCode,
      404,
    );
    assert.equal((await app.inject({ method: 'DELETE', url: assetPath.slice(0, -1), headers })).statusCode, 204);
    assert.equal((await app.inject(`${assetPath}style.css`)).statusCode, 404);
  } finally {
    await app.close();
    if (previousRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = previousRoots;
    if (previousData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousData;
    await rm(root, { recursive: true, force: true });
  }
});

test('an asset growing after authorization cannot enlarge the bounded response', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'html-preview-growth-')));
  const oldRoots = process.env.WORKSPACE_LINKED_ROOTS;
  const oldData = process.env.CAT_CAFE_DATA_DIR;
  process.env.WORKSPACE_LINKED_ROOTS = `html_growth:${root}`;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
  class GrowingAssets extends WorkspaceHtmlPreviews {
    override async openAsset(id: string, path: string) {
      const asset = await super.openAsset(id, path);
      await appendFile(join(root, 'bounded.js'), 'after-authorized-size');
      return asset;
    }
  }
  const app = Fastify();
  registerWorkspaceHtmlPreviewRoutes(app, resolveDirectLocalAuthorizationUserId, new GrowingAssets());
  try {
    await writeFile(join(root, 'index.html'), '<h1>Bounded</h1>');
    await writeFile(join(root, 'bounded.js'), 'safe');
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/workspace/html-preview',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { worktreeId: 'linked_html_growth', path: 'index.html' },
    });
    assert.equal(prepared.statusCode, 200);
    const response = await app.inject(`${prepared.json().assetPath}bounded.js`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'safe');
  } finally {
    await app.close();
    if (oldRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = oldRoots;
    if (oldData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = oldData;
    await rm(root, { recursive: true, force: true });
  }
});

test('page assets fail closed after session loss, directory removal or idle expiry', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'html-preview-lifecycle-')));
  const previousRoots = process.env.WORKSPACE_LINKED_ROOTS;
  const previousData = process.env.CAT_CAFE_DATA_DIR;
  process.env.WORKSPACE_LINKED_ROOTS = `html_lifecycle:${root}`;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
  let now = 1000;
  let sessionCurrent = true;
  const app = Fastify();
  const previews = new WorkspaceHtmlPreviews(() => now);
  app.addHook('onRequest', async (request) => {
    request.assertSessionCurrent = () => {
      if (!sessionCurrent) throw new Error('session removed');
    };
  });
  registerWorkspaceHtmlPreviewRoutes(app, resolveDirectLocalAuthorizationUserId, previews);
  const prepare = () =>
    app.inject({
      method: 'POST',
      url: '/api/workspace/html-preview',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { worktreeId: 'linked_html_lifecycle', path: 'index.htm' },
    });
  try {
    await writeFile(join(root, 'index.htm'), '<h1>Read only</h1>');
    await writeFile(join(root, 'style.css'), 'body { color: green }');
    const first = await prepare();
    assert.equal(first.statusCode, 200, first.body);
    sessionCurrent = false;
    assert.equal((await app.inject(`${first.json().assetPath}style.css`)).statusCode, 404);
    sessionCurrent = true;
    const second = await prepare();
    now += 31 * 60 * 1000;
    assert.equal((await app.inject(`${second.json().assetPath}style.css`)).statusCode, 404);
    const third = await prepare();
    process.env.WORKSPACE_LINKED_ROOTS = '';
    assert.equal((await app.inject(`${third.json().assetPath}style.css`)).statusCode, 404);
  } finally {
    await app.close();
    if (previousRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = previousRoots;
    if (previousData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousData;
    await rm(root, { recursive: true, force: true });
  }
});
