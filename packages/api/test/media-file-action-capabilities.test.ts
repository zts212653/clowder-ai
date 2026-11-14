import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerMediaFileActions } from '../src/routes/media-file-actions.js';

for (const unsupportedPlatform of ['win32', 'linux']) {
  test(`${unsupportedPlatform} retains local file facts without advertising unavailable actions`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'issue1792-capability-'));
    const path = join(root, 'report.md');
    await writeFile(path, '# authorized file');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: unsupportedPlatform, configurable: true });
    const app = Fastify();
    registerMediaFileActions(app, '/file', {
      authorize: async () => ({ path, mime: 'text/markdown', byteLength: 17 }),
      onError: (reply) => reply.code(500).send({ error: 'failed' }),
    });
    t.after(async () => {
      Object.defineProperty(process, 'platform', platform);
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const headers = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
    const info = await app.inject({ url: '/file/file-info', headers });
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().local, true);
    assert.equal(info.json().path, path);
    assert.equal(info.json().canOpen, false);
    assert.equal(info.json().canReveal, false);
    for (const action of ['open', 'reveal']) {
      const response = await app.inject({ method: 'POST', url: `/file/${action}`, headers, payload: {} });
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error, 'desktop_action_unavailable');
    }
  });
}
