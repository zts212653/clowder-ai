import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { resolveByAccountRef } from '../src/config/account-resolver.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { assertCodexSharedStateRoots } from '../src/config/codex-shared-state.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { prepareCodexNativeLaunch } from '../src/domains/cats/services/agents/providers/codex-plugin-native-launch.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';
import type { SpawnFn } from '../src/utils/cli-types.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

let root: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-auto-state-')));
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
function defaultLaunch() {
  const profile = resolveByAccountRef(root, 'codex');
  assert.ok(profile);
  return resolveCodexAccountLaunch(profile, { cwd: root });
}
function reserveSharedState(prepared: boolean) {
  const ref = 'codex-00000000-0000-0000-0000-000000000001';
  const layout = describeCodexManagedLayout(root, ref);
  writeCatalogAccount(root, ref, {
    authType: 'oauth',
    clientId: 'openai',
    codex: prepared ? prepareCodexManagedLayout(layout, root) : layout,
  });
}

for (const prepared of [false, true])
  for (const field of ['stateRoot', 'sqliteHome'] as const)
    test(`auto descriptor ${field} drift is refused with an unchanged default source (prepared=${prepared})`, () => {
      reserveSharedState(prepared);
      const accepted = defaultLaunch();
      assert.equal(accepted.authMode, 'auto');
      const drifted = { ...accepted, [field]: join(root, 'other-root') };
      assert.throws(() => assertCodexSharedStateRoots(root, { launch: drifted }), /state_roots_divergent/);
      assert.throws(
        () => finalizeCodexAccountEnvironment(drifted, { cwd: root, env: {}, args: [] }),
        /state_roots_divergent/,
      );
    });

for (const managed of [false, true])
  test(`stable auto preserves native provider/authentication inputs (managed=${managed})`, () => {
    if (managed) reserveSharedState(true);
    const launch = defaultLaunch();
    const input = { OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'https://provider.invalid', HOME: root };
    const env = finalizeCodexAccountEnvironment(launch, { cwd: root, env: input, args: ['--oss'] });
    assert.equal(env.CODEX_AUTH_MODE, 'auto');
    for (const [key, value] of Object.entries(input)) assert.equal(env[key], value);
    assert.equal(env.CODEX_CAT_STATE_ROOT, launch.stateRoot);
    assert.equal(env.CODEX_CAT_SHARED_SQLITE_HOME, launch.sqliteHome);
    assert.equal(env.CODEX_CAT_ACCOUNT_OWNER_ROOT, launch.accountOwnerRoot);
    if (!managed) {
      process.env.CODEX_HOME = join(root, 'new-native-root');
      assert.doesNotThrow(() => finalizeCodexAccountEnvironment(defaultLaunch(), { cwd: root, env: input, args: [] }));
    }
  });

test('explicit API execution roots do not enter the shared-state contract', () => {
  reserveSharedState(true);
  const launch = { ...defaultLaunch(), authMode: 'api_key' as const, stateRoot: join(root, 'api-source') };
  const home = join(root, 'api-execution');
  assert.doesNotThrow(() => assertCodexSharedStateRoots(root, { launch }));
  const env = finalizeCodexAccountEnvironment(launch, {
    cwd: root,
    env: {},
    args: [],
    executionHome: home,
    selectedApiEnv: { OPENAI_API_KEY: 'fixture-key' },
  });
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.CODEX_SQLITE_HOME, home);
  assert.equal(env.CODEX_CAT_ACCOUNT_REF, null);
  assert.equal(env.CODEX_CAT_STATE_ROOT, null);
  assert.equal(env.OPENAI_API_KEY, 'fixture-key');
});

test('synthetic environment-key auto retains its account owner across an external execution cwd', () => {
  delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  delete process.env.OPENAI_API_KEY;
  const owner = join(root, 'account-owner');
  const external = join(root, 'external-workspace');
  mkdirSync(owner);
  mkdirSync(external);
  const ref = 'codex-00000000-0000-0000-0000-000000000001';
  writeCatalogAccount(owner, ref, {
    authType: 'oauth',
    clientId: 'openai',
    codex: prepareCodexManagedLayout(describeCodexManagedLayout(owner, ref), owner),
  });
  process.env.OPENAI_API_KEY = 'fixture-env-key';
  process.env.CODEX_HOME = join(root, 'drift');
  const profile = resolveByAccountRef(owner, 'codex');
  assert.ok(profile);
  assert.equal(profile.syntheticNative, true);
  assert.equal(profile.authType, 'api_key');
  const launch = resolveCodexAccountLaunch(profile, { cwd: external });
  assert.equal(launch.authMode, 'auto');
  assert.throws(() => assertCodexSharedStateRoots(owner, { launch }), /state_roots_divergent/);
  assert.throws(
    () => finalizeCodexAccountEnvironment(launch, { cwd: external, env: {}, args: [] }),
    /state_roots_divergent/,
  );
  assert.equal(profile.accountOwnerRoot, owner);
  assert.equal(launch.accountOwnerRoot, owner);
});

function scopedOptions(kind: 'public' | 'scoped-member'): AgentServiceOptions {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const launch = defaultLaunch();
  writeFileSync(join(launch.credentialHome, 'auth.json'), '{"fixture":true}');
  return {
    workingDirectory: workspace,
    signal: new AbortController().signal,
    codexAccountLaunch: launch,
    callbackEnv: { CODEX_AUTH_MODE: 'auto', CAT_CAFE_INVOCATION_ID: 'fixture', CAT_CAFE_CALLBACK_TOKEN: 'fixture' },
    toolExecutionPolicy: { mode: 'plugin_native', pluginInstanceId: 'instance', contributionId: 'native' },
    pluginNativeLaunch: {
      sandbox: { kind, workspaceRoot: workspace },
      server: {
        name: 'fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [],
        workingDirectory: workspace,
        env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture' },
      },
      assertCurrent: async () => {},
    },
  };
}

for (const kind of ['public', 'scoped-member'] as const) {
  test(`${kind} keeps shared source provenance separate from its isolated execution home`, async () => {
    reserveSharedState(true);
    const options = scopedOptions(kind);
    const prepared = await prepareCodexNativeLaunch(options, 'exec_json', true, 'codex', 'gpt-6.1-sol');
    try {
      const source = options.codexAccountLaunch;
      assert.ok(source);
      assert.notEqual(prepared.env.CODEX_HOME, source.stateRoot);
      assert.equal(prepared.env.CODEX_SQLITE_HOME, prepared.env.CODEX_HOME);
      assert.equal(prepared.env.CODEX_CAT_STATE_ROOT, source.stateRoot);
      assert.equal(prepared.env.CODEX_CAT_SHARED_SQLITE_HOME, source.sqliteHome);
      assert.equal(prepared.env.CODEX_CAT_ACCOUNT_OWNER_ROOT, source.accountOwnerRoot);
      assert.equal(realpathSync(join(prepared.env.CODEX_HOME, 'auth.json')), join(source.credentialHome, 'auth.json'));
    } finally {
      prepared.dispose();
    }
  });

  test(`${kind} rechecks source drift after isolated preparation and before native spawn`, async () => {
    reserveSharedState(true);
    const options = scopedOptions(kind);
    let spawns = 0;
    const service = new CodexAgentService({
      carrierMode: 'exec_json',
      cliCommand: process.execPath,
      l0CompilerFn: async (input) => {
        process.env.CODEX_HOME = join(root, 'late-drift');
        return fakeL0Compiler(input);
      },
      spawnFn: (() => {
        spawns++;
        throw new Error('unexpected_spawn');
      }) as SpawnFn,
      rawArchive: { append: async () => {} },
    });
    const errors: string[] = [];
    for await (const event of service.invoke('fixture', options))
      if (event.type === 'error') errors.push(event.error ?? '');
    assert.ok(
      errors.some((error) => error.includes('state_roots_divergent')),
      JSON.stringify(errors),
    );
    assert.equal(spawns, 0);
  });
}
