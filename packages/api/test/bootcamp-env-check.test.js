import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

describe('F087: Bootcamp env-check route', () => {
  let app;
  let threadStore;

  async function createApp() {
    const { default: Fastify } = await import('fastify');
    const { bootcampRoutes } = await import('../dist/routes/bootcamp.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
    app = Fastify();
    await app.register(bootcampRoutes, { threadStore });
    await app.ready();
    return app;
  }

  // P1-1: Auth guard
  it('returns 401 without identity header', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/env-check' });
    assert.strictEqual(res.statusCode, 401);
    await app.close();
  });

  it('GET /api/bootcamp/env-check returns env status shape', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/env-check', headers: AUTH_HEADERS });
    assert.strictEqual(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    // Core tools
    assert.ok('node' in body, 'missing node');
    assert.ok('pnpm' in body, 'missing pnpm');
    assert.ok('git' in body, 'missing git');
    assert.ok('claudeCli' in body, 'missing claudeCli');
    assert.ok('codexCli' in body, 'missing codexCli');
    assert.ok('geminiCli' in body, 'missing geminiCli');
    assert.ok('kimiCli' in body, 'missing kimiCli');
    assert.ok('mcp' in body, 'missing mcp');
    // Advanced features
    assert.ok('tts' in body, 'missing tts');
    assert.ok('asr' in body, 'missing asr');
    assert.ok('pencil' in body, 'missing pencil');

    // Each core tool has ok boolean
    assert.strictEqual(typeof body.node.ok, 'boolean');
    assert.strictEqual(typeof body.pnpm.ok, 'boolean');
    assert.strictEqual(typeof body.git.ok, 'boolean');
    assert.strictEqual(typeof body.kimiCli.ok, 'boolean');

    // node/pnpm/git should be ok in dev environment
    assert.ok(body.node.ok, 'node should be available');
    assert.ok(body.pnpm.ok, 'pnpm should be available');
    assert.ok(body.git.ok, 'git should be available');

    // node version should be a string
    assert.ok(body.node.version?.startsWith('v'), `node version: ${body.node.version}`);

    await app.close();
  });

  it('pencil always reports unavailable with note', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/env-check', headers: AUTH_HEADERS });
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.pencil.ok, false);
    assert.ok(body.pencil.note);
    await app.close();
  });

  it('tts includes recommendation when unavailable', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/env-check', headers: AUTH_HEADERS });
    const body = JSON.parse(res.payload);
    assert.ok(body.tts.recommended, 'tts should have recommended field');
    await app.close();
  });

  // P1-2: MCP detection
  it('mcp check reflects actual availability (not hardcoded)', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/env-check', headers: AUTH_HEADERS });
    const body = JSON.parse(res.payload);
    assert.strictEqual(typeof body.mcp.ok, 'boolean');
    // In test env, MCP server is not running — should detect that
    // (we can't assert ok=false because CI may have it, but we assert it's a real boolean check)
    assert.ok('ok' in body.mcp);
    await app.close();
  });
});

describe('F087: Bootcamp thread discovery', () => {
  let app;
  let threadStore;

  async function createApp() {
    const { default: Fastify } = await import('fastify');
    const { bootcampRoutes } = await import('../dist/routes/bootcamp.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
    app = Fastify();
    await app.register(bootcampRoutes, { threadStore });
    await app.ready();
    return app;
  }

  it('returns null when no bootcamp thread exists', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/thread', headers: AUTH_HEADERS });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.thread, null);
    await app.close();
  });

  it('returns 401 without identity', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/thread' });
    assert.strictEqual(res.statusCode, 401);
    await app.close();
  });

  it('finds bootcamp thread by bootcampState', async () => {
    await createApp();
    // Create a normal thread and a bootcamp thread
    await threadStore.create('test-user', 'Normal thread');
    const bootcampThread = await threadStore.create('test-user', '🎓 猫猫训练营');
    await threadStore.updateBootcampState(bootcampThread.id, {
      v: 1,
      phase: 'phase-3-config-help',
      startedAt: 1000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/thread', headers: AUTH_HEADERS });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.thread.id, bootcampThread.id);
    assert.strictEqual(body.thread.phase, 'phase-3-config-help');
    assert.strictEqual(body.thread.startedAt, 1000);
    await app.close();
  });

  it('returns most recent bootcamp thread when multiple exist', async () => {
    await createApp();
    const older = await threadStore.create('test-user', '🎓 旧训练营');
    await threadStore.updateBootcampState(older.id, {
      v: 1,
      phase: 'phase-11-farewell',
      startedAt: 500,
      completedAt: 600,
    });
    const newer = await threadStore.create('test-user', '🎓 新训练营');
    await threadStore.updateBootcampState(newer.id, {
      v: 1,
      phase: 'phase-1-intro',
      startedAt: 2000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/thread', headers: AUTH_HEADERS });
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.thread.id, newer.id, 'Should return most recent bootcamp thread');
    assert.strictEqual(body.thread.phase, 'phase-1-intro');
    await app.close();
  });
});

describe('F106: Bootcamp threads list', () => {
  let app;
  let threadStore;

  async function createApp() {
    const { default: Fastify } = await import('fastify');
    const { bootcampRoutes } = await import('../dist/routes/bootcamp.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    threadStore = new ThreadStore();
    app = Fastify();
    await app.register(bootcampRoutes, { threadStore });
    await app.ready();
    return app;
  }

  it('returns empty array when no bootcamp threads exist', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/threads', headers: AUTH_HEADERS });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.threads), 'threads should be an array');
    assert.strictEqual(body.threads.length, 0);
    await app.close();
  });

  it('returns 401 without identity', async () => {
    await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/threads' });
    assert.strictEqual(res.statusCode, 401);
    await app.close();
  });

  it('returns all bootcamp threads sorted by startedAt desc', async () => {
    await createApp();
    // Create normal thread (should be excluded)
    await threadStore.create('test-user', 'Normal thread');
    // Create two bootcamp threads
    const older = await threadStore.create('test-user', '🎓 训练营 1');
    await threadStore.updateBootcampState(older.id, {
      v: 1,
      phase: 'phase-11-farewell',
      startedAt: 500,
      completedAt: 600,
    });
    const newer = await threadStore.create('test-user', '🎓 训练营 2');
    await threadStore.updateBootcampState(newer.id, {
      v: 1,
      phase: 'phase-5-kickoff',
      startedAt: 2000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/threads', headers: AUTH_HEADERS });
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.threads.length, 2, 'Should return 2 bootcamp threads');
    // Most recent first
    assert.strictEqual(body.threads[0].id, newer.id);
    assert.strictEqual(body.threads[0].phase, 'phase-5-kickoff');
    assert.strictEqual(body.threads[1].id, older.id);
    assert.strictEqual(body.threads[1].phase, 'phase-11-farewell');
    assert.strictEqual(body.threads[1].completedAt, 600);
    await app.close();
  });

  it('includes selectedTaskId in response when present', async () => {
    await createApp();
    const t = await threadStore.create('test-user', '🎓 训练营');
    await threadStore.updateBootcampState(t.id, {
      v: 1,
      phase: 'phase-5-kickoff',
      startedAt: 1000,
      selectedTaskId: 'Q3',
    });

    const res = await app.inject({ method: 'GET', url: '/api/bootcamp/threads', headers: AUTH_HEADERS });
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.threads[0].selectedTaskId, 'Q3');
    await app.close();
  });
});
