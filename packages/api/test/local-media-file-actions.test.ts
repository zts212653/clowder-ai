import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { uploadsRoutes } from '../src/routes/uploads.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

const human = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
test('Chinese documents, LICENSE, unknown bytes and scripts keep the same local facts through every entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-source-capabilities-'));
  const names = ['doc-0a6831f6718f-Clowder_AI_后续建设与分工讨论稿-v0_2.md', 'LICENSE', 'unknown.bin', 'run.command'];
  for (const name of names) await writeFile(join(root, name), 'same local bytes');
  await mkdir(join(root, 'folder.png'));
  const app = Fastify();
  const id = 'parity-' + randomUUID();
  registerWorktrees([{ id, root, head: 'fixture', branch: 'fixture' }]);
  await app.register(uploadsRoutes, { uploadDir: root });
  await app.register(workspaceRoutes);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const name of [...names, 'folder.png']) {
    const query = new URLSearchParams({ worktreeId: id, path: name });
    const paths = [
      `/api/uploads/${encodeURIComponent(name)}`,
      `/api/workspace/file/raw?${query}`,
      `/api/workspace/file/actions?${query}`,
    ];
    const facts = [];
    for (const path of paths) {
      const [base, parameters] = path.split('?');
      const response = await app.inject({
        method: 'GET',
        url: `${base}/file-info${parameters ? '?' + parameters : ''}`,
        headers: human,
      });
      assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
      const info = response.json();
      assert.equal(info.local, true, `${name} is a confirmed local object, independently of launch permissions`);
      assert.equal(await realpath(info.path), await realpath(join(root, name)));
      assert.equal(info.canReveal, true);
      if (name === 'unknown.bin') assert.equal(info.mime, 'application/octet-stream');
      const launchable = name !== 'run.command' && name !== 'unknown.bin' && name !== 'folder.png';
      assert.equal(info.canOpen, launchable, `${name} launch capability`);
      facts.push({ path: info.path, mime: info.mime, canOpen: info.canOpen, canReveal: info.canReveal });
    }
    assert.deepEqual(facts[0], facts[1]);
    assert.deepEqual(facts[1], facts[2]);
    if (name !== 'folder.png') {
      const ordinary = await app.inject({
        method: 'GET',
        url: '/api/workspace/file?' + new URLSearchParams({ worktreeId: id, path: name }),
        headers: human,
      });
      assert.equal(ordinary.statusCode, 200, ordinary.body);
      assert.equal(
        ordinary.json().mime,
        facts[1].mime,
        `${name}: the ordinary reader and action metadata must describe the same file`,
      );
    }
  }
});
for (const source of ['upload', 'workspace'] as const) {
  test(`${source} a read-only document keeps its own local file capabilities without an original locator`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-document-actions-'));
    const file = join(root, 'copy.md');
    await writeFile(file, '# Published copy\n');
    const app = Fastify();
    const id = 'document-' + randomUUID();
    if (source === 'upload') await app.register(uploadsRoutes, { uploadDir: root });
    else {
      registerWorktrees([{ id, root, head: 'fixture', branch: 'fixture' }]);
      await app.register(workspaceRoutes);
    }
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const endpoint = (action: string) =>
      source === 'upload'
        ? `/api/uploads/copy.md/${action}`
        : '/api/workspace/file/raw/' + action + '?' + new URLSearchParams({ worktreeId: id, path: 'copy.md' });
    const info = await app.inject({ method: 'GET', url: endpoint('file-info'), headers: human });
    assert.equal(info.statusCode, 200, info.body);
    assert.equal(info.json().local, true, 'a copy is local even when it has no original write locator');
    assert.equal(await realpath(info.json().path), await realpath(file));
    assert.equal(info.json().mime, 'text/markdown');
    assert.equal(info.json().worktreeId, undefined, 'upload capabilities must not create an original locator');
    for (const headers of [
      { ...human, origin: 'https://remote.example' },
      { ...human, 'x-invocation-id': 'cat', 'x-callback-token': 'callback' },
    ]) {
      const denied = await app.inject({ method: 'GET', url: endpoint('file-info'), headers });
      assert.deepEqual(denied.json(), { local: false });
      assert.ok(!denied.body.includes(root));
      const open = await app.inject({ method: 'POST', url: endpoint('open'), headers, payload: {} });
      assert.equal(open.statusCode, 403);
    }
  });
}
for (const source of ['upload', 'workspace'] as const) {
  test(`${source} keeps local navigation for scripts and directories while refusing launch`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-media-negative-'));
    const files = [
      'run.command',
      'run.sh',
      'photo.png.exe',
      'run.py',
      'run.PY',
      'run.js',
      'run.mjs',
      'run.fish',
      'run.pl',
      'run.rb',
      'run.php',
      'run.psm1',
      'run.ps1',
      'run.bash',
      'archive.zip',
    ];
    for (const name of files) await writeFile(join(root, name), 'not media');
    for (const name of ['folder.png', 'Application.app']) await mkdir(join(root, name));
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const id = 'negative-' + randomUUID();
    if (source === 'upload') await app.register(uploadsRoutes, { uploadDir: root });
    else {
      registerWorktrees([{ id, root, head: 'fixture', branch: 'fixture' }]);
      await app.register(workspaceRoutes);
    }
    const endpoint = (name: string, action: string) =>
      source === 'upload'
        ? `/api/uploads/${name}/${action}`
        : '/api/workspace/file/raw/' + action + '?' + new URLSearchParams({ worktreeId: id, path: name });
    for (const name of [...files, 'folder.png', 'Application.app']) {
      const info = await app.inject({ method: 'GET', url: endpoint(name, 'file-info'), headers: human });
      assert.equal(info.statusCode, 200, info.body);
      assert.equal(info.json().local, true);
      assert.equal(info.json().canReveal, true);
      assert.equal(info.json().canOpen, false, `${name} must not gain launch capability`);
      const denied = await app.inject({ method: 'POST', url: endpoint(name, 'open'), headers: human, payload: {} });
      assert.equal(denied.statusCode, 403);
    }
  });
  for (const media of [
    { name: 'original.mp4', mime: 'video/mp4' },
    { name: 'construction-map.png', mime: 'image/png' },
  ]) {
    test(`${source} ${media.name} actions resolve only the existing media source and retain the local-human fence`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'f309-local-media-'));
      const file = join(root, media.name);
      await writeFile(file, 'original video fixture');
      const outside = await mkdtemp(join(tmpdir(), 'f309-outside-'));
      await writeFile(join(outside, 'other.mp4'), 'outside');
      await symlink(join(outside, 'other.mp4'), join(root, 'escaped.mp4'));
      const app = Fastify();
      const id = 'video-' + randomUUID();
      if (source === 'upload') await app.register(uploadsRoutes, { uploadDir: root });
      else {
        registerWorktrees([{ id, root, head: 'fixture', branch: 'fixture' }]);
        await app.register(workspaceRoutes);
      }
      t.after(async () => {
        await app.close();
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      });
      const base = source === 'upload' ? `/api/uploads/${media.name}` : '/api/workspace/file/raw';
      const query = source === 'upload' ? '' : '?' + new URLSearchParams({ worktreeId: id, path: media.name });
      const endpoint = (action: string) => base + '/' + action + query;
      const response = await app.inject({ method: 'GET', url: endpoint('file-info'), headers: human });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().local, true);
      assert.equal(await realpath(response.json().path), await realpath(file));
      assert.equal(response.json().mime, media.mime);
      const anonymous = await app.inject({ method: 'GET', url: endpoint('file-info'), headers: { host: 'localhost' } });
      assert.equal(anonymous.statusCode, 401);
      assert.ok(!anonymous.body.includes(file));
      for (const headers of [
        { ...human, 'x-forwarded-for': '192.0.2.4' },
        { ...human, origin: 'https://remote.example' },
        { ...human, 'x-invocation-id': 'agent', 'x-callback-token': 'secret' },
      ]) {
        const info = await app.inject({ method: 'GET', url: endpoint('file-info'), headers });
        assert.equal(info.statusCode, 200);
        assert.deepEqual(info.json(), { local: false });
        for (const action of ['reveal', 'open']) {
          const result = await app.inject({ method: 'POST', url: endpoint(action), headers, payload: {} });
          assert.equal(result.statusCode, 403);
          assert.ok(!result.body.includes(file));
        }
      }
      for (const action of ['reveal', 'open']) {
        const forged = await app.inject({
          method: 'POST',
          url: endpoint(action),
          headers: human,
          payload: { path: join(outside, 'other.mp4') },
        });
        assert.equal(forged.statusCode, 400, 'callers cannot substitute a filesystem path');
      }
      const escaped =
        source === 'upload'
          ? '/api/uploads/escaped.mp4/file-info'
          : '/api/workspace/file/raw/file-info?' + new URLSearchParams({ worktreeId: id, path: 'escaped.mp4' });
      const denied = await app.inject({ method: 'GET', url: escaped, headers: human });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.ok(!denied.body.includes(outside));
      await rm(file);
      const gone = await app.inject({ method: 'POST', url: endpoint('open'), headers: human, payload: {} });
      assert.equal(gone.statusCode, 404, 'file must be resolved again at action time');
    });
  }
}
