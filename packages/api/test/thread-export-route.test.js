/**
 * Thread Export Image Route Tests
 * 验证导出长图路由生成的前端 URL
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

await import('tsx/esm');
const { threadExportRoutes, resolveFrontendBaseUrl } = await import('../src/routes/thread-export.ts');
const { resolveFrontendCorsOrigins } = await import('../src/config/frontend-origin.ts');
const { ImageExporter } = await import('../src/services/ImageExporter.ts');

const ORIGINAL_CAPTURE = ImageExporter.prototype.capture;
const ORIGINAL_CLOSE = ImageExporter.prototype.close;
const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
const ORIGINAL_FRONTEND_PORT = process.env.FRONTEND_PORT;

function createThreadStore() {
  return {
    async get(threadId) {
      if (threadId !== 'thread-1') return null;
      return {
        id: 'thread-1',
        projectPath: '/tmp',
        title: '测试线程',
        createdBy: 'user-1',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
    },
  };
}

async function buildApp() {
  const app = Fastify();
  await app.register(threadExportRoutes, {
    threadStore: createThreadStore(),
  });
  await app.ready();
  return app;
}

describe('POST /api/threads/:threadId/export-image', () => {
  /** @type {{ url: string; userId: string }[]} */
  let captures = [];

  beforeEach(() => {
    captures = [];
    ImageExporter.prototype.capture = async (url, userId) => {
      captures.push({ url, userId });
      return Buffer.from('fake-png');
    };
    ImageExporter.prototype.close = async () => {};
  });

  afterEach(async () => {
    ImageExporter.prototype.capture = ORIGINAL_CAPTURE;
    ImageExporter.prototype.close = ORIGINAL_CLOSE;

    if (ORIGINAL_FRONTEND_URL === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
    }

    if (ORIGINAL_FRONTEND_PORT === undefined) {
      delete process.env.FRONTEND_PORT;
    } else {
      process.env.FRONTEND_PORT = ORIGINAL_FRONTEND_PORT;
    }
  });

  it('uses localhost:3003 as default frontend URL when FRONTEND_URL is missing', async () => {
    delete process.env.FRONTEND_URL;
    delete process.env.FRONTEND_PORT;

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'http://localhost:3003/thread/thread-1');
    assert.equal(captures[0].userId, 'user-1');
  });

  it('uses FRONTEND_PORT when FRONTEND_URL is missing', async () => {
    delete process.env.FRONTEND_URL;
    process.env.FRONTEND_PORT = '4101';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'http://localhost:4101/thread/thread-1');
  });

  it('uses FRONTEND_URL when present (higher priority than FRONTEND_PORT)', async () => {
    process.env.FRONTEND_URL = 'https://cat-cafe.example.com';
    process.env.FRONTEND_PORT = '4999';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'https://cat-cafe.example.com/thread/thread-1');
  });

  it('closes ImageExporter browser when app.close() fires (BACKLOG #86)', async () => {
    delete process.env.FRONTEND_URL;
    delete process.env.FRONTEND_PORT;

    let closeCalled = false;
    ImageExporter.prototype.close = async () => {
      closeCalled = true;
    };

    const app = await buildApp();

    // Trigger a capture so sharedExporter is instantiated
    await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(closeCalled, false, 'close() should not be called yet');

    // app.close() triggers Fastify onClose hooks
    await app.close();

    assert.equal(closeCalled, true, 'close() must be called during app.close()');
  });

  it('falls back to localhost:3003 when FRONTEND_PORT is invalid', async () => {
    delete process.env.FRONTEND_URL;
    process.env.FRONTEND_PORT = 'not-a-number';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'http://localhost:3003/thread/thread-1');
  });
});

describe('resolveFrontendBaseUrl', () => {
  it('is exported for direct unit testing', () => {
    assert.equal(typeof resolveFrontendBaseUrl, 'function');
  });

  it('warns and falls back when FRONTEND_PORT is invalid', () => {
    const warnings = [];
    const logger = {
      warn(payload, message) {
        warnings.push({ payload, message });
      },
    };

    const baseUrl = resolveFrontendBaseUrl({ FRONTEND_PORT: 'abc' }, logger);

    assert.equal(baseUrl, 'http://localhost:3003');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0].message), /FRONTEND_PORT/i);
  });
});

describe('resolveFrontendCorsOrigins', () => {
  it('includes FRONTEND_PORT origin when configured', () => {
    const origins = resolveFrontendCorsOrigins({ FRONTEND_PORT: '4101' });
    assert.ok(origins.includes('http://localhost:4101'));
    assert.ok(origins.includes('http://localhost:3000'));
    assert.ok(origins.includes('http://localhost:3003'));
  });

  it('includes FRONTEND_URL origin when configured', () => {
    const origins = resolveFrontendCorsOrigins({ FRONTEND_URL: 'https://cat-cafe.example.com/path' });
    assert.ok(origins.includes('https://cat-cafe.example.com'));
  });
});
