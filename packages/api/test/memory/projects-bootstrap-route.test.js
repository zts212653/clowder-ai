import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { IndexStateManager } from '../../dist/domains/memory/IndexStateManager.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { projectsBootstrapRoutes } from '../../dist/routes/projects-bootstrap.js';

describe('projects-bootstrap routes', () => {
  let app;
  let db;
  let stateManager;
  let bootstrapCalls;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = realpathSync(await mkdtemp(join(tmpdir(), 'bootstrap-test-')));
    // Create subdirs that validateProjectPath can stat
    for (const name of ['unknown', 'ready', 'new-proj', 'snooze-me', 'foo']) {
      mkdirSync(join(tmpDir, name));
    }

    db = new Database(':memory:');
    applyMigrations(db);
    stateManager = new IndexStateManager(db);
    bootstrapCalls = [];

    const mockBootstrapService = {
      async bootstrap(projectPath, options) {
        bootstrapCalls.push({ projectPath, options });
        return { status: 'ready', docsIndexed: 5, durationMs: 100 };
      },
    };
    const mockSocketManager = {
      emitToUser(_userId, _event, _data) {},
    };

    app = Fastify();
    await app.register(projectsBootstrapRoutes, {
      stateManager,
      bootstrapService: mockBootstrapService,
      socketManager: mockSocketManager,
      getFingerprint: () => 'current-sha',
    });
    await app.ready();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  describe('GET /api/projects/index-state', () => {
    it('returns missing for unknown project', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/index-state',
        query: { projectPath: join(tmpDir, 'unknown') },
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, 'missing');
    });

    it('returns ready for bootstrapped project', async () => {
      const p = join(tmpDir, 'ready');
      stateManager.startBuilding(p, 'current-sha');
      stateManager.markReady(p, 10, '{"projectName":"ready"}');
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/index-state',
        query: { projectPath: p },
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.json().status, 'ready');
    });

    it('returns stale when server-side fingerprint differs from stored', async () => {
      const p = join(tmpDir, 'ready');
      stateManager.startBuilding(p, 'old-fp');
      stateManager.markReady(p, 10, '{"projectName":"ready"}');
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/index-state',
        query: { projectPath: p },
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.json().status, 'stale');
    });

    it('returns 400 without projectPath', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/index-state',
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 401 without identity', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/index-state',
        query: { projectPath: join(tmpDir, 'foo') },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /api/projects/bootstrap', () => {
    it('returns 202 and starts bootstrap', async () => {
      const p = join(tmpDir, 'new-proj');
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/bootstrap',
        payload: { projectPath: p },
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 202);
      assert.equal(res.json().started, true);
      // wait for async bootstrap
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(bootstrapCalls.length, 1);
      assert.equal(bootstrapCalls[0].projectPath, p);
    });

    it('returns 400 without projectPath', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/bootstrap',
        payload: {},
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 401 without identity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/bootstrap',
        payload: { projectPath: join(tmpDir, 'foo') },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /api/projects/bootstrap/snooze', () => {
    it('snoozes and returns snoozedUntil', async () => {
      const p = join(tmpDir, 'snooze-me');
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/bootstrap/snooze',
        payload: { projectPath: p },
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().snoozedUntil);
      assert.equal(stateManager.isSnoozed(p), true);
    });

    it('returns 400 without projectPath', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/bootstrap/snooze',
        payload: {},
        headers: { 'x-cat-cafe-user': 'test-user' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 401 without identity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/bootstrap/snooze',
        payload: { projectPath: join(tmpDir, 'foo') },
      });
      assert.equal(res.statusCode, 401);
    });
  });
});
