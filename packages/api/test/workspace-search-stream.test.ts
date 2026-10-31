import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { searchWorkspace } from '../src/domains/workspace/workspace-search.js';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

const headers = { host: 'localhost', 'x-cat-cafe-user': 'operator' };

test('filename and content search work when real find output exceeds its former 10 MiB buffer', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-large-search-'));
  const root = join(temp, ...Array.from({ length: 4 }, (_, i) => `${i}-${'p'.repeat(125)}`));
  await mkdir(root, { recursive: true });
  const names = Array.from({ length: 16000 }, (_, i) => `other-${String(i).padStart(5, '0')}-${'f'.repeat(180)}.bin`);
  const enumeratedBytes = names.reduce((sum, name) => sum + Buffer.byteLength(join(root, name)) + 1, 0);
  assert.ok(enumeratedBytes > 10 * 1024 * 1024);
  for (let start = 0; start < names.length; start += 64) {
    await Promise.all(names.slice(start, start + 64).map((name) => writeFile(join(root, name), '')));
  }
  const target = 'doc-0a6831f6718f-Clowder_AI_后续建设与分工讨论稿-v0_2.md';
  await writeFile(join(root, target), '# 原对象\n\nneedle 中文讨论稿\n');
  const worktreeId = `large-search-${Date.now()}`;
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const app = Fastify();
  await app.register(workspaceRoutes);
  t.after(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });
  for (const type of ['filename', 'content'] as const) {
    await t.test(type, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspace/search',
        headers,
        payload: { worktreeId, query: type === 'filename' ? '后续建设' : 'needle 中文讨论稿', type },
      });
      assert.equal(response.statusCode, 200, `${type} search must not buffer the full enumeration: ${response.body}`);
      assert.deepEqual(
        response.json().results.map((item: { path: string }) => item.path),
        [target],
      );
      assert.equal(response.json().results[0].line, type === 'filename' ? 0 : 3);
    });
  }
});

test('search preserves excluded directories, secrets, symlinks, relative queries and bounded sorted results', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-search-query-in-root-'));
  const root = join(temp, 'root-query-only');
  const outside = join(temp, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'relative.txt'), 'nested-query');
  await writeFile(join(outside, 'needle-secret.md'), 'needle');
  for (const directory of ['.hidden', 'node_modules', 'dist', 'secrets']) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'needle.md'), 'needle');
  }
  for (const name of ['.env', 'cert.pem', 'private.key', 'id_rsa_fixture']) await writeFile(join(root, name), 'needle');
  for (const name of ['z-needle.md', 'a-needle.md', '中\nneedle.md'])
    await writeFile(join(root, name), 'before\nneedle\nafter');
  await symlink(outside, join(root, 'external-directory'));
  await symlink(join(outside, 'needle-secret.md'), join(root, 'needle-symlink.md'));
  const worktreeId = `bounded-search-${Date.now()}`;
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const app = Fastify();
  await app.register(workspaceRoutes);
  t.after(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });
  for (const type of ['filename', 'content'] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/search',
      headers,
      payload: { worktreeId, query: 'needle', type, limit: 2 },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(
      body.results.map((item: { path: string }) => item.path),
      ['a-needle.md', 'z-needle.md'],
    );
    assert.equal(body.truncated, true, 'a bounded result must disclose additional matches');
    assert.equal(body.results.length, 2);
  }
  const rootOnly = await app.inject({
    method: 'POST',
    url: '/api/workspace/search',
    headers,
    payload: { worktreeId, query: 'root-query-only', type: 'filename' },
  });
  assert.deepEqual(rootOnly.json().results, []);
  const nested = await app.inject({
    method: 'POST',
    url: '/api/workspace/search',
    headers,
    payload: { worktreeId, query: 'nested-query', type: 'content' },
  });
  assert.deepEqual(
    nested.json().results.map((item: { path: string }) => item.path),
    ['docs/relative.txt'],
  );
});

test('an enumeration error after a matching file is not returned as a successful partial search', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-search-stream-error-'));
  const file = join(root, 'needle.md');
  await writeFile(file, 'needle');
  t.after(() => rm(root, { recursive: true, force: true }));
  async function* brokenEnumeration() {
    yield file;
    throw new Error('directory stream failed');
  }
  for (const type of ['filename', 'content'] as const) {
    await assert.rejects(searchWorkspace(root, 'needle', type, 10, brokenEnumeration()), /directory stream failed/);
  }
});

test('search requires a positive integer result limit and caps valid requests at 100', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-search-limits-'));
  await Promise.all(Array.from({ length: 105 }, (_, i) => writeFile(join(root, `needle-${i}.md`), 'needle')));
  const worktreeId = `search-limits-${Date.now()}`;
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const app = Fastify();
  await app.register(workspaceRoutes);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const limit of [-1, 0, 1.5, 'wrong']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/search',
      headers,
      payload: { worktreeId, query: 'needle', type: 'filename', limit },
    });
    assert.equal(response.statusCode, 400, `invalid limit ${limit}`);
  }
  const capped = await app.inject({
    method: 'POST',
    url: '/api/workspace/search',
    headers,
    payload: { worktreeId, query: 'needle', type: 'filename', limit: 10000 },
  });
  assert.equal(capped.statusCode, 200);
  assert.equal(capped.json().results.length, 100);
  assert.equal(capped.json().truncated, true);
});

test('an explicitly registered hidden directory remains pruned as the search root', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-hidden-search-root-'));
  const root = join(temp, '.private-root');
  await mkdir(root);
  await writeFile(join(root, 'needle.md'), 'needle');
  const worktreeId = `hidden-search-${Date.now()}`;
  registerWorktrees([{ id: worktreeId, root, head: 'fixture', branch: 'fixture' }]);
  const app = Fastify();
  await app.register(workspaceRoutes);
  t.after(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });
  for (const type of ['filename', 'content'] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/search',
      headers,
      payload: { worktreeId, query: 'needle', type },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().results, []);
  }
});
