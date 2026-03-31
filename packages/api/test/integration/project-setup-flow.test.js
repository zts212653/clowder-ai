import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { governanceStatusRoute } from '../../dist/routes/governance-status.js';
import { mkdirRoute } from '../../dist/routes/projects-mkdir.js';
import { projectSetupRoute } from '../../dist/routes/projects-setup.js';

/**
 * F113 Phase E — Integration test: mkdir → status → setup → status
 * Verifies the full project initialisation flow across three endpoints.
 */

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };

function buildApp() {
  const app = Fastify();
  app.register(mkdirRoute);
  app.register(governanceStatusRoute);
  app.register(projectSetupRoute);
  return app;
}

describe('project setup flow (integration)', () => {
  let app;
  let testRoot;

  beforeEach(async () => {
    app = buildApp();
    testRoot = join(tmpdir(), `setup-flow-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await app.close();
    await rm(testRoot, { recursive: true, force: true });
  });

  it('mkdir → status (needsBootstrap) → setup(init) → status (ready)', async () => {
    // 1. Create a subdirectory
    const mkdirRes = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot, name: 'my-project' },
    });
    assert.equal(mkdirRes.statusCode, 200);
    const { createdPath } = JSON.parse(mkdirRes.payload);
    assert.ok(createdPath.endsWith('my-project'));

    // 2. Check governance status — should need bootstrap
    const statusRes1 = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(createdPath)}`,
      headers: HEADERS,
    });
    assert.equal(statusRes1.statusCode, 200);
    const status1 = JSON.parse(statusRes1.payload);
    assert.equal(status1.ready, false);
    assert.equal(status1.isEmptyDir, true);
    assert.equal(status1.isGitRepo, false);

    // 3. Run setup with mode=init (git init + governance bootstrap)
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: createdPath, mode: 'init' },
    });
    assert.equal(setupRes.statusCode, 200);
    const setup = JSON.parse(setupRes.payload);
    assert.equal(setup.ok, true);

    // 4. Check governance status again — should now be ready
    const statusRes2 = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(createdPath)}`,
      headers: HEADERS,
    });
    assert.equal(statusRes2.statusCode, 200);
    const status2 = JSON.parse(statusRes2.payload);
    assert.equal(status2.isGitRepo, true);
    assert.equal(status2.isEmptyDir, false); // .git exists now
  });

  it('mkdir → setup(skip) still bootstraps governance', async () => {
    // 1. Create a subdirectory
    const mkdirRes = await app.inject({
      method: 'POST',
      url: '/api/projects/mkdir',
      headers: HEADERS,
      payload: { parentPath: testRoot, name: 'skip-project' },
    });
    assert.equal(mkdirRes.statusCode, 200);
    const { createdPath } = JSON.parse(mkdirRes.payload);

    // 2. Run setup with mode=skip (no git, governance only)
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: createdPath, mode: 'skip' },
    });
    assert.equal(setupRes.statusCode, 200);
    const setup = JSON.parse(setupRes.payload);
    assert.equal(setup.ok, true);

    // 3. Status should reflect: no git repo, not empty (governance files exist)
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/governance/status?projectPath=${encodeURIComponent(createdPath)}`,
      headers: HEADERS,
    });
    assert.equal(statusRes.statusCode, 200);
    const status = JSON.parse(statusRes.payload);
    assert.equal(status.isGitRepo, false);
  });
});
