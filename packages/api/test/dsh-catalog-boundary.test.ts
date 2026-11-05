import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { catsRoutes } from '../src/routes/cats.js';
import { invalidateCliCommand } from '../src/utils/cli-resolve.js';

test('DSH discovery, creation and both model catalog paths never initialize an absent or invalid profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-catalog-boundary-'));
  const home = join(root, '.dsh');
  const pkg = join(root, 'npm-cache/_npx/fixture/node_modules/@deepseek-ai/dsh');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
  const entry = join(pkg, 'lib/bin.js');
  writeFileSync(entry, 'throw Error("The catalog must not launch DSH");');
  const template = JSON.parse(readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(template));
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
  const environment = {
    CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    DSH_HOME: home,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    APPDATA: root,
    npm_config_cache: join(root, 'npm-cache'),
    CODEX_HOME: join(root, '.codex'),
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    PATH: [
      dirname(process.execPath),
      ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:/Windows', 'System32')] : []),
    ].join(delimiter),
  };
  const saved = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  for (const command of ['dsh', 'claude', 'codex']) invalidateCliCommand(command);
  let spawns = 0;
  // Keep PATH restricted to the fixture. Supplying Node lookup avoids requiring
  // a host `which` executable while retaining the real cached-entry discovery.
  mock.method(childProcess, 'execSync', (command: string) => {
    if (command === 'where node.exe' || command === 'which node') return process.execPath;
    spawns++;
    throw Error('Unexpected synchronous process launch');
  });
  mock.method(childProcess, 'spawn', () => {
    spawns++;
    throw Error('Unexpected process launch');
  });
  mock.method(childProcess, 'execFile', () => {
    spawns++;
    throw Error('Unexpected process launch');
  });
  syncBuiltinESMExports();
  const app = Fastify();
  await app.register(catsRoutes);
  const headers = { 'x-cat-cafe-user': 'test' };
  const profile = join(home, 'profiles/acp/package.json');
  const query = (runtimeId: string) =>
    app.inject({ method: 'POST', url: '/api/cats/runtime-models', headers, payload: { runtimeId } });
  try {
    const pending = await query('dsh');
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().message, 'acp_profile_missing');
    assert.equal(spawns, 0);
    assert.equal(existsSync(home), false);
    const badHome = join(root, 'bad-profile');
    mkdirSync(join(badHome, 'profiles/acp'), { recursive: true });
    writeFileSync(join(badHome, 'profiles/acp/package.json'), '{broken');
    process.env.DSH_HOME = badHome;
    const nativeInvalid = await query('dsh');
    assert.equal(nativeInvalid.json().message, 'acp_profile_invalid', nativeInvalid.body);
    assert.equal(spawns, 0);
    process.env.DSH_HOME = home;
    const creation = {
      method: 'POST' as const,
      url: '/api/cats',
      headers: {
        ...headers,
        'x-cat-cafe-onboarding-journey': 'dsh-test',
        'idempotency-key': 'onboarding:dsh-test:cat:one',
      },
      payload: {
        catId: 'dsh-boundary-fixture',
        name: 'DSH boundary',
        displayName: 'DSH boundary',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@dsh-boundary-fixture'],
        roleDescription: 'test',
        configurationSource: 'native_tool',
        clientId: 'acp',
        defaultModel: '',
        acp: { command: process.execPath, startupArgs: [entry, '--profile', 'acp'], transport: 'stdio' },
      },
    };
    const created = await app.inject(creation);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(existsSync(home), false, 'creating a member must not initialize DSH');
    const registered = await query('acp:dsh-boundary-fixture');
    assert.equal(registered.json().message, 'acp_profile_missing', registered.body);
    assert.equal(spawns, 0, 'registered launchers must not bypass the read-side gate');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers,
      payload: {
        catId: 'dsh-stale',
        name: 'stale',
        displayName: 'stale',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@dsh-stale'],
        roleDescription: 'test',
        configurationSource: 'native_tool',
        clientId: 'acp',
        defaultModel: '',
        acp: { command: join(root, 'missing/dsh.exe'), startupArgs: ['--profile', 'acp'] },
      },
    });
    assert.equal(stale.statusCode, 201, stale.body);
    const discovered = await app.inject({ method: 'GET', url: '/api/cats/native-runtimes', headers });
    assert.equal(discovered.statusCode, 200, discovered.body);
    const staleRuntime = discovered.json().runtimes.find((runtime: { id: string }) => runtime.id === 'acp:dsh-stale');
    assert.equal(staleRuntime.installed, false);
    assert.equal(staleRuntime.discoveryStatus, 'not_installed');
    assert.equal(spawns, 0);
    const wrappers = [
      { command: process.execPath, startupArgs: ['-e', 'process.exit(0)', 'dsh', '--profile', 'acp'] },
      process.platform === 'win32'
        ? {
            command: join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe'),
            startupArgs: ['/c', 'dsh', '--profile', 'acp'],
          }
        : { command: '/bin/sh', startupArgs: ['-c', 'dsh --profile acp'] },
    ];
    for (const [index, acp] of wrappers.entries()) {
      const catId = `dsh-wrapper-${index}`;
      const wrapper = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers,
        payload: {
          catId,
          name: catId,
          displayName: catId,
          color: { primary: '#123456', secondary: '#abcdef' },
          mentionPatterns: [`@${catId}`],
          roleDescription: 'test',
          configurationSource: 'native_tool',
          clientId: 'acp',
          defaultModel: '',
          acp,
        },
      });
      assert.equal(wrapper.statusCode, 201, wrapper.body);
      const catalog = await query(`acp:${catId}`);
      assert.equal(catalog.json().message, 'custom_startup', catalog.body);
      assert.equal(spawns, 0, 'DSH wrappers cannot bypass the read-side boundary');
      assert.equal(existsSync(home), false);
    }
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(profile, '{broken');
    const invalid = await query('acp:dsh-boundary-fixture');
    assert.equal(invalid.json().message, 'acp_profile_invalid', invalid.body);
    assert.equal(invalid.json().status, 'unavailable');
    assert.equal(readFileSync(profile, 'utf8'), '{broken');
    assert.equal(spawns, 0);
    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers,
      payload: {
        catId: 'dsh-invalid-fixture',
        name: 'invalid',
        displayName: 'invalid',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@dsh-invalid-fixture'],
        roleDescription: 'test',
        configurationSource: 'native_tool',
        clientId: 'acp',
        defaultModel: '',
        acp: { command: process.execPath, startupArgs: [entry, '--profile', 'acp'], transport: 'stdio' },
      },
    });
    assert.equal(invalidCreate.statusCode, 400, invalidCreate.body);
    assert.equal(invalidCreate.json().code, 'acp_profile_invalid');
    assert.equal(readFileSync(profile, 'utf8'), '{broken');
    assert.equal(spawns, 0);
    const replay = await app.inject(creation);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().idempotent, true);
    assert.equal(replay.json().cat.id, created.json().cat.id);
    assert.equal(readFileSync(profile, 'utf8'), '{broken');
    assert.equal(spawns, 0, 'recovery must return the persisted member without starting DSH');
    writeFileSync(profile, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }));
    const configured = await query('acp:dsh-boundary-fixture');
    assert.equal(configured.statusCode, 200);
    assert.ok(spawns > 0, 'a valid profile must reach the guarded probe, proving the gate is not unconditional');
    assert.equal(configured.json().message, 'discovery_failed');
  } finally {
    await app.close();
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const command of ['dsh', 'claude', 'codex']) invalidateCliCommand(command);
  }
});
