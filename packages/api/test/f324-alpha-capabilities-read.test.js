import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';

const AUTH = { 'x-cat-cafe-user': 'test-user' };

async function fixture(deployment, run) {
  assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'run through scripts/with-test-home.sh');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'f324-alpha-read-')));
  const main = join(dir, 'main');
  const runtime = join(dir, 'alpha');
  const external = join(dir, 'external');
  const agy = join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
  const keys = [
    'CAT_CAFE_DEPLOYMENT_ID',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
    'PROJECT_ALLOWED_ROOTS',
    'DEFAULT_OWNER_USER_ID',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const cwd = process.cwd();
  const oldAgy = await readFile(agy).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  const config = JSON.stringify({
    version: 2,
    capabilities: [
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['/existing-owner/memory.js'] },
      },
      { id: 'stale-skill', type: 'skill', enabled: true, source: 'cat-cafe' },
    ],
  });
  const sentinel = JSON.stringify({ mcpServers: { 'owner-service': { command: 'echo', args: ['owner'] } } });
  let app;
  try {
    for (const root of [main, runtime, external]) {
      await mkdir(join(root, '.cat-cafe'), { recursive: true });
      await mkdir(join(root, '.gemini'), { recursive: true });
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
      await writeFile(join(root, '.cat-cafe', 'capabilities.json'), config);
      await writeFile(join(root, '.gemini', 'settings.json'), sentinel);
    }
    await mkdir(join(homedir(), '.gemini', 'antigravity'), { recursive: true });
    await writeFile(agy, sentinel);
    Object.assign(process.env, {
      CAT_CAFE_DEPLOYMENT_ID: deployment,
      CAT_CAFE_RUNTIME_ROOT: runtime,
      CAT_CAFE_WORKSPACE_ROOT: main,
      PROJECT_ALLOWED_ROOTS: dir,
      DEFAULT_OWNER_USER_ID: 'you',
    });
    process.chdir(runtime);
    const { capabilitiesRoutes } = await import(`../dist/routes/capabilities.js?f324=${dir}`);
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-session-user'] === 'you') request.sessionUserId = 'you';
    });
    await app.register(capabilitiesRoutes);
    await app.ready();
    const paths = (root) => [join(root, '.cat-cafe', 'capabilities.json'), join(root, '.gemini', 'settings.json'), agy];
    await run({ app, main, external, paths });
  } finally {
    await app?.close();
    process.chdir(cwd);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (oldAgy === null) await rm(agy, { force: true });
    else await writeFile(agy, oldAgy);
    await rm(dir, { recursive: true, force: true });
  }
}

async function bytes(paths) {
  return Promise.all(paths.map((path) => readFile(path)));
}

async function unchanged(paths, before) {
  const after = await bytes(paths);
  assert.deepEqual(
    after.map((value, index) => value.equals(before[index])),
    before.map(() => true),
  );
}

test('F324 Alpha authenticated capabilities GET reads the mapped workspace without implicit writes', async () => {
  await fixture('alpha', async ({ app, main, paths }) => {
    const files = paths(main);
    const before = await bytes(files);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().items.some((item) => item.id === 'cat-cafe-memory'));
    await unchanged(files, before);
  });
});

test('F324 Alpha external-project GET preserves project, main and HOME configurations', async () => {
  await fixture('alpha', async ({ app, main, external, paths }) => {
    const files = [...paths(external), ...paths(main).slice(0, 2)];
    const before = await bytes(files);
    const res = await app.inject({
      method: 'GET',
      url: `/api/capabilities?projectPath=${encodeURIComponent(external)}`,
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200);
    await unchanged(files, before);
  });
});

test('F324 Alpha missing canonical config stays absent rather than bootstrapping on GET', async () => {
  await fixture('alpha', async ({ app, main, paths }) => {
    const [canonical, ...files] = paths(main);
    await rm(canonical);
    const before = await bytes(files);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: AUTH });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, 'config_missing');
    await assert.rejects(readFile(canonical), { code: 'ENOENT' });
    await unchanged(files, before);
  });
});

test('F324 runtime capabilities GET still heals and generates persistent configuration', async () => {
  await fixture('runtime', async ({ app, main, paths }) => {
    const files = paths(main);
    const before = await bytes(files);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const after = await bytes(files);
    assert.deepEqual(
      after.map((value, index) => value.equals(before[index])),
      [false, false, false],
    );
    assert.ok(JSON.parse(after[1]).mcpServers['cat-cafe-memory']);
  });
});

test('F324 Alpha explicit owner PATCH keeps its existing persistence contract', async () => {
  await fixture('alpha', async ({ app, main, paths }) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities',
      headers: { 'x-test-session-user': 'you', host: 'localhost:3012', origin: 'http://localhost:3011' },
      payload: {
        capabilityId: 'cat-cafe-memory',
        capabilityType: 'mcp',
        scope: 'global',
        enabled: false,
      },
    });
    assert.equal(res.statusCode, 200);
    const config = JSON.parse(await readFile(paths(main)[0], 'utf8'));
    assert.equal(config.capabilities.find((cap) => cap.id === 'cat-cafe-memory').globalEnabled, false);
  });
});
