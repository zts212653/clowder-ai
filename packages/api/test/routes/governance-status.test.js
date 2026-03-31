import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { governanceStatusRoute } from '../../dist/routes/governance-status.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user' };

function buildApp() {
  const app = Fastify();
  app.register(governanceStatusRoute);
  return app;
}

describe('GET /api/governance/status', () => {
  let app;
  let testRoot;

  beforeEach(async () => {
    app = buildApp();
    testRoot = join(tmpdir(), `gov-status-test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await app.close();
    await rm(testRoot, { recursive: true, force: true });
  });

  it('returns isEmptyDir=true for empty directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(testRoot)}`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.isEmptyDir, true);
    assert.equal(body.isGitRepo, false);
    assert.equal(body.ready, false);
  });

  it('returns isGitRepo=true for git-initialized directory', async () => {
    execFileSync('git', ['init'], { cwd: testRoot, stdio: 'ignore' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(testRoot)}`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.isGitRepo, true);
    assert.equal(body.isEmptyDir, false); // .git exists
  });

  it('returns isEmptyDir=false for non-empty directory', async () => {
    await writeFile(join(testRoot, 'file.txt'), 'hello');
    const res = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(testRoot)}`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.isEmptyDir, false);
  });

  it('returns gitAvailable boolean', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(testRoot)}`,
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(typeof body.gitAvailable, 'boolean');
    // On dev machines git should be available
    assert.equal(body.gitAvailable, true);
  });

  it('rejects requests without identity header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(testRoot)}`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects missing projectPath', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/governance/status',
      headers: HEADERS,
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects invalid projectPath', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/governance/status?projectPath=/nonexistent-xyz-12345',
      headers: HEADERS,
    });
    assert.ok([403, 400].includes(res.statusCode));
  });
});
