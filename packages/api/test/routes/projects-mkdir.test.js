import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * POST /api/projects/mkdir — create a subdirectory within an allowed parent.
 * Uses parentPath + name to prevent path-traversal attacks.
 */

// Inline mini-app to avoid importing the full server
import Fastify from 'fastify';
import { mkdirRoute } from '../../dist/routes/projects-mkdir.js';

function buildApp() {
  const app = Fastify();
  app.register(mkdirRoute);
  return app;
}

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };

describe('POST /api/projects/mkdir', () => {
  let app;
  let testRoot;

  beforeEach(async () => {
    app = buildApp();
    // Create a temp directory as our "allowed" parent
    testRoot = join(tmpdir(), `mkdir-test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await app.close();
    await rm(testRoot, { recursive: true, force: true });
  });

  it('creates directory with valid parentPath and name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot, name: 'my-project' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.name, 'my-project');
    assert.ok(body.createdPath.endsWith('my-project'));
    // Verify directory actually exists
    const info = await stat(body.createdPath);
    assert.ok(info.isDirectory());
  });

  it('rejects name containing ".."', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot, name: '../escape' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('Invalid'));
  });

  it('rejects name containing path separators', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot, name: 'a/b' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects name with special characters', async () => {
    for (const bad of ['a:b', 'a*b', 'a?b', 'a<b', 'a>b', 'a|b', 'a"b']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/mkdir',
        headers: HEADERS,
        payload: { parentPath: testRoot, name: bad },
      });
      assert.equal(res.statusCode, 400, `should reject name "${bad}"`);
    }
  });

  it('rejects when parentPath does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: '/nonexistent-path-xyz-12345', name: 'test' },
    });
    assert.ok([403, 400].includes(res.statusCode));
  });

  it('rejects when target directory already exists', async () => {
    await mkdir(join(testRoot, 'existing'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot, name: 'existing' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('rejects missing parentPath or name', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { name: 'test' },
    });
    assert.equal(res2.statusCode, 400);
  });

  it('rejects requests without identity header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: { 'content-type': 'application/json' },
      payload: { parentPath: testRoot, name: 'test' },
    });
    assert.equal(res.statusCode, 401);
  });
});
