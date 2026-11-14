import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { projectSetupRoute } from '../../dist/routes/projects-setup.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };

function buildApp(catCafeRoot, options = {}) {
  const app = Fastify();
  app.register(projectSetupRoute, { catCafeRoot, ...options });
  return app;
}

describe('POST /api/projects/setup', () => {
  let app;
  let testRoot;
  /** Isolated catCafeRoot so tests don't pollute the real governance registry (#926) */
  let fakeCatCafeRoot;

  beforeEach(async () => {
    fakeCatCafeRoot = join(tmpdir(), `catcafe-root-${randomUUID()}`);
    await mkdir(fakeCatCafeRoot, { recursive: true });
    app = buildApp(fakeCatCafeRoot);
    testRoot = join(tmpdir(), `setup-test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await app.close();
    await rm(testRoot, { recursive: true, force: true });
    await rm(fakeCatCafeRoot, { recursive: true, force: true });
  });

  it('persists the owner through the real setup bootstrap bridge', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { ExpeditionBootstrapService } = await import('../../dist/domains/memory/ExpeditionBootstrapService.js');
    const { ensureProjectCollection } = await import('../../dist/domains/memory/bootstrap-collection-bridge.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'setup-bridge-data-'));
    const catalog = new LibraryCatalog();
    const stores = new Map();
    const stateManager = {
      shouldBootstrap: () => true,
      startBuilding: () => {},
      markReady: () => {},
      getState: () => ({}),
    };
    const service = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: (projectPath, ownerUserId) =>
        ensureProjectCollection(projectPath, catalog, stores, dataDir, ownerUserId),
      getFingerprint: () => 'setup-real-bridge',
    });
    const ownerApp = buildApp(fakeCatCafeRoot, {
      memoryBootstrapService: service,
      socketManager: { emitToUser: () => {} },
    });
    try {
      const res = await ownerApp.inject({
        method: 'POST',
        url: '/api/projects/setup',
        headers: HEADERS,
        payload: { projectPath: testRoot, mode: 'skip' },
      });
      assert.equal(res.statusCode, 200);
      for (let i = 0; i < 60 && catalog.list().length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const manifests = catalog.list();
      assert.equal(manifests.length, 1);
      assert.equal(manifests[0].ownerUserId, 'test-user');
      assert.equal(manifests[0].sensitivity, 'private');
      for (const store of stores.values()) store.close();
    } finally {
      await ownerApp.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('passes the authenticated identity into the setup-triggered memory bootstrap', async () => {
    const { ExpeditionBootstrapService } = await import('../../dist/domains/memory/ExpeditionBootstrapService.js');
    const seenOwners = [];
    const stateManager = {
      shouldBootstrap: () => true,
      startBuilding: () => {},
      markReady: () => {},
      getState: () => ({}),
    };
    const service = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async (_projectPath, ownerUserId) => {
        seenOwners.push(ownerUserId);
        return { docsIndexed: 1, durationMs: 1 };
      },
      getFingerprint: () => 'setup-owner-test',
    });
    const ownerApp = buildApp(fakeCatCafeRoot, {
      memoryBootstrapService: service,
      socketManager: { emitToUser: () => {} },
    });
    try {
      const res = await ownerApp.inject({
        method: 'POST',
        url: '/api/projects/setup',
        headers: HEADERS,
        payload: { projectPath: testRoot, mode: 'skip' },
      });
      assert.equal(res.statusCode, 200);
      for (let i = 0; i < 30 && seenOwners.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(seenOwners, ['test-user']);
    } finally {
      await ownerApp.close();
    }
  });

  it('mode=skip is a zero-write acknowledgement', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: testRoot, mode: 'skip' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.ok, true);
    assert.equal('governanceReport' in body, false);
    assert.deepStrictEqual(await readdir(testRoot, { recursive: true }), []);
  });

  it('mode=init runs git init without governance writes', async () => {
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

  it('mode=clone returns network_error on unreachable HTTPS remote', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: {
        projectPath: testRoot,
        mode: 'clone',
        gitCloneUrl: 'https://127.0.0.1:1/nonexistent.git',
      },
    });
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.payload);
    assert.equal(body.errorKind, 'network_error');
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

  it('default setup does not write a governance registry in runtime or persistent workspace', async () => {
    const previousCwd = process.cwd();
    const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    const previousWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const runtimeRoot = join(tmpdir(), `catcafe-runtime-${randomUUID()}`);
    const workspaceRoot = join(tmpdir(), `catcafe-workspace-${randomUUID()}`);
    await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(workspaceRoot, { recursive: true })]);
    await writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    process.chdir(runtimeRoot);
    const defaultApp = buildApp(undefined);

    try {
      const res = await defaultApp.inject({
        method: 'POST',
        url: '/api/projects/setup',
        headers: HEADERS,
        payload: { projectPath: testRoot, mode: 'skip' },
      });

      assert.equal(res.statusCode, 200, res.payload);
      await assert.rejects(() => stat(join(runtimeRoot, '.cat-cafe', 'governance-registry.json')), /ENOENT/);
      await assert.rejects(() => stat(join(workspaceRoot, '.cat-cafe', 'governance-registry.json')), /ENOENT/);
    } finally {
      await defaultApp.close();
      process.chdir(previousCwd);
      if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspaceRoot;
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects Clowder AI descendants as external governance targets', async () => {
    const internalPackage = join(fakeCatCafeRoot, 'packages', 'api');
    await mkdir(internalPackage, { recursive: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/setup',
      headers: HEADERS,
      payload: { projectPath: internalPackage, mode: 'skip' },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /external project/i);
    assert.deepEqual(await readdir(internalPackage), [], 'rejected self-bootstrap must leave the directory untouched');
  });

  it('rejects remote/proxy unpaired session cookies but accepts a local session', async () => {
    const { sessionAuthPlugin, sessionRoute } = await import('../../dist/infrastructure/session-auth.js');
    const bootstrapCalls = [];
    const service = {
      bootstrap: async (_projectPath, options) => {
        bootstrapCalls.push(options);
        return { status: 'ready' };
      },
    };
    const sessionApp = Fastify();
    await sessionApp.register(cookie);
    await sessionApp.register(sessionAuthPlugin);
    await sessionApp.register(sessionRoute);
    await sessionApp.register(projectSetupRoute, {
      catCafeRoot: fakeCatCafeRoot,
      memoryBootstrapService: service,
      socketManager: { emitToUser: () => {} },
    });
    await sessionApp.ready();
    try {
      const remoteSession = await sessionApp.inject({
        method: 'GET',
        url: '/api/session',
        remoteAddress: '192.0.2.10',
      });
      const remoteCookie = remoteSession.headers['set-cookie']?.split(';')[0];
      assert.ok(remoteCookie, 'remote session route mints a cookie');
      for (const extraHeaders of [{}, { 'x-forwarded-for': '192.0.2.10' }]) {
        const res = await sessionApp.inject({
          method: 'POST',
          url: '/api/projects/setup',
          remoteAddress: '192.0.2.10',
          headers: { cookie: remoteCookie, 'content-type': 'application/json', ...extraHeaders },
          payload: { projectPath: testRoot, mode: 'skip' },
        });
        assert.equal(res.statusCode, 401, JSON.stringify(extraHeaders));
      }
      assert.equal(bootstrapCalls.length, 0);

      const localSession = await sessionApp.inject({ method: 'GET', url: '/api/session' });
      const localCookie = localSession.headers['set-cookie']?.split(';')[0];
      assert.ok(localCookie, 'local session route mints a cookie');
      const localSetup = await sessionApp.inject({
        method: 'POST',
        url: '/api/projects/setup',
        headers: { cookie: localCookie, 'content-type': 'application/json' },
        payload: { projectPath: testRoot, mode: 'skip' },
      });
      assert.equal(localSetup.statusCode, 200);
      for (let i = 0; i < 30 && bootstrapCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(bootstrapCalls.length, 1);
      assert.equal(bootstrapCalls[0].ownerUserId, 'default-user');
    } finally {
      await sessionApp.close();
    }
  });

  it('rejects remote and proxy-forwarded setup before any owner binding', async () => {
    for (const request of [
      { remoteAddress: '192.0.2.10' },
      { headers: { ...HEADERS, 'x-forwarded-for': '192.0.2.10' } },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/setup',
        headers: HEADERS,
        ...request,
        payload: { projectPath: testRoot, mode: 'skip' },
      });
      assert.equal(res.statusCode, 401, JSON.stringify(request));
    }
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
