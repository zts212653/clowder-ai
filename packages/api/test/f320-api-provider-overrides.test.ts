import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { validateCodexNativeAccount } from '../src/config/codex-account-native-validation.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { installAmbientCodexAccount } from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

async function fixture(t: TestContext) {
  installAmbientCodexAccount(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-api-overrides-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = { id: 'selected-b', authType: 'api_key' as const, apiKey: 'selected-key-b', envVars: { HOME: root } };
  const descriptor = resolveCodexAccountLaunch(account, { cwd: root, env: { HOME: root } });
  const launches: Array<readonly string[]> = [];
  const capture = (launch: { args: readonly string[] }): never => {
    launches.push(launch.args);
    throw new Error('fixture_unexpected_launch');
  };
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 0, maxWarmHosts: 0 },
    {
      createSocketDirectory: () => join(root, 'socket'),
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => capture(launch),
      connectHost: async () => {
        throw new Error('fixture_unexpected_wire');
      },
    },
  );
  t.after(() => pool.closeAll());
  return { root, account, descriptor, pool, capture, launches };
}

for (const carrier of ['probe', 'direct', 'pooled', 'exec'] as const)
  for (const expression of ['model_provider="openai"', 'model_providers.custom.env_key="F320_MCP_TOKEN"'])
    test(`explicit API ${carrier} rejects member identity override ${expression}`, async (t) => {
      const f = await fixture(t);
      const service = new CodexAgentService({
        carrierMode: carrier === 'exec' ? 'exec_json' : 'app_server',
        ...(carrier === 'probe' || carrier === 'pooled' ? { appServerHostPool: f.pool } : {}),
        cliCommand: process.execPath,
        l0CompilerFn: fakeL0Compiler,
        rawArchive: { append: async () => {} },
        spawnFn: () => {
          f.launches.push(['exec']);
          throw new Error('fixture_unexpected_spawn');
        },
      });
      const cliConfigArgs = [`--config ${expression}`];
      if (carrier === 'probe') {
        await assert.rejects(
          () =>
            service.requestNativeCapabilitySource({
              invocationId: 'api-override-probe',
              cwd: f.root,
              timeoutMs: 1000,
              account: f.account,
              cliConfigArgs,
            }),
          /codex_api_account_configuration_conflict/,
        );
      } else {
        const errors: string[] = [];
        for await (const event of service.invoke('fixture', {
          workingDirectory: f.root,
          invocationId: 'api-override-main',
          codexAccountLaunch: f.descriptor,
          accountEnv: f.account.envVars,
          cliConfigArgs,
          callbackEnv: { CODEX_AUTH_MODE: 'api_key', OPENAI_API_KEY: f.account.apiKey },
          ...(carrier === 'direct' ? { agentCarrierSessionFactory: async (options) => f.capture(options) } : {}),
        }))
          if (event.type === 'error') errors.push(event.error ?? '');
        assert.ok(
          errors.some((error) => error.includes('codex_api_account_configuration_conflict')),
          JSON.stringify(errors),
        );
      }
      assert.equal(f.launches.length, 0, 'conflicting member config must be rejected before spawn/acquisition');
    });

test('API rejects whole tables, credential/header/routing subfields and accepted CLI spellings', async (t) => {
  const f = await fixture(t);
  for (const expression of [
    'model_provider="other"',
    'model_providers={custom={env_key="F320_MCP_TOKEN"}}',
    'model_providers.custom={auth={command="false"}}',
    'model_providers.custom.auth.command="false"',
    'model_providers.custom.experimental_bearer_token="fixture"',
    'model_providers.custom.requires_openai_auth=true',
    'model_providers.custom.base_url="http://127.0.0.1:1"',
    'model_providers.custom.env_http_headers.OpenAI-Organization="F320_MCP_TOKEN"',
    'model_providers.custom.http_headers.Authorization="fixture"',
    'chatgpt_base_url="http://127.0.0.1:1"',
    'sqlite_home="/tmp/unselected-state"',
    'cli_auth_credentials_store="keyring"',
  ])
    for (const memberConfigArgs of [
      ['--config', expression],
      ['-c', expression],
      [`--config=${expression}`],
      [`-c=${expression}`],
      [`-c${expression}`],
    ])
      assert.throws(
        () =>
          finalizeCodexAccountEnvironment(f.descriptor, {
            cwd: f.root,
            env: {},
            selectedApiEnv: { OPENAI_API_KEY: f.account.apiKey },
            args: [],
            memberConfigArgs,
          }),
        /codex_api_account_configuration_conflict/,
      );
});

test('API RPC overlays cannot change the owned provider, but ordinary API preferences and auto remain usable', async (t) => {
  const f = await fixture(t);
  for (const memberConfigArgs of [['--oss'], ['--profile', 'work'], ['-pwork'], ['--local-provider=ollama']])
    assert.throws(
      () =>
        finalizeCodexAccountEnvironment(f.descriptor, {
          cwd: f.root,
          env: {},
          args: [],
          memberConfigArgs,
        }),
      /codex_api_account_configuration_conflict/,
    );
  for (const rpcConfig of [
    { model_provider: 'openai' },
    { 'model_providers.custom.env_key': 'F320_MCP_TOKEN' },
    { model_providers: { custom: { env_http_headers: { 'OpenAI-Project': 'F320_MCP_TOKEN' } } } },
  ]) {
    const requests: string[] = [];
    await assert.rejects(
      () =>
        validateCodexNativeAccount(
          async (method) => {
            requests.push(method);
            if (method === 'config/read') return { config: {} };
            if (method === 'configRequirements/read') return { requirements: null };
            return { account: null };
          },
          { authMode: 'api_key', sqliteHome: f.root, cwd: f.root },
          rpcConfig,
        ),
      /codex_api_account_configuration_conflict/,
    );
    assert.ok(requests.every((method) => !method.startsWith('thread/')));
  }
  assert.doesNotThrow(() =>
    finalizeCodexAccountEnvironment(f.descriptor, {
      cwd: f.root,
      env: {},
      selectedApiEnv: { OPENAI_API_KEY: f.account.apiKey },
      args: [],
      memberConfigArgs: ['-c', 'model_reasoning_effort="low"', '-c', 'model_providers.custom.request_max_retries=2'],
      rpcConfig: { model: 'fixture-model', mcp_servers: { fixture: { enabled: false } } },
    }),
  );
  const auto = resolveCodexAccountLaunch(f.account, { cwd: f.root, authMode: 'auto' });
  assert.doesNotThrow(() =>
    finalizeCodexAccountEnvironment(auto, {
      cwd: f.root,
      env: {},
      args: [],
      memberConfigArgs: ['-c', 'model_provider="openai"'],
    }),
  );
});
