import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { projectSetupRoute } from '../../dist/routes/projects-setup.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };

function buildApp() {
  const app = Fastify();
  app.register(projectSetupRoute);
  return app;
}

describe('POST /api/projects/setup', () => {
  let app;
  let testRoot;

  beforeEach(async () => {
    app = buildApp();
    testRoot = join(tmpdir(), `setup-test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await app.close();
    await rm(testRoot, { recursive: true, force: true });
  });

  it('mode=skip calls governance bootstrap only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: testRoot, mode: 'skip' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.ok, true);
    // Governance files should be created
    const entries = await readdir(testRoot, { recursive: true });
    const entryNames = entries.map(String);
    // Governance bootstrap must produce at least one artifact
    assert.ok(entryNames.length > 0, 'skip mode should still create governance files');
  });

  it('mode=init runs git init then governance bootstrap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: testRoot, mode: 'init' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.ok, true);
    // .git directory should exist
    const gitStat = await stat(join(testRoot, '.git'));
    assert.ok(gitStat.isDirectory());
  });

  it('mode=clone rejects missing gitCloneUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: testRoot, mode: 'clone' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('gitCloneUrl'));
  });

  it('mode=clone rejects non-https/git@ URLs', async () => {
    for (const badUrl of ['file:///etc/passwd', 'ftp://example.com/repo', '/local/path']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/setup',
        headers: HEADERS,
        payload: { projectPath: testRoot, mode: 'clone', gitCloneUrl: badUrl },
      });
      assert.equal(res.statusCode, 400, `should reject URL: ${badUrl}`);
    }
  });

  it('mode=clone rejects non-empty directory', async () => {
    await writeFile(join(testRoot, 'file.txt'), 'not empty');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: testRoot, mode: 'clone', gitCloneUrl: 'https://github.com/example/repo.git' },
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.equal(body.errorKind, 'not_empty');
  });

  it('mode=clone returns errorKind on invalid repo URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: {
        projectPath: testRoot,
        mode: 'clone',
        gitCloneUrl: 'https://github.com/nonexistent-org-xyz/nonexistent-repo-xyz.git',
      },
    });
    // Should fail with a classified error
    assert.ok(res.statusCode >= 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.errorKind != null);
    assert.ok(['not_found', 'auth_failed', 'network_error', 'timeout'].includes(body.errorKind));
  });

  it('rejects invalid mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: testRoot, mode: 'invalid' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects missing projectPath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { mode: 'skip' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects requests without identity header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: { 'content-type': 'application/json' },
      payload: { projectPath: testRoot, mode: 'skip' },
    });
    assert.equal(res.statusCode, 401);
  });
});
