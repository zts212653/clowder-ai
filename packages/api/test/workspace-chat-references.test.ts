import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import Fastify from 'fastify';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

const app = Fastify();
let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-references-'));
  await writeFile(join(root, '报告.md'), '# Hello');
  await writeFile(join(root, '.env.local'), 'private');
  await symlink(join(root, '.env.local'), join(root, 'looks-public.md'));
  registerWorktrees([{ id: 'chat-reference-fixture', root, branch: 'test', head: '' }]);
  await app.register(workspaceRoutes, {
    threadStore: {
      get: (id) => (id === 'thread_fixture' ? ({ id, createdBy: 'owner', projectPath: root } as never) : null),
      list: () => [],
    },
  });
  await app.ready();
});

it('does not expose unregistered, denied, traversal, or symlink targets', async () => {
  const references = ['/etc/passwd', '../escape.md', '.env.local', 'looks-public.md', '/tmp/not-registered.md'];
  const result = await app.inject({
    method: 'POST',
    url: '/api/workspace/chat-references',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { groups: [{ threadId: 'thread_fixture', references }] },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(
    result.json().groups[0].results.map((value: { target: unknown }) => value.target),
    references.map(() => null),
  );
  assert.doesNotMatch(result.body, /private|byteLength|absolutePath/);
});
it('binds project discovery to the authenticated conversation owner', async () => {
  for (const headers of [{}, { 'x-cat-cafe-user': 'other-owner' }]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/chat-references',
      headers,
      payload: { groups: [{ threadId: 'thread_fixture', references: ['报告.md'] }] },
    });
    if (!Object.keys(headers).length) assert.equal(response.statusCode, 401);
    else {
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().groups[0].results[0].target, null);
    }
  }
});
it('bounds batches and refuses a caller-supplied project root', async () => {
  for (const payload of [
    { groups: [] },
    { groups: [{ threadId: 'thread_fixture', references: Array(65).fill('a.md') }] },
    { groups: [{ threadId: 'thread_fixture', references: ['a.md'], projectPath: '/etc' }] },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/chat-references',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload,
    });
    assert.equal(response.statusCode, 400);
  }
});
it('refuses desktop commands without an explicit local human and never accepts action-body paths', async () => {
  const url = '/api/workspace/file/actions/open?worktreeId=chat-reference-fixture&path=%E6%8A%A5%E5%91%8A.md';
  assert.ok((await app.inject({ method: 'POST', url })).statusCode >= 400);
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { path: '/etc/passwd' },
  });
  assert.ok(response.statusCode >= 400);
});
it('does not execute git arguments or read a foreign owner commit', async () => {
  const bad = await app.inject({
    method: 'GET',
    url: '/api/workspace/chat-commit-changes?worktreeId=chat-reference-fixture&threadId=thread_fixture&sha=--help',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(bad.statusCode, 400);
  const foreign = await app.inject({
    method: 'GET',
    url: `/api/workspace/chat-commit-changes?worktreeId=chat-reference-fixture&threadId=thread_fixture&sha=${'a'.repeat(40)}`,
    headers: { 'x-cat-cafe-user': 'other-owner' },
  });
  assert.equal(foreign.statusCode, 403);
});
after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

it('resolves paths in one owner-bound batch, preserving real line and missing-file truth', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/workspace/chat-references',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { groups: [{ threadId: 'thread_fixture', references: ['报告.md:2', './old.md'] }] },
  });
  assert.equal(response.statusCode, 200);
  const [group] = response.json().groups;
  assert.equal(group.results[0].target.kind, 'file');
  assert.equal(group.results[0].target.path, '报告.md');
  assert.equal(group.results[0].target.line, 2);
  assert.equal(group.results[0].target.size, 7);
  assert.equal(group.results[1].target.kind, 'missing');
});
it('keeps the authorized absolute path on an opened file for the existing Workspace menu', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/workspace/file?worktreeId=chat-reference-fixture&path=%E6%8A%A5%E5%91%8A.md',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().absolutePath, join(root, '报告.md'));
  assert.equal(await realpath(response.json().absolutePath), await realpath(join(root, '报告.md')));
});

it('recognizes an existing extensionless file and a bare directory without turning unrelated code into missing files', async () => {
  await writeFile(join(root, 'README'), 'Extensionless');
  await mkdir(join(root, 'docs'));
  const response = await app.inject({
    method: 'POST',
    url: '/api/workspace/chat-references',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { groups: [{ threadId: 'thread_fixture', references: ['README', 'not-a-file-or-command', 'docs/'] }] },
  });
  assert.equal(response.json().groups[0].results[0].target?.kind, 'file');
  assert.equal(response.json().groups[0].results[1].target, null);
  assert.equal(response.json().groups[0].results[2].target?.entryType, 'directory');
});

it('rejects invocation, callback and agent-key desktop reveal before validating input or launching an application', async () => {
  for (const url of [
    '/api/workspace/reveal-project',
    '/api/workspace/file/actions/reveal?worktreeId=chat-reference-fixture&path=.',
  ]) {
    for (const credential of ['x-invocation-id', 'x-callback-token', 'x-agent-key-secret']) {
      const result = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-cat-cafe-user': 'owner', [credential]: 'agent-probe' },
        payload: {},
      });
      assert.equal(result.statusCode, 403, `${url} ${credential}`);
      assert.equal(result.json().error, 'local_human_required');
    }
  }
});
