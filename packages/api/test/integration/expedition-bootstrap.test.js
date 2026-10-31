import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ExpeditionBootstrapService } from '../../dist/domains/memory/ExpeditionBootstrapService.js';
import { IndexStateManager } from '../../dist/domains/memory/IndexStateManager.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { projectsBootstrapRoutes } from '../../dist/routes/projects-bootstrap.js';

function createTempProject(name = 'test-project') {
  const root = mkdtempSync(join(tmpdir(), `f152-e2e-${name}-`));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'docs', 'README.md'), `# ${name}\nProject docs.`);
  writeFileSync(join(root, 'src', 'index.ts'), 'export const main = true;');
  return root;
}

describe('Expedition Bootstrap E2E', () => {
  let db;
  let stateManager;
  let bootstrapService;
  let tmpRoot;
  let app;
  let socketEvents;

  beforeEach(async () => {
    db = new Database(':memory:');
    applyMigrations(db);
    stateManager = new IndexStateManager(db);
    tmpRoot = createTempProject();

    bootstrapService = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 3, durationMs: 50 }),
      getFingerprint: () => 'e2e-commit:1.0:full',
    });

    socketEvents = [];
    const mockSocketManager = {
      emitToUser(_userId, event, data) {
        socketEvents.push({ event, data });
      },
    };

    app = Fastify();
    await app.register(projectsBootstrapRoutes, { stateManager, bootstrapService, socketManager: mockSocketManager });
    await app.ready();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('full flow: bootstrap → progress → ready → query state', async () => {
    // Step 1: Check initial state — missing
    let res = await app.inject({
      method: 'GET',
      url: '/api/projects/index-state',
      query: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'e2e-user' },
    });
    assert.equal(res.json().status, 'missing');

    // Step 2: Start bootstrap
    res = await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'e2e-user' },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().started, true);

    // Step 3: Wait for async bootstrap to complete
    await new Promise((r) => setTimeout(r, 200));

    // Step 4: Verify state is ready
    res = await app.inject({
      method: 'GET',
      url: '/api/projects/index-state',
      query: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'e2e-user' },
    });
    const state = res.json();
    assert.equal(state.status, 'ready');
    assert.equal(state.docs_indexed, 3);
    assert.ok(state.summary_json);

    // Step 5: Verify summary structure
    const summary = JSON.parse(state.summary_json);
    assert.ok(summary.techStack.includes('node'));
    assert.ok(summary.techStack.includes('typescript'));
    assert.ok(summary.dirStructure.includes('src'));
    assert.ok(summary.dirStructure.includes('docs'));
    assert.ok(summary.docsList.length > 0);

    // Step 6: Verify WebSocket events were emitted
    const progressEvents = socketEvents.filter((e) => e.event === 'index:progress');
    assert.ok(progressEvents.length >= 1, 'should have emitted progress events');
    const completeEvents = socketEvents.filter((e) => e.event === 'index:complete');
    assert.equal(completeEvents.length, 1, 'should have emitted exactly one complete event');
  });

  it('idempotent: second bootstrap with same fingerprint is skipped', async () => {
    // First bootstrap
    await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    await new Promise((r) => setTimeout(r, 200));

    const countBefore = socketEvents.length;

    // Second bootstrap — same fingerprint
    await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    await new Promise((r) => setTimeout(r, 100));

    // No new complete events
    const newComplete = socketEvents.slice(countBefore).filter((e) => e.event === 'index:complete');
    assert.equal(newComplete.length, 0, 'should not re-bootstrap when fingerprint matches');
  });

  it('snooze prevents bootstrap trigger', async () => {
    // Snooze first
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap/snooze',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().snoozedUntil);

    // Try bootstrap — should not trigger
    const countBefore = socketEvents.length;
    await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    await new Promise((r) => setTimeout(r, 100));

    const newEvents = socketEvents.slice(countBefore);
    assert.equal(newEvents.length, 0, 'should not bootstrap when snoozed');
  });

  it('failed state allows retry', async () => {
    // Create service that fails
    const failingService = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => {
        throw new Error('disk error');
      },
      getFingerprint: () => 'fail:1:full',
    });

    const failApp = Fastify();
    await failApp.register(projectsBootstrapRoutes, {
      stateManager,
      bootstrapService: failingService,
      socketManager: { emitToUser() {} },
    });
    await failApp.ready();

    // First attempt — fails
    await failApp.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    await new Promise((r) => setTimeout(r, 100));

    let res = await failApp.inject({
      method: 'GET',
      url: '/api/projects/index-state',
      query: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    assert.equal(res.json().status, 'failed');
    assert.equal(res.json().error_message, 'disk error');

    // Retry with working service — should succeed
    await app.inject({
      method: 'POST',
      url: '/api/projects/bootstrap',
      payload: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    await new Promise((r) => setTimeout(r, 200));

    res = await app.inject({
      method: 'GET',
      url: '/api/projects/index-state',
      query: { projectPath: tmpRoot },
      headers: { 'x-cat-cafe-user': 'u' },
    });
    assert.equal(res.json().status, 'ready');
  });
});
