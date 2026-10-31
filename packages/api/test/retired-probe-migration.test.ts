import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'smol-toml';
import {
  migrateAndPersistCapabilities,
  resolveServersForCat,
  writeCapabilitiesConfig,
} from '../src/config/capabilities/capability-orchestrator.js';
import { readInvocationMcpConfig } from '../src/config/capabilities/invoke-mcp-config.js';
import { readCodexMcpConfig } from '../src/config/capabilities/mcp-config-adapters.js';
import {
  migrateStartupCodexMcpConfig,
  regenerateStartupCliConfigs,
} from '../src/config/capabilities/startup-cli-config.js';

for (const [preview, canonical, codexEnabled] of [
  [false, false, false],
  [false, true, false],
  [true, false, false],
  [true, true, false],
  [false, true, true],
  [true, true, true],
])
  test(`startup retires only fingerprinted F193 probes with byte-exact backups; preview=${preview}; canonical=${canonical}; codexEnabled=${codexEnabled}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f333-retired-probes-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const directory of ['.git', '.cat-cafe', '.codex']) await mkdir(join(root, directory));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
    const originalApiCwd: string = JSON.parse(code.slice(code.lastIndexOf('process.chdir(') + 14, -2));
    const known = { command: 'node', args: ['--input-type=module', '--eval', code] };
    const off = { command: 'echo', args: ['ok'] };
    const custom = { command: 'node', args: ['user-owned-probe.js'], env: { KEEP_USER_FIELD: 'original' } };
    const customizedInline = { ...known, cwd: '/user-owned', env: { CUSTOM: 'keep' } };
    const disabledOff = { ...off, enabled: false };
    const enabledOff = { ...off, enabled: true };
    const foreignEnabledOff = codexEnabled ? { 'probe-off': enabledOff } : {};
    const servers = {
      'probe-connected': { ...known, ...(canonical ? { workingDir: originalApiCwd } : {}) },
      'probe-env': {
        ...known,
        ...(canonical ? { workingDir: originalApiCwd, env: { OPENAI_API_KEY: 'test-key' } } : {}),
      },
      'probe-off': off,
      'secret-mcp': custom,
      other: custom,
    };
    const capability = (id: string, mcpServer: typeof known) => ({
      id,
      type: 'mcp',
      source: 'external',
      enabled: true,
      ...(canonical ? { globalEnabled: true, blockedCats: [] } : {}),
      mcpServer,
    });
    const cliServers = Object.fromEntries(
      Object.entries(servers).map(([id, server]) => {
        const { workingDir, ...launch } = server as typeof server & { workingDir?: string };
        return [id, { ...launch, ...(workingDir ? { cwd: workingDir } : {}) }];
      }),
    );
    const original = {
      '.cat-cafe/capabilities.json': JSON.stringify({
        version: 2,
        customField: 'preserve',
        capabilities: [
          ...Object.entries(servers).map(([id, server]) => capability(id, server)),
          { ...capability('probe-connected', known), source: 'plugin', pluginId: 'dev.user-probe' },
          { ...capability('probe-off', off), blockedCats: ['custom-cat'] },
          ...Object.entries(foreignEnabledOff).map(([id, launch]) => capability(id, launch)),
        ],
      }),
      '.mcp.json': JSON.stringify({
        mcpServers: {
          ...cliServers,
          'probe-env': customizedInline,
          ...foreignEnabledOff,
        },
        custom: { retained: true },
      }),
      '.codex/config.toml': stringify({
        model: 'preserve-model',
        mcp_servers: codexEnabled
          ? Object.fromEntries(Object.entries(cliServers).map(([id, launch]) => [id, { ...launch, enabled: true }]))
          : { ...cliServers, 'probe-off': disabledOff },
      }),
    };
    for (const [file, bytes] of Object.entries(original)) await writeFile(join(root, file), bytes);
    if (codexEnabled) {
      const descriptors = await readCodexMcpConfig(join(root, '.codex/config.toml'));
      assert.ok(descriptors.every((entry) => entry.enabled === true));
      assert.ok(
        ['probe-connected', 'probe-env', 'probe-off'].every((name) => descriptors.some((entry) => entry.name === name)),
      );
    }
    const env = {
      CAT_CAFE_DEPLOYMENT_ID: preview ? 'alpha-fixture' : 'runtime',
      CAT_CAFE_RUNTIME_ROOT: root,
      CAT_CAFE_CONFIG_ROOT: root,
      CAT_CAFE_WORKSPACE_ROOT: root,
    };
    const removed = await migrateStartupCodexMcpConfig(root, env);
    if (preview) {
      assert.deepEqual(removed, []);
      for (const [file, bytes] of Object.entries(original))
        assert.equal(await readFile(join(root, file), 'utf8'), bytes);
      return;
    }
    assert.deepEqual(new Set(removed), new Set(['probe-connected', 'probe-env', 'probe-off']));
    const caps = JSON.parse(await readFile(join(root, '.cat-cafe/capabilities.json'), 'utf8'));
    assert.equal(caps.customField, 'preserve');
    assert.deepEqual(
      caps.capabilities.map((entry: { id: string }) => entry.id),
      ['secret-mcp', 'other', 'probe-connected', 'probe-off', ...Object.keys(foreignEnabledOff)],
    );
    assert.equal(
      caps.capabilities[2].pluginId,
      'dev.user-probe',
      'a matching name never retires a plugin-owned capability',
    );
    const claude = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(claude.mcpServers, {
      'probe-env': customizedInline,
      'secret-mcp': custom,
      other: custom,
      ...foreignEnabledOff,
    });
    assert.deepEqual(claude.custom, { retained: true });
    const codex = parse(await readFile(join(root, '.codex/config.toml'), 'utf8'));
    assert.equal(codex.model, 'preserve-model');
    assert.deepEqual(
      codex.mcp_servers,
      codexEnabled
        ? { 'secret-mcp': { ...custom, enabled: true }, other: { ...custom, enabled: true } }
        : { 'probe-off': disabledOff, 'secret-mcp': custom, other: custom },
    );
    for (const [file, bytes] of Object.entries(original)) {
      const path = join(root, file);
      const directory = file.includes('/') ? join(root, file.split('/')[0]) : root;
      const name = file.split('/').at(-1);
      const backup = (await readdir(directory)).find((entry) => entry.startsWith(`${name}.before-f333-probes-`));
      assert.ok(backup);
      assert.equal(await readFile(join(directory, backup), 'utf8'), bytes);
      assert.equal((await stat(join(directory, backup))).mode & 0o777, 0o600);
      const after = await readFile(path, 'utf8');
      await migrateStartupCodexMcpConfig(root, env);
      assert.equal(await readFile(path, 'utf8'), after, 'repeat migration preserves canonical bytes');
    }
  });

test('startup preserves customized capabilities even when their F193 command and payload match', async (t) => {
  const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
  const probes = {
    'probe-connected': { command: 'node', args: ['--input-type=module', '--eval', code] },
    'probe-env': { command: 'node', args: ['--input-type=module', '--eval', code] },
    'probe-off': { command: 'echo', args: ['ok'] },
  };
  for (const change of [
    { blockedCats: ['custom-cat'] },
    { enabled: false },
    { userOwned: true },
    { globalEnabled: false },
    { globalEnabled: 'true' },
    { blockedCats: null },
    { overrides: [] },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'f333-custom-probe-capability-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.cat-cafe'));
    const original = JSON.stringify({
      version: 2,
      capabilities: Object.entries(probes).map(([id, mcpServer]) => ({
        id,
        type: 'mcp',
        source: 'external',
        enabled: true,
        mcpServer,
        ...change,
      })),
    });
    await writeFile(join(root, '.cat-cafe/capabilities.json'), original);
    assert.deepEqual(await migrateFixture(root), [], `preserve capability customization ${JSON.stringify(change)}`);
    assert.equal(await readFile(join(root, '.cat-cafe/capabilities.json'), 'utf8'), original);
    assert.deepEqual(await readdir(join(root, '.cat-cafe')), ['capabilities.json'], 'no rewrite or backup');
  }
});

test('startup preserves customized F193 launches in capability, Claude JSON and Codex TOML', async (t) => {
  const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
  for (const change of [
    { cwd: '/user-owned' },
    { workingDir: '/user-owned' },
    { env: { CUSTOM: 'keep' } },
    { env: { OPENAI_API_KEY: 'user-key' } },
    { env: { OPENAI_API_KEY: 'test-key', CUSTOM: 'keep' } },
    { args: ['--input-type=module', '--eval', code.replace('probe_echo', 'user_owned_echo')] },
    { env: {} },
    { enabled: false },
    { enabled: 'true' },
    { enabled: 1 },
    { enabled: [] },
    { enabled: { custom: true } },
    { enabled: true, cwd: '/user-owned' },
    { enabled: true, env: { CUSTOM: 'keep' } },
    { enabled: true, args: ['--input-type=module', '--eval', code.replace('probe_echo', 'user_owned_echo')] },
    { enabled: true, future: true },
    { future: true },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'f333-custom-probe-launch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const directory of ['.cat-cafe', '.codex']) await mkdir(join(root, directory));
    const servers = {
      'probe-connected': { command: 'node', args: ['--input-type=module', '--eval', code], ...change },
      'probe-env': { command: 'node', args: ['--input-type=module', '--eval', code], ...change },
      'probe-off': { command: 'echo', args: ['ok'], ...change },
    };
    const original = {
      '.cat-cafe/capabilities.json': JSON.stringify({
        version: 2,
        capabilities: Object.entries(servers).map(([id, mcpServer]) => ({
          id,
          type: 'mcp',
          source: 'external',
          enabled: true,
          mcpServer,
        })),
      }),
      '.mcp.json': JSON.stringify({ mcpServers: servers }),
      '.codex/config.toml': stringify({ mcp_servers: servers }),
    };
    for (const [file, bytes] of Object.entries(original)) await writeFile(join(root, file), bytes);
    assert.deepEqual(await migrateFixture(root), [], `preserve launch customization ${JSON.stringify(change)}`);
    for (const [file, bytes] of Object.entries(original)) assert.equal(await readFile(join(root, file), 'utf8'), bytes);
  }
});

test('canonical capability normalization retires legacy launches before regeneration and the next member turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f333-canonical-probe-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['.git', '.cat-cafe', '.codex']) await mkdir(join(root, directory));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
  const originalApiCwd: string = JSON.parse(code.slice(code.lastIndexOf('process.chdir(') + 14, -2));
  const known = { command: 'node', args: ['--input-type=module', '--eval', code], workingDir: originalApiCwd };
  const launches = {
    'probe-connected': known,
    'probe-env': { ...known, env: { OPENAI_API_KEY: 'test-key' } },
    'probe-off': { command: 'echo', args: ['ok'] },
    unrelated: { command: 'echo', args: ['keep-user-service'] },
  };
  await writeCapabilitiesConfig(root, {
    version: 2,
    capabilities: Object.entries(launches).map(([id, mcpServer]) => ({
      id,
      type: 'mcp',
      enabled: true,
      source: 'external',
      blockedCats: [],
      mcpServer,
    })),
  });
  await migrateAndPersistCapabilities(root);
  const configPath = join(root, '.cat-cafe', 'capabilities.json');
  const canonical = JSON.parse(await readFile(configPath, 'utf8'));
  assert.ok(canonical.capabilities.every((entry: { globalEnabled?: boolean }) => entry.globalEnabled === true));
  const cliLaunches = Object.fromEntries(
    Object.entries(launches).map(([id, server]) => {
      const { workingDir, ...launch } = server as typeof server & { workingDir?: string };
      return [id, { ...launch, ...(workingDir ? { cwd: workingDir } : {}) }];
    }),
  );
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: cliLaunches }));
  await writeFile(
    join(root, '.codex/config.toml'),
    stringify({
      mcp_servers: Object.fromEntries(
        Object.entries(cliLaunches).map(([id, launch]) => [id, { ...launch, enabled: true }]),
      ),
    }),
  );
  const env = {
    CAT_CAFE_DEPLOYMENT_ID: 'runtime',
    CAT_CAFE_RUNTIME_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
  };
  assert.deepEqual(
    new Set(await migrateStartupCodexMcpConfig(root, env)),
    new Set(['probe-connected', 'probe-env', 'probe-off']),
  );
  for (let turn = 0; turn < 2; turn++) {
    const previous = await readFile(configPath, 'utf8');
    await regenerateStartupCliConfigs(root, env);
    if (turn > 0) assert.equal(await readFile(configPath, 'utf8'), previous, 'repeat startup is idempotent');
    const discovery = readInvocationMcpConfig(root);
    assert.ok(discovery.config);
    const servers = resolveServersForCat(discovery.config, 'codex', { accessScope: discovery.accessScope });
    const names = servers.map((server) => server.name);
    assert.ok(names.includes('unrelated'));
    assert.ok(
      !names.some((name) => ['probe-connected', 'probe-env', 'probe-off'].includes(name)),
      'next turn has no retired launch to spawn',
    );
    assert.deepEqual(
      discovery.config.capabilities.find((entry) => entry.id === 'unrelated'),
      canonical.capabilities.find((entry: { id: string }) => entry.id === 'unrelated'),
    );
    assert.deepEqual(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers, {
      unrelated: launches.unrelated,
    });
    assert.deepEqual(parse(await readFile(join(root, '.codex/config.toml'), 'utf8')).mcp_servers, {
      unrelated: { ...launches.unrelated, enabled: true },
    });
  }
});

async function migrateFixture(root: string): Promise<string[]> {
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  return migrateStartupCodexMcpConfig(root, {
    CAT_CAFE_DEPLOYMENT_ID: 'runtime',
    CAT_CAFE_RUNTIME_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
  });
}
