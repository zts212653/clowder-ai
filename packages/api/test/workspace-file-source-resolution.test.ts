import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

test('file source resolution uses the exact registered absolute path for code and Office without content mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-file-source-'));
  const other = await mkdtemp(join(tmpdir(), 'f309-other-source-'));
  const app = Fastify();
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  const priorData = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
  process.env.WORKSPACE_LINKED_ROOTS = `f309_original:${root}`;
  try {
    await Promise.all([
      writeFile(join(root, 'code.ts'), 'export const original = true;'),
      writeFile(join(root, 'proposal.docx'), Buffer.from('office-provider-input')),
      writeFile(join(root, '.env'), 'PRIVATE'),
      writeFile(join(other, 'code.ts'), 'other file'),
    ]);
    await symlink(join(other, 'code.ts'), join(root, 'escape.ts'));
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const resolve = (path: string, headers: Record<string, string> = { 'x-cat-cafe-user': 'operator' }) =>
      app.inject({ method: 'POST', url: '/api/workspace/resolve-file-source', headers, payload: { path } });
    for (const path of ['code.ts', 'proposal.docx']) {
      const response = await resolve(join(root, path));
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.json().worktreeId, /^f063_root_v1_[a-f0-9]{64}$/);
      assert.equal(response.json().path, path);
      assert.equal(response.json().kind, 'file');
      assert.match(response.headers['cache-control'] ?? '', /no-store/);
    }
    assert.equal((await resolve(join(root, 'code.ts'), {})).statusCode, 401);
    assert.equal(
      (await resolve(join(root, 'code.ts'), { 'x-cat-cafe-user': 'operator', 'x-invocation-id': 'cat' })).statusCode,
      401,
    );
    assert.equal((await resolve('code.ts')).statusCode, 400, 'relative refs must never borrow the current root');
    assert.equal((await resolve(join(root, '.env'))).statusCode, 403);
    assert.equal((await resolve(join(root, 'escape.ts'))).statusCode, 403);
    const unconnected = await resolve(await realpath(join(other, 'code.ts')));
    assert.equal(unconnected.statusCode, 200, unconnected.body);
    assert.equal(unconnected.json().kind, 'connection-required');
    assert.equal(unconnected.json().root, await realpath(other));
    assert.equal((await resolve(join(root, 'missing.ts'))).statusCode, 404);
    assert.equal((await resolve(root)).statusCode, 400);
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    if (priorData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorData;
    await app.close();
    await Promise.all([root, other].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test('legacy locations require an explicit registered root even when only one file remains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-legacy-location-'));
  const app = Fastify();
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  process.env.WORKSPACE_LINKED_ROOTS = `f309_chosen:${root}`;
  const headers = { 'x-cat-cafe-user': 'operator' };
  try {
    await writeFile(join(root, 'notes.txt'), 'B is a current choice, not proof of historical A');
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
    const locations = await app.inject({ method: 'GET', url: '/api/workspace/file-locations', headers });
    assert.equal(locations.statusCode, 200);
    assert.equal(locations.json().ownerUserId, 'operator');
    const canonical = await realpath(root);
    assert.ok(locations.json().locations.some((entry: { root: string }) => entry.root === canonical));
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspace/file-locations' })).statusCode, 401);
    const selected = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { root, path: 'notes.txt' },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(selected.json().absolutePath, await realpath(join(root, 'notes.txt')));
    assert.equal(selected.json().path, 'notes.txt');
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { root, path: '../other/notes.txt' },
    });
    assert.equal(invalid.statusCode, 403);
    const notRegistered = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers,
      payload: { root: '/not/registered', path: 'notes.txt' },
    });
    assert.equal(notRegistered.statusCode, 404);
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an already resolved file never follows a reassigned linked-root alias', async () => {
  const a = await mkdtemp(join(tmpdir(), 'f309-bound-A-'));
  const b = await mkdtemp(join(tmpdir(), 'f309-bound-B-'));
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  const app = Fastify();
  try {
    await Promise.all([writeFile(join(a, 'same.txt'), 'original A'), writeFile(join(b, 'same.txt'), 'unrelated B')]);
    process.env.WORKSPACE_LINKED_ROOTS = `f309_bound:${a}`;
    await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(a, 'audit') }) });
    const resolved = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-file-source',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { path: join(a, 'same.txt') },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    process.env.WORKSPACE_LINKED_ROOTS = `f309_bound:${b}`;
    const file = await app.inject({
      method: 'GET',
      url: `/api/workspace/file?${new URLSearchParams({ worktreeId: resolved.json().worktreeId, path: resolved.json().path })}`,
    });
    assert.ok(
      file.statusCode === 404 || file.statusCode === 403,
      `original A is no longer registered; must not expose B: ${file.body}`,
    );
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    await app.close();
    await Promise.all([a, b].map((path) => rm(path, { recursive: true, force: true })));
  }
});
