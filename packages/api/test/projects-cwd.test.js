import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

const { projectsRoutes } = await import('../dist/routes/projects.js');

describe('GET /api/projects/cwd', () => {
  let fixtureRoot;
  let runtimeRoot;
  let runtimeApiRoot;
  let workspaceRoot;
  let workspaceApiRoot;
  let previousCwd;
  let previousRuntimeRoot;
  let previousWorkspaceRoot;
  let previousAllowedRoots;

  before(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-project-recommendation-'));
    runtimeRoot = join(fixtureRoot, 'cat-cafe-runtime');
    runtimeApiRoot = join(runtimeRoot, 'packages', 'api');
    workspaceRoot = join(fixtureRoot, 'cat-cafe');
    workspaceApiRoot = join(workspaceRoot, 'packages', 'api');
    await Promise.all([
      mkdir(join(runtimeApiRoot, 'runtime-only-child'), { recursive: true }),
      mkdir(join(workspaceRoot, 'workspace-child'), { recursive: true }),
      mkdir(workspaceApiRoot, { recursive: true }),
    ]);
    await writeFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    previousCwd = process.cwd();
    previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    previousWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    previousAllowedRoots = process.env.PROJECT_ALLOWED_ROOTS;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    process.env.PROJECT_ALLOWED_ROOTS = await realpath(fixtureRoot);
    process.chdir(runtimeApiRoot);
  });

  after(async () => {
    process.chdir(previousCwd);
    if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspaceRoot;
    if (previousAllowedRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
    else process.env.PROJECT_ALLOWED_ROOTS = previousAllowedRoots;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('recommends the canonical workspace root when the API runs from the runtime projection', async () => {
    const app = Fastify();
    await app.register(projectsRoutes);
    await app.ready();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/projects/cwd' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().path, await realpath(workspaceRoot));
      assert.notEqual(response.json().path, await realpath(runtimeApiRoot));
    } finally {
      await app.close();
    }
  });

  it('uses the canonical workspace when path completion omits an explicit cwd', async () => {
    const app = Fastify();
    await app.register(projectsRoutes);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects/complete?prefix=workspace',
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().entries, [
        { name: 'workspace-child/', path: await realpath(join(workspaceRoot, 'workspace-child')), isDirectory: true },
      ]);
    } finally {
      await app.close();
    }
  });

  it('walks from a source API cwd to its workspace root when no runtime mapping is configured', async () => {
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.chdir(workspaceApiRoot);
    const app = Fastify();
    await app.register(projectsRoutes);
    await app.ready();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/projects/cwd' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().path, await realpath(workspaceRoot));
      assert.notEqual(response.json().path, await realpath(workspaceApiRoot));
    } finally {
      await app.close();
      process.chdir(runtimeApiRoot);
      process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
      process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    }
  });
});
