// @ts-check

/**
 * #1050 — MCP drift resolve accepts undefined projectPath (global scope).
 *
 * The "Sync All" button in the MCP management page calls resolveScope('sync', undefined)
 * for the global scope. The backend must fall back to STARTUP_REPO_ROOT instead of
 * returning 400 "Required: projectPath for MCP resolve".
 *
 * This test verifies the route-level behavior: sending MCP resolve without projectPath
 * should NOT return the old "Required: projectPath" error.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { unifiedDriftRoutes } = await import('../dist/routes/drift.js');
const { resolveStartupProjectRoot } = await import('../dist/utils/startup-root.js');

/** Auth headers that pass requireDriftWriteAccess. */
const AUTH_HEADERS = {
  'x-test-session-user': 'you',
  host: 'localhost:3004',
  origin: 'http://localhost:3003',
};
const ENV_KEYS = ['DEFAULT_OWNER_USER_ID', 'CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT', 'PROJECT_ALLOWED_ROOTS'];
let previousEnv;
let workspace;
/** @type {import('fastify').FastifyInstance} */
let app;

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'drift-global-resolve-')));
  // These routing tests need an authoritative global source, even when it is empty.
  // An absent/unreadable source must not be interpreted as an empty registry.
  await mkdir(join(workspace, '.cat-cafe'));
  await writeFile(join(workspace, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
  // Omitted projectPath must exercise the real global route, with writes confined to this fixture.
  Object.assign(process.env, {
    DEFAULT_OWNER_USER_ID: AUTH_HEADERS['x-test-session-user'],
    CAT_CAFE_RUNTIME_ROOT: resolveStartupProjectRoot(),
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    PROJECT_ALLOWED_ROOTS: workspace,
  });
  app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  await app.register(unifiedDriftRoutes);
  await app.ready();
});

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

describe('#1050 — MCP drift resolve without projectPath', () => {
  it('does not reject MCP resolve when projectPath is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().action, 'sync');
  });

  it('does not reject MCP resolve when projectPath is explicitly undefined', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync', projectPath: undefined },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().action, 'sync');
  });

  it('still rejects MCP resolve with invalid projectPath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: {
        type: 'mcp',
        action: 'sync',
        projectPath: '/nonexistent/path/that/should/fail/validation',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Invalid project path');
  });

  for (const state of ['absent', 'corrupt']) {
    it(`refuses an ${state} global source without changing project configuration`, async () => {
      const globalPath = join(workspace, '.cat-cafe/capabilities.json');
      if (state === 'absent') await rm(globalPath);
      else await writeFile(globalPath, '{ broken registry');
      const projectDirectory = join(workspace, 'consumer', '.cat-cafe');
      const projectPath = join(projectDirectory, 'capabilities.json');
      const original = JSON.stringify({
        version: 2,
        capabilities: [{ id: 'keep-local', type: 'mcp', enabled: true, source: 'external' }],
      });
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(projectPath, original);

      const res = await app.inject({
        method: 'POST',
        url: '/api/drift/resolve',
        headers: AUTH_HEADERS,
        payload: { type: 'mcp', action: 'sync' },
      });

      assert.equal(res.statusCode, 500, res.body);
      assert.match(res.json().message, /Cannot synchronize global capabilities/);
      assert.equal(await readFile(projectPath, 'utf8'), original);
      if (state === 'absent') await assert.rejects(readFile(globalPath), { code: 'ENOENT' });
      else assert.equal(await readFile(globalPath, 'utf8'), '{ broken registry');
    });
  }
});

describe('#1049 Phase D — conflictPolicy parameter validation', () => {
  it('accepts conflictPolicy use-global without error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync', conflictPolicy: 'use-global' },
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  it('accepts conflictPolicy keep-project without error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync', conflictPolicy: 'keep-project' },
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  it('rejects invalid conflictPolicy with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'mcp', action: 'sync', conflictPolicy: 'invalid-policy' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('conflictPolicy'));
  });

  it('accepts conflictPolicy for skill resolve (unified across both resolvers)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'skill', action: 'sync', conflictPolicy: 'keep-project' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().projectRoot, workspace);
  });

  it('rejects invalid conflictPolicy for skill resolve too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: { type: 'skill', action: 'sync', conflictPolicy: 'bad-value' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('conflictPolicy'));
  });
});
