import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { captureCodexLaunchPolicy } from '../src/config/codex-cli.js';
import { CODEX_SHARED_DIRECTORIES } from '../src/config/codex-managed-layout.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import {
  bindCodexAccountConfiguration,
  validateCodexAccountConfiguration,
} from '../src/domains/cats/services/agents/providers/codex-app-server-account-configuration.js';
import type { AgentCarrierSession } from '../src/domains/cats/services/types.js';
import { installAmbientCodexAccount } from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

// F320 KD-3: credentials are isolated per account, conversation state is shared.
// An official OpenAI API key must be able to resume what OAuth wrote (and back),
// which Codex only allows on the same provider id with the same session store.

type Launch = { args: readonly string[]; env: Record<string, string | null | undefined> };

async function fixture(t: TestContext) {
  installAmbientCodexAccount(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-api-shared-')));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = root;
  delete process.env.CODEX_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'work');
  await mkdir(cwd);
  const sharedRoot = join(root, '.codex');
  await mkdir(sharedRoot);
  const account = (baseUrl?: string) => ({
    id: 'platform-key',
    authType: 'api_key' as const,
    apiKey: 'selected-platform-key',
    ...(baseUrl ? { baseUrl } : {}),
  });
  const launches: Launch[] = [];
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 0, maxWarmHosts: 0 },
    {
      createSocketDirectory: () => join(root, 'socket'),
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => {
        launches.push({ args: launch.args, env: launch.env as Launch['env'] });
        throw new Error('fixture_spawned');
      },
      connectHost: async () => {
        throw new Error('fixture_unexpected_wire');
      },
    },
  );
  t.after(() => pool.closeAll());
  const makeService = (carrierMode: 'exec_json' | 'app_server') =>
    new CodexAgentService({
      carrierMode,
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler as never,
      rawArchive: { append: async () => {} },
      appServerHostPool: pool,
      spawnFn: (_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        launches.push({ args, env: options.env ?? {} });
        throw new Error('fixture_spawned');
      },
    });
  const service = makeService('exec_json');
  const probeService = makeService('app_server');
  const run = async (input: { baseUrl?: string; transport?: 'builtin' | 'https'; cliConfigArgs?: string[] } = {}) => {
    const selected = account(input.baseUrl);
    const descriptor = resolveCodexAccountLaunch(selected, { cwd: root });
    const before = launches.length;
    const errors: string[] = [];
    for await (const event of service.invoke('fixture', {
      workingDirectory: cwd,
      invocationId: `api-shared-${launches.length}`,
      codexAccountLaunch: descriptor,
      codexLaunchPolicy: captureCodexLaunchPolicy({ CAT_CAFE_CODEX_OAUTH_TRANSPORT: input.transport ?? 'builtin' }),
      ...(input.cliConfigArgs ? { cliConfigArgs: input.cliConfigArgs } : {}),
      callbackEnv: {
        CODEX_AUTH_MODE: 'api_key',
        OPENAI_API_KEY: selected.apiKey,
        ...(input.baseUrl ? { OPENAI_BASE_URL: input.baseUrl } : {}),
      },
    }))
      if (event.type === 'error') errors.push(String(event.error ?? ''));
    return { launch: launches.length > before ? launches.at(-1) : undefined, errors };
  };
  const invoke = async (input: { baseUrl?: string; transport?: 'builtin' | 'https' } = {}) => {
    const { launch, errors } = await run(input);
    assert.ok(launch, `the invocation reached the carrier spawn: ${JSON.stringify(errors)}`);
    return launch;
  };
  return { root, cwd, sharedRoot, account, service, probeService, launches, run, invoke };
}

function config(launch: Launch): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < launch.args.length; i++)
    if (launch.args[i] === '--config' || launch.args[i] === '-c') {
      const expression = launch.args[++i];
      values.set(expression.slice(0, expression.indexOf('=')), expression.slice(expression.indexOf('=') + 1));
    }
  return values;
}

function assertSharesConversationState(launch: Launch, sharedRoot: string): void {
  const home = launch.env.CODEX_HOME;
  assert.ok(home, 'the API home is explicit');
  assert.notEqual(realpathSync(home), realpathSync(sharedRoot), 'credentials never use the OAuth home');
  assert.equal(existsSync(join(home, 'auth.json')), false, 'no OAuth login is visible to the API key');
  for (const name of CODEX_SHARED_DIRECTORIES) {
    assert.ok(lstatSync(join(home, name)).isSymbolicLink(), `${name} is linked, not forked`);
    assert.equal(realpathSync(join(home, name)), realpathSync(join(sharedRoot, name)));
  }
  assert.equal(launch.env.CODEX_SQLITE_HOME, realpathSync(sharedRoot), 'thread index is the shared one');
  // A configured sqlite_home outranks the environment; only the command line outranks config files.
  assert.equal(config(launch).get('sqlite_home'), JSON.stringify(realpathSync(sharedRoot)));
}

test('official API key resumes OAuth conversations: builtin provider, in-memory key, shared state', async (t) => {
  const f = await fixture(t);
  for (const baseUrl of [undefined, 'https://api.openai.com/v1', 'https://api.openai.com/v1/']) {
    const launch = await f.invoke({ baseUrl });
    const values = config(launch);
    assert.equal(values.get('model_provider'), '"openai"', 'same provider id as the OAuth builtin transport');
    assert.equal(values.get('cli_auth_credentials_store'), '"ephemeral"', 'the key never reaches disk');
    // Command-line config outranks user and trusted-project layers, so nothing can redirect the key.
    assert.equal(values.get('openai_base_url'), '"https://api.openai.com/v1"');
    assert.ok(![...values.keys()].some((key) => key.startsWith('model_providers.custom')));
    assert.equal(launch.env.CODEX_API_KEY, 'selected-platform-key', 'exec selects the key ahead of any login');
    assertSharesConversationState(launch, f.sharedRoot);
  }
});

test('official API key follows the OAuth HTTPS transport so both sides keep one provider id', async (t) => {
  const f = await fixture(t);
  const values = config(await f.invoke({ transport: 'https' }));
  assert.equal(values.get('model_provider'), '"openai_https"');
  assert.equal(values.get('model_providers.openai_https.requires_openai_auth'), 'true');
  assert.equal(values.get('model_providers.openai_https.base_url'), '"https://api.openai.com/v1"');
  assert.equal(values.get('cli_auth_credentials_store'), '"ephemeral"');
});

test('a third-party gateway key keeps its own provider and private state', async (t) => {
  const f = await fixture(t);
  const launch = await f.invoke({ baseUrl: 'https://gateway.example/v1' });
  const values = config(launch);
  assert.equal(values.get('model_provider'), '"custom"');
  assert.equal(values.get('model_providers.custom.base_url'), '"https://gateway.example/v1"');
  assert.equal(launch.env.CODEX_API_KEY, undefined);
  assert.equal(launch.env.CODEX_SQLITE_HOME, launch.env.CODEX_HOME, 'gateway threads cannot resume OAuth ones');
  assert.equal(lstatSync(join(String(launch.env.CODEX_HOME), 'sessions'), { throwIfNoEntry: false }), undefined);
});

test('capability probe uses the same shared API home as the main call', async (t) => {
  const f = await fixture(t);
  const main = await f.invoke();
  await assert.rejects(() =>
    f.probeService.requestNativeCapabilitySource({
      invocationId: 'api-shared-probe',
      cwd: f.cwd,
      timeoutMs: 1000,
      account: f.account(),
    }),
  );
  const probe = f.launches.at(-1);
  assert.ok(probe && probe !== main, 'the probe reached its own host launch');
  assert.equal(config(probe).get('model_provider'), '"openai"');
  assert.equal(config(probe).get('cli_auth_credentials_store'), '"ephemeral"');
  assert.equal(config(probe).get('openai_base_url'), '"https://api.openai.com/v1"');
  assert.equal(probe.env.CODEX_HOME, main.env.CODEX_HOME);
  assertSharesConversationState(probe, f.sharedRoot);
});

test('app-server logs the selected key in memory before any business RPC and refuses another principal', async () => {
  const env = {
    CODEX_AUTH_MODE: 'api_key',
    CODEX_API_KEY: 'selected-platform-key',
    CODEX_SQLITE_HOME: '/fixture/shared',
  };
  for (const observed of [{ type: 'apiKey' }, { type: 'chatgpt', email: 'other@example.com' }, null]) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const wire = bindCodexAccountConfiguration({} as AgentCarrierSession, { env, cwd: '/fixture/work' } as never);
    const validation = validateCodexAccountConfiguration(wire, async (method, params) => {
      calls.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'configRequirements/read') return { requirements: null };
      if (method === 'account/login/start') return { type: 'apiKey' };
      return { account: observed };
    });
    if (observed?.type === 'apiKey') await validation;
    else await assert.rejects(validation, /codex_native_account_configuration_conflict:auth_mode/);
    const login = calls.findIndex((call) => call.method === 'account/login/start');
    assert.ok(login >= 0, 'the API key is supplied through the native login, not a file');
    assert.deepEqual(calls[login].params, { type: 'apiKey', apiKey: 'selected-platform-key' });
    assert.ok(login < calls.findIndex((call) => call.method === 'account/read'));
  }
});

test('member config cannot redirect the official key through the HTTPS provider table', async (t) => {
  const f = await fixture(t);
  for (const expression of [
    'model_providers.openai_https.base_url="https://other.example/v1"',
    'model_providers.openai_https.env_key="F320_MCP_TOKEN"',
    'model_providers.openai_https={requires_openai_auth=false}',
  ]) {
    const { launch, errors } = await f.run({ transport: 'https', cliConfigArgs: [`--config ${expression}`] });
    assert.equal(launch === undefined, true, `${expression} is refused before spawn`);
    assert.ok(
      errors.some((error) => error.includes('codex_api_account_configuration_conflict')),
      JSON.stringify(errors),
    );
  }
});

test('an API-only household (default codex account is itself a key) still shares the default home', async (t) => {
  const f = await fixture(t);
  writeCatalogAccount(f.root, 'codex', { authType: 'api_key', clientId: 'openai' });
  assertSharesConversationState(await f.invoke(), f.sharedRoot);
});
