import assert from 'node:assert/strict';
import { mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
const largeSize = 12 * 1024 * 1024 + bytes.length;

describe('authorized workspace raw media byte ranges', () => {
  let app;
  let base;
  let outside;
  let relativeBase;
  const streams = [];
  const worktreeId = `raw-range-${process.pid}`;

  before(async () => {
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    const { registerWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
    const root = await realpath(resolve(fileURLToPath(import.meta.url), '../../../..'));
    registerWorktrees([{ id: worktreeId, root, branch: 'raw-range-test', head: 'test' }]);
    base = await mkdtemp(join(root, '__raw_range_test__-'));
    relativeBase = basename(base);
    for (const name of ['clip.mp4', 'clip.mp3', 'small.png', 'empty.mp4']) {
      await writeFile(join(base, name), name === 'empty.mp4' ? Buffer.alloc(0) : bytes);
    }
    for (const name of ['large.mp4', 'large.png', 'large.mp3']) {
      const handle = await open(join(base, name), 'w');
      try {
        await handle.truncate(largeSize);
        await handle.write(bytes, 0, bytes.length, largeSize - bytes.length);
      } finally {
        await handle.close();
      }
    }
    await writeFile(join(base, 'large.txt'), 'a'.repeat(1024 * 1024 + 64));
    outside = await mkdtemp('/tmp/f322-raw-range-outside-');
    await writeFile(join(outside, 'outside.mp4'), bytes);
    await symlink(join(outside, 'outside.mp4'), join(base, 'escape.mp4'));
    app = Fastify();
    app.addHook('onSend', (request, _reply, payload, done) => {
      if (request.url.startsWith('/api/workspace/file/raw') && payload?.pipe) {
        streams.push({ url: request.url, start: payload.start, end: payload.end });
      }
      done(null, payload);
    });
    await app.register(workspaceRoutes, {
      callbackRegistry: { verify: async () => ({ ok: false, reason: 'invalid_token' }) },
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    if (base) await rm(base, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  });

  const get = (file, range, root = worktreeId) =>
    app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: root, path: file })}`,
      ...(range === undefined ? {} : { headers: { range } }),
    });

  for (const [label, range, start, end] of [
    ['closed interval', 'bytes=2-5', 2, 5],
    ['open interval', 'bytes=56-', 56, 63],
    ['suffix', 'bytes=-4', 60, 63],
    ['end clamped to EOF', 'bytes=62-999', 62, 63],
    ['last byte', 'bytes=63-63', 63, 63],
    ['suffix larger than file', 'bytes=-100', 0, 63],
  ]) {
    it(`serves the exact ${label} as 206`, async () => {
      const result = await get(`${relativeBase}/clip.mp4`, range);
      assert.equal(result.statusCode, 206);
      assert.equal(result.headers['accept-ranges'], 'bytes');
      assert.equal(result.headers['content-range'], `bytes ${start}-${end}/64`);
      assert.equal(Number(result.headers['content-length']), end - start + 1);
      assert.equal(result.headers['content-type'], 'video/mp4');
      assert.deepEqual(result.rawPayload, bytes.subarray(start, end + 1));
    });
  }

  for (const range of [
    'bytes=64-',
    'bytes=9-5',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,3-5',
    'items=0-3',
    'bytes=9007199254740992-',
  ]) {
    it(`rejects ${range} with an unsatisfied 416`, async () => {
      const result = await get(`${relativeBase}/clip.mp4`, range);
      assert.equal(result.statusCode, 416);
      assert.equal(result.headers['content-range'], 'bytes */64');
      assert.equal(result.headers['accept-ranges'], 'bytes');
      assert.equal(result.rawPayload.length, 0);
    });
  }

  it('returns 416 for a range against an empty video', async () => {
    const result = await get(`${relativeBase}/empty.mp4`, 'bytes=0-');
    assert.equal(result.statusCode, 416);
    assert.equal(result.headers['content-range'], 'bytes */0');
  });

  it('streams a >10MB video tail directly without reading its prefix', async () => {
    const start = largeSize - bytes.length;
    const result = await get(`${relativeBase}/large.mp4`, `bytes=${start}-`);
    assert.equal(result.statusCode, 206);
    assert.equal(result.headers['content-range'], `bytes ${start}-${largeSize - 1}/${largeSize}`);
    assert.equal(Number(result.headers['content-length']), bytes.length);
    assert.deepEqual(result.rawPayload, bytes);
    assert.equal(streams.at(-1).start, start);
    assert.equal(streams.at(-1).end, largeSize - 1);
  });

  it('keeps no-Range video playback as a complete 200 stream', async () => {
    const result = await get(`${relativeBase}/large.mp4`);
    assert.equal(result.statusCode, 200);
    assert.equal(Number(result.headers['content-length']), largeSize);
    assert.equal(result.headers['content-range'], undefined);
    assert.equal(result.headers['accept-ranges'], 'bytes');
    assert.equal(result.headers['cache-control'], 'private, max-age=60');
    assert.deepEqual(result.rawPayload.subarray(-bytes.length), bytes);
  });

  it('applies the existing range semantics to small audio', async () => {
    const result = await get(`${relativeBase}/clip.mp3`, 'bytes=1-3');
    assert.equal(result.statusCode, 206);
    assert.equal(result.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(result.rawPayload, bytes.subarray(1, 4));
  });

  it('preserves small image/no-Range behavior', async () => {
    const result = await get(`${relativeBase}/small.png`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['content-type'], 'image/png');
    assert.deepEqual(result.rawPayload, bytes);
  });

  it('keeps large video metadata previews empty rather than buffering the movie', async () => {
    const result = await app.inject({
      url: `/api/workspace/file?${new URLSearchParams({ worktreeId, path: `${relativeBase}/large.mp4` })}`,
    });
    assert.equal(result.statusCode, 200);
    const preview = result.json();
    assert.equal(preview.binary, true);
    assert.equal(preview.content, '');
    assert.equal(preview.sha256, '');
    assert.equal(preview.size, largeSize);
  });

  it('keeps text previews bounded to their existing 1MB limit', async () => {
    const result = await app.inject({
      url: `/api/workspace/file?${new URLSearchParams({ worktreeId, path: `${relativeBase}/large.txt` })}`,
    });
    assert.equal(result.statusCode, 200);
    const preview = result.json();
    assert.equal(preview.truncated, true);
    assert.equal(preview.content.length, 1024 * 1024);
    assert.equal(preview.sha256, '');
  });

  for (const name of ['large.png', 'large.mp3']) {
    it(`preserves the 10MB ${name} limit even with Range`, async () => {
      const result = await get(`${relativeBase}/${name}`, 'bytes=0-3');
      assert.equal(result.statusCode, 413);
    });
  }

  for (const [label, path] of [
    ['traversal', '../outside.mp4'],
    ['denylisted path', '.env'],
    ['outside symlink', () => `${relativeBase}/escape.mp4`],
  ]) {
    it(`still rejects ${label} before a range response`, async () => {
      const result = await get(typeof path === 'function' ? path() : path, 'bytes=0-3');
      assert.equal(result.statusCode, 403);
      assert.equal(result.headers['content-range'], undefined);
    });
  }

  it('rejects an unknown root before opening its media', async () => {
    const result = await get(`${relativeBase}/clip.mp4`, 'bytes=0-3', 'unregistered-raw-root');
    assert.equal(result.statusCode, 404);
  });

  it('still rejects invalid callback credentials before serving a range', async () => {
    const result = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?${new URLSearchParams({ worktreeId, path: `${relativeBase}/clip.mp4` })}`,
      headers: { range: 'bytes=0-3', 'x-invocation-id': 'invalid', 'x-callback-token': 'invalid' },
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['content-range'], undefined);
  });
});
