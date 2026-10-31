import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  inheritFullyBlockedMcpCapabilitiesForNewCat,
  readCapabilitiesConfig,
  resolveServersForCat,
  writeCapabilitiesConfig,
} from '../src/config/capabilities/capability-orchestrator.js';
import {
  initializeFirstRunCapabilities,
  readImplicitStartupCapabilities,
} from '../src/config/capabilities/first-run-capabilities.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-mcp-first-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const binary = join(root, 'binary');
  await mkdir(join(project, '.cat-cafe'), { recursive: true });
  await mkdir(binary);
  return { root, project, binary, file: join(project, '.cat-cafe', 'capabilities.json') };
}

test('fresh host registry contains collaboration tools before a plugin adds its schedule', async (t) => {
  const { project, binary } = await fixture(t);
  assert.deepEqual(await initializeFirstRunCapabilities(project, binary, {}), { status: 'initialized' });
  const config = await readCapabilitiesConfig(project);
  assert.ok(config);
  // The plugin's existing mutation appends to the authoritative registry; no
  // capabilities settings GET is allowed to heal it before this assertion.
  config.capabilities.push({
    id: 'plugin:github:review-feedback',
    type: 'schedule',
    source: 'cat-cafe',
    enabled: true,
  });
  await writeCapabilitiesConfig(project, config);
  const existingIds = new Set<string>();
  for (const id of ['codex', 'claude-code', 'dsh', 'kimi', 'pi']) {
    await inheritFullyBlockedMcpCapabilitiesForNewCat(project, id, existingIds);
    existingIds.add(id);
  }
  const afterPlugin = await readCapabilitiesConfig(project);
  assert.ok(afterPlugin);
  const servers = resolveServersForCat(afterPlugin, 'codex');
  assert.equal(servers.length, 6);
  assert.ok(servers.every((server) => server.enabled));
  assert.ok(servers.some((server) => server.name === 'cat-cafe-collab'));
  assert.equal(existsSync(join(project, '.gemini', 'settings.json')), false);
  assert.equal(existsSync(join(project, '.codex', 'config.toml')), false);
});

test('an explicitly empty registry stays empty and byte-identical', async (t) => {
  const { root, project, binary, file } = await fixture(t);
  const bytes = '{ "version": 2, "capabilities": [] }\n';
  await writeFile(file, bytes);
  assert.deepEqual(await initializeFirstRunCapabilities(project, binary, {}), { status: 'preserved' });
  assert.equal(await readFile(file, 'utf8'), bytes);
  await writeFile(join(project, 'pnpm-workspace.yaml'), 'packages: []\n');
  const entry = new URL('../src/config/capabilities/startup-cli-config.ts', import.meta.url).href;
  const runner = join(root, 'verify-startup.mjs');
  await writeFile(
    runner,
    `const {regenerateStartupCliConfigs}=await import(${JSON.stringify(entry)}); await regenerateStartupCliConfigs(${JSON.stringify(project)});`,
  );
  const home = join(root, 'private-home');
  await mkdir(home);
  const child = spawnSync(process.execPath, ['--import', 'tsx', runner], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      CAT_CAFE_DATA_DIR: home,
      CAT_CAFE_WORKSPACE_ROOT: project,
      CAT_CAFE_RUNTIME_ROOT: binary,
      CAT_CAFE_DEPLOYMENT_ID: 'runtime',
      CAT_CAFE_SKIP_HOMEDIR_MIGRATION: '1',
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    await readFile(file, 'utf8'),
    bytes,
    'Subsequent startup regeneration must preserve an explicit empty registry',
  );
});

test('a legacy sparse registry is preserved for explicit owner repair rather than guessed permission migration', async (t) => {
  const { project, binary, file } = await fixture(t);
  const bytes = JSON.stringify({
    version: 1,
    capabilities: [{ id: 'plugin:github:review-feedback', type: 'schedule', source: 'cat-cafe', enabled: true }],
  });
  await writeFile(file, bytes);
  assert.deepEqual(await initializeFirstRunCapabilities(project, binary, {}), { status: 'preserved' });
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('disabled and blocked tools are not re-enabled by first-run initialization', async (t) => {
  const { project, binary, file } = await fixture(t);
  await initializeFirstRunCapabilities(project, binary, {});
  const config = await readCapabilitiesConfig(project);
  assert.ok(config);
  for (const capability of config.capabilities) {
    capability.enabled = false;
    capability.globalEnabled = false;
    capability.blockedCats = ['codex'];
  }
  await writeCapabilitiesConfig(project, config);
  const before = await readFile(file);
  await initializeFirstRunCapabilities(project, binary, {});
  assert.ok((await readFile(file)).equals(before));
  const retained = await readCapabilitiesConfig(project);
  assert.ok(retained);
  assert.ok(resolveServersForCat(retained, 'codex').every((server) => !server.enabled));
});

test('unreadable capability data stays unreadable without a permissive fallback', async (t) => {
  const { project, binary, file } = await fixture(t);
  for (const bytes of ['{broken', '{"version":3,"capabilities":[]}', '{"version":2,"capabilities":[null]}']) {
    await writeFile(file, bytes);
    assert.deepEqual(await initializeFirstRunCapabilities(project, binary, {}), { status: 'unreadable' });
    assert.equal(await readFile(file, 'utf8'), bytes);
  }
});

test('alpha cannot create a registry, directory, CLI config or lock file', async (t) => {
  const { root, binary } = await fixture(t);
  const project = join(root, 'must-not-exist');
  assert.deepEqual(await initializeFirstRunCapabilities(project, binary, { CAT_CAFE_DEPLOYMENT_ID: 'alpha' }), {
    status: 'read_only',
  });
  assert.equal(existsSync(project), false);
});

for (const [label, env] of [
  ['unlabelled linked worktree', {}],
  ['runtime-labelled linked worktree without a runtime root', { CAT_CAFE_DEPLOYMENT_ID: 'runtime' }],
] as const) {
  test(`${label} cannot bootstrap the shared registry or implicit plugin migration`, async (t) => {
    const { root, binary } = await fixture(t);
    const project = join(root, 'must-not-exist');
    await writeFile(join(binary, '.git'), 'gitdir: ../main/.git/worktrees/preview\n');
    assert.deepEqual(await initializeFirstRunCapabilities(project, binary, env), { status: 'read_only' });
    assert.equal(existsSync(project), false);
    await writeCapabilitiesConfig(project, {
      version: 2,
      capabilities: [{ id: 'existing', type: 'skill', source: 'external', enabled: true }],
    });
    assert.equal(await readImplicitStartupCapabilities(project, binary, env), null);
  });
}

test('a runtime label without a root preserves main-checkout and standalone first-run initialization', async (t) => {
  const { project, binary } = await fixture(t);
  for (const checkout of ['standalone', 'main']) {
    if (checkout === 'main') await mkdir(join(binary, '.git'));
    const target = join(project, checkout);
    assert.deepEqual(await initializeFirstRunCapabilities(target, binary, { CAT_CAFE_DEPLOYMENT_ID: 'runtime' }), {
      status: 'initialized',
    });
    assert.equal((await readCapabilitiesConfig(target))?.capabilities.length, 6);
  }
});

test('concurrent initialization shares the existing capability lock and creates only six entries', async (t) => {
  const { project, binary } = await fixture(t);
  const results = await Promise.all([
    initializeFirstRunCapabilities(project, binary, {}),
    initializeFirstRunCapabilities(project, binary, {}),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['initialized', 'preserved']);
  const config = await readCapabilitiesConfig(project);
  assert.ok(config);
  assert.equal(new Set(config.capabilities.map((capability) => capability.id)).size, 6);
});

test('subsequent implicit plugin migration cannot treat empty, unreadable or alpha registries as bootstrap authority', async (t) => {
  const { project, binary, file } = await fixture(t);
  assert.equal(await readImplicitStartupCapabilities(project, binary, {}), null);
  for (const bytes of ['{"version":2,"capabilities":[]}', '{broken']) {
    await writeFile(file, bytes);
    assert.equal(await readImplicitStartupCapabilities(project, binary, {}), null);
    assert.equal(await readFile(file, 'utf8'), bytes);
  }
  await rm(file);
  await initializeFirstRunCapabilities(project, binary, {});
  assert.equal((await readImplicitStartupCapabilities(project, binary, {}))?.capabilities.length, 6);
  assert.equal(await readImplicitStartupCapabilities(project, binary, { CAT_CAFE_DEPLOYMENT_ID: 'alpha' }), null);
});
