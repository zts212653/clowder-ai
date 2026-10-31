import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from '../src/config/account-resolver.js';
import { resolveCatRuntimeAccount } from '../src/config/cat-runtime-account.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import type { AgentCarrierSessionOptions } from '../src/domains/cats/services/types.js';
import { resolveCurationProvider } from '../src/domains/memory/curation-provider.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';

function fixture(t: TestContext, accountRef?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'issue-1654-')));
  const home = join(root, '.codex');
  mkdirSync(home);
  writeFileSync(
    join(home, 'config.toml'),
    'model_provider="cc-switch"\nmodel="native-model"\n[model_providers.cc-switch]\n' +
      'name="Fixture"\nbase_url="https://fixture.invalid/v1"\nwire_api="responses"\n' +
      'requires_openai_auth=false\nexperimental_bearer_token="fixture-only"\n',
  );
  const values = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    OPENAI_API_KEY: 'native-env-fixture',
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const id = `issue-1654-${basename(root)}`;
  const base = catRegistry.tryGet('codex');
  assert.ok(base);
  catRegistry.register(id, {
    ...base.config,
    id,
    configurationSource: 'native_tool',
    clientId: 'openai',
    carrier: 'app_server',
    defaultModel: '',
    ...(accountRef ? { accountRef } : { accountRef: undefined }),
    cli: { command: 'codex', outputFormat: 'json' },
  });
  return { root, home, id };
}

test('all native readers bypass an unrelated app default while explicit bindings still resolve', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.cat-cafe'));
  writeFileSync(
    join(f.root, '.cat-cafe', 'accounts.json'),
    JSON.stringify({ codex: { authType: 'api_key', clientId: 'openai', baseUrl: 'https://other.invalid/v1' } }),
  );
  writeFileSync(join(f.root, '.cat-cafe', 'credentials.json'), JSON.stringify({ codex: { apiKey: 'other-key' } }));
  const config = catRegistry.tryGet(f.id)?.config;
  assert.ok(config);
  assert.equal(resolveCatRuntimeAccount(f.root, f.id, 'openai', config), null);
  const explicit = resolveCatRuntimeAccount(f.root, f.id, 'openai', { ...config, accountRef: 'codex' });
  assert.equal(explicit?.authType, 'api_key');
  assert.equal(explicit?.apiKey, 'other-key');
});

for (const accountRef of [undefined, '   ', 'curator-api']) {
  test(`curation respects native CLI authority with ${accountRef === 'curator-api' ? 'an explicit account' : 'no explicit account'}`, (t) => {
    const f = fixture(t, accountRef);
    mkdirSync(join(f.root, '.cat-cafe'));
    writeFileSync(
      join(f.root, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        codex: { authType: 'api_key', clientId: 'openai', baseUrl: 'https://unrelated.invalid/v1' },
        'curator-api': {
          authType: 'api_key',
          clientId: 'openai',
          baseUrl: 'https://selected.invalid/v1',
          envVars: { CODEX_HOME: join(f.root, 'selected-codex'), CURATOR_ONLY: 'selected-env' },
        },
      }),
    );
    writeFileSync(
      join(f.root, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ codex: { apiKey: 'unrelated-key' }, 'curator-api': { apiKey: 'selected-key' } }),
    );
    const { options } = resolveCurationProvider(f.root, f.id);
    if (accountRef === 'curator-api') {
      assert.equal(options.callbackEnv?.CODEX_AUTH_MODE, 'api_key');
      assert.equal(options.callbackEnv?.OPENAI_API_KEY, 'selected-key');
      assert.equal(options.accountEnv?.CURATOR_ONLY, 'selected-env');
      assert.equal(options.codexAccountLaunch?.accountRef, accountRef);
      assert.equal(options.codexAccountLaunch?.authMode, 'api_key');
      assert.equal(options.codexAccountLaunch?.credentialHome, join(f.root, 'selected-codex'));
    } else {
      assert.equal(options.callbackEnv?.CODEX_AUTH_MODE, undefined);
      assert.equal(options.callbackEnv?.OPENAI_API_KEY, undefined);
      assert.equal(options.accountEnv, undefined);
      assert.equal(options.codexAccountLaunch, undefined);
    }
  });
}

for (const kind of ['absent', 'synthetic-oauth', 'synthetic-api', 'unbound-default'] as const) {
  test(`native capability launch preserves CLI authority with ${kind} account input`, async (t) => {
    const f = fixture(t);
    const account: RuntimeProviderProfile | undefined =
      kind === 'absent'
        ? undefined
        : {
            id: 'codex',
            client: 'openai',
            authType: kind === 'synthetic-api' ? 'api_key' : 'oauth',
            ...(kind.startsWith('synthetic') ? { syntheticNative: true } : {}),
            ...(kind === 'synthetic-api' ? { apiKey: 'other-key', baseUrl: 'https://other.invalid/v1' } : {}),
          };
    const service = new CodexAgentService({
      catId: f.id,
      cliCommand: process.execPath,
      carrierMode: 'app_server',
      appServerHostPool: {
        createSession: async (launch: AgentCarrierSessionOptions) => {
          assert.equal(launch.env?.CODEX_AUTH_MODE, 'auto', 'the CLI owns authentication');
          assert.equal(launch.env?.CODEX_HOME, f.home);
          assert.equal(launch.env?.OPENAI_API_KEY, 'native-env-fixture');
          assert.equal(
            launch.args.some((arg) => /^model_provider=|^model_providers\./.test(arg)),
            false,
          );
          return new F320AccountWire({ model_provider: 'cc-switch', sqlite_home: f.home });
        },
      } as never,
    });
    const source = await service.requestNativeCapabilitySource({
      cwd: f.root,
      account,
      invocationId: `issue-1654-${kind}`,
      timeoutMs: 1000,
    });
    assert.equal(source.availability, 'live');
  });
}

test('explicit OAuth binding retains its provider and credential boundary', async (t) => {
  const f = fixture(t, 'selected-oauth');
  let launch: AgentCarrierSessionOptions | undefined;
  const service = new CodexAgentService({
    catId: f.id,
    cliCommand: process.execPath,
    carrierMode: 'app_server',
    appServerHostPool: {
      createSession: async (options: AgentCarrierSessionOptions) => {
        launch = options;
        throw new Error('fixture_launch_captured');
      },
    } as never,
  });
  await assert.rejects(
    service.requestNativeCapabilitySource({
      cwd: f.root,
      account: { id: 'selected-oauth', client: 'openai', authType: 'oauth' },
      invocationId: 'issue-1654-explicit',
      timeoutMs: 1000,
    }),
    /fixture_launch_captured/,
  );
  assert.equal(launch?.env?.CODEX_AUTH_MODE, 'oauth');
  assert.equal(launch?.env?.OPENAI_API_KEY, null);
  assert.ok(launch?.args.includes('model_provider="openai"'));
});

test('native first turn, resume and a recreated service keep the same CLI authority', async (t) => {
  const f = fixture(t);
  for (const resume of [false, true, true]) {
    const service = new CodexAgentService({
      catId: f.id,
      cliCommand: process.execPath,
      carrierMode: 'app_server',
      l0CompilerFn: async () => 'fixture instructions',
      rawArchive: { append: async () => {} },
    });
    const wire = new F320AccountWire({ model_provider: 'cc-switch', sqlite_home: f.home });
    for await (const event of service.invoke('fixture', {
      workingDirectory: f.root,
      ...(resume ? { sessionId: 'fixture-thread' } : {}),
      callbackEnv: { CODEX_AUTH_MODE: 'oauth' },
      agentCarrierSessionFactory: async (launch) => {
        assert.equal(launch.env?.CODEX_AUTH_MODE, 'auto', 'a stale app selector cannot take CLI authority');
        assert.equal(launch.env?.CODEX_HOME, f.home);
        assert.equal(
          launch.args.some((arg) => /^model_provider=|^model_providers\./.test(arg)),
          false,
        );
        return wire;
      },
    }))
      assert.notEqual(event.type, 'error', event.error);
    assert.ok(wire.writes.some((request) => request.method === (resume ? 'thread/resume' : 'thread/start')));
  }
});
