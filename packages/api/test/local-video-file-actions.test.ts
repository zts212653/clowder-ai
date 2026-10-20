import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { uploadsRoutes } from '../src/routes/uploads.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

const human = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
for (const source of ['upload', 'workspace'] as const) {
  test(`${source} video actions resolve only the existing media source and retain the local-human fence`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-local-video-'));
    const file = join(root, 'original.mp4');
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
    const base = source === 'upload' ? '/api/uploads/original.mp4' : '/api/workspace/file/raw';
    const query = source === 'upload' ? '' : '?' + new URLSearchParams({ worktreeId: id, path: 'original.mp4' });
    const endpoint = (action: string) => base + '/' + action + query;
    const response = await app.inject({ method: 'GET', url: endpoint('file-info'), headers: human });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().local, true);
    assert.equal(await realpath(response.json().path), await realpath(file));
    assert.equal(response.json().mime, 'video/mp4');
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
