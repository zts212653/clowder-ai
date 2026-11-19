import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { computeWorkspaceFileSha256, readWorkspaceFilePreview } from '../src/domains/workspace/workspace-file-read.js';
import { readWorkspacePreviewSnapshot } from '../src/domains/workspace/workspace-preview-snapshot.js';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { registerWorkspaceContentPreviewRoutes } from '../src/routes/workspace-content-preview-routes.js';

test('preview route requires the direct local owner before opening a workspace source', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const file = {
    rendererOrigin: 'http://editor-00000000000000000000000000000000.localhost:56123',
    entrypointPath: '/packages/seed/assets/preview/index.html',
    mediaType: 'application/pdf',
    fileName: 'source.pdf',
    bytesBase64: Buffer.from('snapshot').toString('base64'),
  };
  let reads = 0;
  registerWorkspaceContentPreviewRoutes(app, {
    ownerUserId: 'owner',
    workspace: {
      async open(input) {
        reads += 1;
        assert.deepEqual(input, { worktreeId: 'test', path: 'source.pdf' });
        return file;
      },
    },
  });
  const partial = {
    method: 'POST',
    url: '/api/workspace/content-preview',
    remoteAddress: '127.0.0.1',
    payload: { worktreeId: 'test', path: 'source.pdf' },
  } as const;

  assert.equal((await app.inject(partial)).statusCode, 401);
  assert.equal((await app.inject({ ...partial, headers: { 'x-cat-cafe-user': 'other' } })).statusCode, 403);
  assert.equal(
    (await app.inject({ ...partial, remoteAddress: '192.0.2.20', headers: { 'x-cat-cafe-user': 'owner' } })).statusCode,
    401,
  );
  assert.equal(reads, 0);
  const opened = await app.inject({ ...partial, headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.headers['cache-control'], 'no-store');
  assert.deepEqual(opened.json(), file);
  assert.equal(reads, 1);
});

test('file snapshot reads a registered source and rejects paths outside that root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-read-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreeId = 'preview-fixture-' + randomUUID();
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const file = join(root, 'sample.pdf');
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await writeFile(file, bytes);
  assert.equal((await readWorkspaceFilePreview(file)).binary, true);
  assert.equal(await computeWorkspaceFileSha256(file), '');
  assert.deepEqual(await readWorkspacePreviewSnapshot(worktreeId, 'sample.pdf'), bytes);
  await assert.rejects(readWorkspacePreviewSnapshot(worktreeId, '../sample.pdf'), { code: 'TRAVERSAL' });

  const handle = await open(file, 'r+');
  await handle.truncate(50 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(readWorkspacePreviewSnapshot(worktreeId, 'sample.pdf'), { code: 'DENIED' });
});
