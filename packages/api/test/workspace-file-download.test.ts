import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { securityHeadersPlugin } from '../src/infrastructure/security-headers.js';
import { workspaceRoutes } from '../src/routes/workspace.js';

const human = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
test('the common file download returns exact authorized document/binary bytes as attachments without enabling inline scripts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-file-download-'));
  const outside = await mkdtemp(join(tmpdir(), 'f309-download-outside-'));
  const app = Fastify();
  await app.register(securityHeadersPlugin);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const id = 'download-' + randomUUID();
  registerWorktrees([{ id, root, head: 'fixture', branch: 'fixture' }]);
  await app.register(workspaceRoutes);
  const bytes = Buffer.from([0, 255, 1, 13, 10, 2, 128]);
  const files = [
    ['doc-0a6831f6718f-Clowder_AI_后续建设与分工讨论稿-v0_2.md', Buffer.from('# 中文原字节\n')],
    ['LICENSE', Buffer.from('Original license words')],
    ['unknown.bin', bytes],
    ['run.command', Buffer.from('echo must-never-execute')],
    ['page.html', Buffer.from('<script>danger()</script>')],
    ['empty.txt', Buffer.alloc(0)],
  ] as const;
  const endpoint = (path: string) => '/api/workspace/file/download?' + new URLSearchParams({ worktreeId: id, path });
  for (const [name, content] of files) {
    await writeFile(join(root, name), content);
    const response = await app.inject({ method: 'GET', url: endpoint(name), headers: human });
    assert.equal(response.statusCode, 200, name + ': ' + response.body);
    assert.deepEqual(response.rawPayload, content);
    assert.match(response.headers['content-disposition'] ?? '', /^attachment; /);
    assert.ok(response.headers['content-disposition']?.includes(encodeURIComponent(name)), name);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'] ?? '', /sandbox/);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  const ranged = await app.inject({
    method: 'GET',
    url: endpoint('unknown.bin'),
    headers: { ...human, range: 'bytes=1-3' },
  });
  assert.equal(ranged.statusCode, 206);
  assert.deepEqual(ranged.rawPayload, bytes.subarray(1, 4));
  for (const headers of [{}, { ...human, 'x-forwarded-for': '203.0.113.9' }, { ...human, 'x-invocation-id': 'forged' }])
    assert.equal((await app.inject({ method: 'GET', url: endpoint('unknown.bin'), headers })).statusCode, 401);
  await writeFile(join(root, '.env'), 'not-readable');
  await mkdir(join(root, 'folder.md'));
  await writeFile(join(outside, 'private.txt'), 'outside');
  await symlink(join(outside, 'private.txt'), join(root, 'escape.txt'));
  for (const name of ['.env', '../private.txt', 'escape.txt'])
    assert.equal((await app.inject({ method: 'GET', url: endpoint(name), headers: human })).statusCode, 403, name);
  assert.equal((await app.inject({ method: 'GET', url: endpoint('folder.md'), headers: human })).statusCode, 400);
  const raw = await app.inject({
    method: 'GET',
    url: '/api/workspace/file/raw?' + new URLSearchParams({ worktreeId: id, path: 'page.html' }),
    headers: human,
  });
  assert.equal(raw.statusCode, 400, 'the media URL must not become an active HTML host');
  await writeFile(join(root, 'shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>');
  const svg = await app.inject({
    method: 'GET',
    url: '/api/workspace/file/raw?' + new URLSearchParams({ worktreeId: id, path: 'shape.svg' }),
    headers: human,
  });
  assert.equal(svg.statusCode, 200);
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.match(svg.headers['content-security-policy'] ?? '', /sandbox/);
  assert.equal(svg.headers['x-content-type-options'], 'nosniff');
  const avifBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3a7450' } })
    .avif()
    .toBuffer();
  await writeFile(join(root, 'image.avif'), avifBytes);
  const avif = await app.inject({
    method: 'GET',
    url: '/api/workspace/file/raw?' + new URLSearchParams({ worktreeId: id, path: 'image.avif' }),
    headers: human,
  });
  assert.equal(avif.statusCode, 200, avif.body);
  assert.equal(avif.headers['content-type'], 'image/avif');
  assert.deepEqual(avif.rawPayload, avifBytes);
});
