import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { projectsRoutes } from '../../dist/routes/projects.js';
import { mkdirRoute } from '../../dist/routes/projects-mkdir.js';

const headers = { 'x-cat-cafe-user': 'test-user' };

describe('Runtime directory browsing and creation', () => {
  let app;
  let root;
  let runtime;
  let workspace;
  let ordinary;
  let alias;
  let previousEnv;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'cat-cafe-runtime-browser-')));
    runtime = join(root, 'runtime');
    workspace = join(root, 'workspace');
    ordinary = join(root, 'ordinary-runtime');
    alias = join(ordinary, 'runtime-alias');
    await Promise.all([
      mkdir(join(runtime, 'shared', 'runtime-child'), { recursive: true }),
      mkdir(join(runtime, 'runtime-only'), { recursive: true }),
      mkdir(join(workspace, 'shared', 'workspace-child'), { recursive: true }),
      mkdir(ordinary),
    ]);
    await symlink(runtime, alias, process.platform === 'win32' ? 'junction' : 'dir');
    previousEnv = {
      CAT_CAFE_RUNTIME_ROOT: process.env.CAT_CAFE_RUNTIME_ROOT,
      CAT_CAFE_WORKSPACE_ROOT: process.env.CAT_CAFE_WORKSPACE_ROOT,
      PROJECT_ALLOWED_ROOTS: process.env.PROJECT_ALLOWED_ROOTS,
    };
    Object.assign(process.env, {
      CAT_CAFE_RUNTIME_ROOT: runtime,
      CAT_CAFE_WORKSPACE_ROOT: workspace,
      PROJECT_ALLOWED_ROOTS: root,
    });
    app = Fastify();
    await app.register(projectsRoutes);
    await app.register(mkdirRoute);
  });

  afterEach(async () => {
    await app.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function browse(path) {
    const res = await app.inject({ url: `/api/projects/browse?path=${encodeURIComponent(path)}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  }

  function create(parentPath, name) {
    return app.inject({ method: 'POST', url: '/api/projects/mkdir', headers, payload: { parentPath, name } });
  }

  it('lists the requested runtime root and descendants without needing workspace counterparts', async () => {
    for (const [request, current, children] of [
      [runtime, runtime, ['runtime-only', 'shared']],
      [join(alias, 'shared'), join(runtime, 'shared'), ['runtime-child']],
      [join(runtime, 'runtime-only'), join(runtime, 'runtime-only'), []],
      [ordinary, ordinary, []],
    ]) {
      const result = await browse(request);
      assert.equal(result.current, current);
      assert.deepEqual(
        result.entries.map((entry) => entry.name),
        children,
      );
      assert.equal(result.projectRestriction, request === ordinary ? undefined : 'runtime_read_only');
    }
  });

  it('refuses mkdir at the runtime root, a descendant and both alias boundaries without writing', async () => {
    const watched = [runtime, join(runtime, 'shared'), workspace, join(workspace, 'shared'), ordinary];
    const before = await Promise.all(watched.map((path) => readdir(path)));
    for (const [parent, name] of [
      [runtime, 'new'],
      [join(runtime, 'shared'), 'new'],
      [alias, 'new'],
      [ordinary, 'runtime-alias'],
    ]) {
      const res = await create(parent, name);
      assert.equal(res.statusCode, 403, res.body);
      assert.match(res.json().error, /runtime.*read.only/i);
    }
    assert.deepEqual(await Promise.all(watched.map((path) => readdir(path))), before);
    const created = await create(ordinary, 'new');
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(await realpath(join(ordinary, 'new')), created.json().createdPath);
  });

  it('preserves existing behavior when the configured roots resolve to the same directory', async () => {
    process.env.CAT_CAFE_WORKSPACE_ROOT = process.platform === 'win32' ? alias.toUpperCase() : alias;
    const result = await browse(alias);
    assert.equal(result.current, runtime);
    assert.equal(result.projectRestriction, undefined);
    const created = await create(alias, 'same-root-folder');
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(await realpath(join(runtime, 'same-root-folder')), created.json().createdPath);
  });

  it(
    'keeps distinct Windows directories read-only even when their names collate equally',
    {
      skip: process.platform !== 'win32',
    },
    async () => {
      const otherRoot = join(root, 'run\u200btime');
      await mkdir(otherRoot);
      process.env.CAT_CAFE_WORKSPACE_ROOT = otherRoot;
      assert.equal((await browse(runtime)).projectRestriction, 'runtime_read_only');
      assert.equal((await create(runtime, 'new')).statusCode, 403);
      assert.deepEqual(await readdir(otherRoot), []);
    },
  );

  it('protects descendants whose names start with two dots in denylist mode', async () => {
    delete process.env.PROJECT_ALLOWED_ROOTS;
    const descendant = join(runtime, '..private');
    await mkdir(descendant);
    assert.equal((await browse(descendant)).projectRestriction, 'runtime_read_only');
    assert.equal((await create(descendant, 'new')).statusCode, 403);
    assert.deepEqual(await readdir(descendant), []);
  });

  it('keeps authorized browsing available while refusing operations with unknown configuration', async () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = join(root, 'missing');
    assert.equal((await browse(ordinary)).projectRestriction, 'configuration_unknown');
    assert.equal((await create(ordinary, 'new')).statusCode, 403);
    assert.deepEqual(await readdir(ordinary), ['runtime-alias']);

    process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
    process.env.CAT_CAFE_WORKSPACE_ROOT = join(root, 'missing');
    assert.equal((await browse(runtime)).projectRestriction, 'configuration_unknown');
    assert.equal((await create(runtime, 'new')).statusCode, 403);
    assert.deepEqual((await readdir(runtime)).sort(), ['runtime-only', 'shared']);

    process.env.PROJECT_ALLOWED_ROOTS = ordinary;
    const denied = await app.inject({ url: `/api/projects/browse?path=${encodeURIComponent(alias)}`, headers });
    assert.equal(denied.statusCode, 403);
  });
});
