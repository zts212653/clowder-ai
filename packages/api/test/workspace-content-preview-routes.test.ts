import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rename, rm, utimes, writeFile } from 'node:fs/promises';
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
    bridgeVersion: '1.0.0' as const,
    fileName: 'source.pdf',
    bytesBase64: Buffer.from('snapshot').toString('base64'),
  };
  let reads = 0;
  let oversizedFixtureId: string | undefined;
  registerWorkspaceContentPreviewRoutes(app, {
    ownerUserId: 'owner',
    workspace: {
      async open(input) {
        if (oversizedFixtureId) {
          await readWorkspacePreviewSnapshot(oversizedFixtureId, 'source.pdf');
        }
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

  const root = await mkdtemp(join(tmpdir(), 'f309-preview-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.pdf');
  oversizedFixtureId = `preview-fixture-${randomUUID()}`;
  registerWorktrees([{ id: oversizedFixtureId, root, head: 'fixture', branch: 'fixture' }]);
  await writeFile(source, '');
  const handle = await open(source, 'r+');
  await handle.truncate(32 * 1024 * 1024 + 1);
  await handle.close();
  const rejected = await app.inject({ ...partial, headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(rejected.statusCode, 413);
  assert.deepEqual(rejected.json(), { error: { code: 'preview_file_too_large' } });
});

test('file snapshot reads a registered source and rejects paths outside that root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-read-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreeId = `preview-fixture-${randomUUID()}`;
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const file = join(root, 'sample.pdf');
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await writeFile(file, bytes);
  assert.equal((await readWorkspaceFilePreview(file)).binary, true);
  assert.equal(await computeWorkspaceFileSha256(file), '');
  assert.deepEqual(await readWorkspacePreviewSnapshot(worktreeId, 'sample.pdf'), bytes);
  await assert.rejects(readWorkspacePreviewSnapshot(worktreeId, '../sample.pdf'), { code: 'TRAVERSAL' });

  const handle = await open(file, 'r+');
  await handle.truncate(32 * 1024 * 1024);
  await handle.close();
  assert.equal((await readWorkspacePreviewSnapshot(worktreeId, 'sample.pdf')).byteLength, 32 * 1024 * 1024);
});

test('snapshot refuses an in-place edit or path replacement during a read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-preview-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktreeId = `preview-fixture-${randomUUID()}`;
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const source = join(root, 'sample.pdf');
  const replacement = join(root, 'replacement.pdf');
  await writeFile(source, 'original');
  await writeFile(replacement, 'modified');
  const probe = await open(source, 'r');
  const prototype = Object.getPrototypeOf(probe) as Pick<typeof probe, 'read'>;
  const read = prototype.read;
  await probe.close();

  async function checkMutation(testContext: typeof t, mutate: () => Promise<void>) {
    await writeFile(source, 'original');
    const stub = testContext.mock.method(prototype, 'read', async function (this: typeof probe, buffer: Buffer) {
      await mutate();
      return Reflect.apply(read, this, [buffer, 0, buffer.length, 0]);
    });
    await assert.rejects(readWorkspacePreviewSnapshot(worktreeId, 'sample.pdf'), {
      code: 'preview_source_changed',
    });
    stub.mock.restore();
  }

  await t.test('same-size edit of the open inode', (subtest) =>
    checkMutation(subtest, async () => {
      await writeFile(source, 'modified');
      const updated = new Date(1_700_000_000_000);
      await utimes(source, updated, updated);
    }),
  );
  // Windows refuses the replacement while the original file is open.
  await t.test('same-size replacement at the original path', { skip: process.platform === 'win32' }, (subtest) =>
    checkMutation(subtest, () => rename(replacement, source)),
  );
});
