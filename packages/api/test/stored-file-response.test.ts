import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { securityHeadersPlugin } from '../src/infrastructure/security-headers.js';
import { storedAttachmentMediaRoutes } from '../src/routes/stored-attachment-media.js';
import { uploadsRoutes } from '../src/routes/uploads.js';

for (const source of ['uploads', 'connector-media'] as const) {
  test(`${source} preserves stored bytes while scripts/documents cannot become an active API-origin page`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-stored-response-'));
    const app = Fastify();
    await app.register(securityHeadersPlugin);
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    if (source === 'uploads') await app.register(uploadsRoutes, { uploadDir: root });
    else await app.register(storedAttachmentMediaRoutes, { mediaDir: root });
    const prefix = source === 'uploads' ? '/uploads/' : '/api/connector-media/';
    const files = [
      ['中文页面.html', '<script>window.__f309UntrustedScript=true</script>', false],
      ['source.js', 'window.__f309UntrustedScript=true', false],
      ['notes.md', '# exact stored bytes', false],
      ['unknown.bin', 'unclassified', false],
      [
        'shape.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__f309UntrustedScript=true</script></svg>',
        true,
      ],
      ['image.png', 'image', true],
      ['movie.mp4', 'video', true],
      ['voice.wav', 'audio', true],
    ] as const;
    for (const [name, body, inline] of files) {
      await writeFile(join(root, name), body);
      const response = await app.inject({ method: 'GET', url: prefix + encodeURIComponent(name) });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, body);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.match(response.headers['content-security-policy'] ?? '', /(?:^|;\s*)sandbox(?:;|$)/);
      assert.ok(response.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
      if (inline) assert.equal(response.headers['content-disposition'], undefined, name);
      else {
        assert.equal(response.headers['content-type'], 'application/octet-stream');
        assert.match(response.headers['content-disposition'] ?? '', /^attachment;/);
        assert.ok(response.headers['content-disposition']?.includes(encodeURIComponent(name)), name);
      }
    }
  });
}
