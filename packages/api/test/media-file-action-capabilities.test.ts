import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerMediaFileActions } from '../src/routes/media-file-actions.js';

for (const unsupportedPlatform of ['linux']) {
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

test('Windows advertises and invokes the shared shell actions only on an authorized explicit click', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'issue2103-capability-'));
  const path = join(root, 'Report 100% & final.md');
  await writeFile(path, '# authorized file');
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const calls: [string, string][] = [];
  let associated = true;
  let canOpen = true;
  registerMediaFileActions(app, '/file', {
    authorize: async () => ({ path, mime: 'text/markdown', byteLength: 17, canOpen }),
    onError: (reply) => reply.code(500).send({ error: 'failed' }),
    platform: 'win32',
    windows: {
      application: async (file) => {
        assert.equal(file, path);
        return associated ? { name: 'Editor' } : { noDefault: true };
      },
      run: async (action, file) => {
        calls.push([action, file]);
        return action === 'open' && !associated ? 'default_application_unavailable' : undefined;
      },
    },
  });
  const headers = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
  const read = () => app.inject({ url: '/file/file-info', headers });
  const action = (name: string, extraHeaders = {}) =>
    app.inject({ method: 'POST', url: '/file/' + name, headers: { ...headers, ...extraHeaders }, payload: {} });
  const ready = (await read()).json();
  assert.equal(ready.canOpen, true);
  assert.equal(ready.canReveal, true);
  assert.equal(ready.defaultApplication, 'Editor');
  assert.equal(ready.canOpenWith, true);
  assert.deepEqual(calls, []);
  assert.equal((await action('open', { 'x-callback-token': 'caller' })).statusCode, 403);
  assert.equal((await action('open')).statusCode, 200);
  assert.equal((await action('reveal')).statusCode, 200);
  associated = false;
  assert.equal((await read()).json().noDefaultApplication, true);
  assert.equal((await action('open')).json().error, 'default_application_unavailable');
  assert.equal((await action('open-with')).statusCode, 200);
  assert.deepEqual(calls, [
    ['open', path],
    ['reveal', path],
    ['open', path],
    ['open-with', path],
  ]);
  canOpen = false;
  assert.equal((await read()).json().canOpenWith, false);
  assert.equal((await action('open')).statusCode, 403);
  assert.equal((await action('open-with')).statusCode, 403);
  assert.equal(calls.length, 4);
});
