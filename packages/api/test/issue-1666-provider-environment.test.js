import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { resolveCodexAccountLaunch } from '../dist/config/codex-account-launch.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { writeAgentCommandFile } from '../dist/domains/terminal/tmux-command-file.js';
import { ALTERNATIVE_CODEX_AUTH_INPUTS, installAmbientCodexAccount } from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

function isolateProxyExceptions(t) {
  const aliases = Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'NO_PROXY');
  aliases.forEach(([key]) => {
    delete process.env[key];
  });
  t.after(() => {
    Object.keys(process.env)
      .filter((key) => key.toUpperCase() === 'NO_PROXY')
      .forEach((key) => {
        delete process.env[key];
      });
    aliases.forEach(([key, value]) => {
      process.env[key] = value;
    });
  });
}

// Protocol-only peer: observes production launch inputs without model calls.
class Wire {
  values = [];
  closed = false;
  wake = () => {};
  async *read() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift();
      else
        await new Promise((resolve) => {
          this.wake = resolve;
        });
    }
  }
  async write(message) {
    if (message.id === undefined) return;
    const method = message.method;
    let result = {};
    if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
    if (method === 'config/read') result = { config: {} };
    if (method === 'configRequirements/read') result = { requirements: null };
    if (method === 'account/read') result = { account: { type: 'apiKey' } };
    if (method === 'thread/start' || method === 'thread/resume')
      result = { thread: { id: 'fixture-thread', turns: [] } };
    if (method === 'turn/start') result = { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } };
    this.values.push({ id: message.id, result });
    if (method === 'turn/start')
      this.values.push({
        method: 'turn/completed',
        params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed', items: [] } },
      });
    this.wake();
  }
  async close() {
    this.closed = true;
    this.wake();
  }
}

for (const [carrierMode, baseUrl] of ['exec_json', 'app_server'].flatMap((carrier) =>
  [undefined, 'https://gateway.fixture.invalid/v1'].map((endpoint) => [carrier, endpoint]),
)) {
  test(`final account/callback environment reaches ${carrierMode} on first call and resume (endpoint=${baseUrl ? 'gateway' : 'official'})`, async (t) => {
    installAmbientCodexAccount(t);
    isolateProxyExceptions(t);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'issue1666-provider-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const account = {
      id: 'issue1666-api',
      authType: 'api_key',
      apiKey: 'selected-fixture',
      ...(baseUrl ? { baseUrl } : {}),
      envVars: { HOME: root, NO_PROXY: 'account.fixture' },
    };
    const launch = resolveCodexAccountLaunch(account, { cwd: root, env: { HOME: root } });
    const service = new CodexAgentService({
      carrierMode,
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      rawArchive: { append: async () => {} },
    });
    let observed = 0;
    const inspect = async (options) => {
      observed++;
      assert.equal(options.inheritParentEnv, false);
      for (const key of ALTERNATIVE_CODEX_AUTH_INPUTS)
        assert.equal(
          options.env[key],
          !baseUrl && key === 'CODEX_API_KEY' ? account.apiKey : undefined,
          `${key} must not select the ambient account; only the official endpoint carries the selected native key`,
        );
      assert.equal(options.env.OPENAI_API_KEY, account.apiKey);
      assert.equal(options.env.HTTP_PROXY, 'http://proxy.fixture.invalid:3128');
      assert.equal(options.env.CAT_CAFE_INVOCATION_ID, 'issue1666-turn');
      if (carrierMode === 'exec_json') assert.equal(options.env.CAT_CAFE_EXECUTION_ID, 'owned-execution-fixture');
      assert.equal(options.env.NO_PROXY, 'account.fixture,localhost,127.0.0.1,::1');
      if (process.platform !== 'win32') {
        const dir = await mkdtemp(join(root, 'writer-'));
        const argv = await writeAgentCommandFile(dir, options, ':');
        const script = await readFile(argv.at(-1), 'utf8');
        assert.equal(script.includes("export CODEX_API_KEY='selected-fixture'"), !baseUrl);
        assert.equal(script.includes("export NO_PROXY='account.fixture,localhost,127.0.0.1,::1'"), true);
      }
    };
    for (const sessionId of [undefined, 'fixture-thread']) {
      for await (const event of service.invoke('fixture', {
        workingDirectory: root,
        invocationId: 'issue1666-turn',
        codexAccountLaunch: launch,
        sessionId,
        accountEnv: account.envVars,
        callbackEnv: {
          CODEX_AUTH_MODE: 'api_key',
          OPENAI_API_KEY: account.apiKey,
          ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
          NO_PROXY: 'callback.fixture',
          HTTP_PROXY: 'http://proxy.fixture.invalid:3128',
          CAT_CAFE_INVOCATION_ID: 'issue1666-turn',
          CAT_CAFE_EXECUTION_ID: 'owned-execution-fixture',
        },
        ...(carrierMode === 'app_server'
          ? {
              agentCarrierSessionFactory: async (options) => {
                await inspect(options);
                return new Wire();
              },
            }
          : {
              spawnCliOverride: async function* (options) {
                await inspect(options);
                yield { type: 'thread.started', thread_id: 'fixture-thread' };
                yield { type: 'item.completed', item: { type: 'agent_message', text: 'fixture reply' } };
                yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
              },
            }),
      }))
        assert.notEqual(event.type, 'error', event.error);
    }
    assert.equal(observed, 2);
  });
}

test('native capability launch preserves native config authority and final proxy exceptions', async (t) => {
  isolateProxyExceptions(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'issue1666-capability-')));
  const home = join(root, '.codex');
  await mkdir(home);
  const config =
    'model_provider="fixture"\n[model_providers.fixture]\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\n';
  await writeFile(join(home, 'config.toml'), config);
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  Object.assign(process.env, { HOME: root, USERPROFILE: root, CODEX_HOME: home, NO_PROXY: 'native.fixture' });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const id = 'issue1666-native';
  catRegistry.register(id, {
    ...catRegistry.tryGet('codex').config,
    id,
    configurationSource: 'native_tool',
    clientId: 'openai',
    carrier: 'app_server',
    defaultModel: '',
    accountRef: undefined,
    cli: { command: 'codex', outputFormat: 'json' },
  });
  let observed = 0;
  const inspect = async (options) => {
    observed++;
    assert.equal(options.env.CODEX_AUTH_MODE, 'auto');
    assert.equal(options.env.CODEX_HOME, home);
    assert.equal(options.inheritParentEnv, false);
    assert.equal(options.env.NO_PROXY.includes('127.0.0.1'), true);
    assert.equal(
      options.args.some((arg) => arg.startsWith('model_provider=')),
      false,
    );
    return new Wire();
  };
  const service = new CodexAgentService({
    catId: id,
    cliCommand: process.execPath,
    carrierMode: 'app_server',
    l0CompilerFn: fakeL0Compiler,
    rawArchive: { append: async () => {} },
    appServerHostPool: { createSession: inspect },
  });
  await service.requestNativeCapabilitySource({ cwd: root, invocationId: 'capability-fixture', timeoutMs: 1000 });
  for (const sessionId of [undefined, 'fixture-thread']) {
    for await (const event of service.invoke('fixture', {
      workingDirectory: root,
      sessionId,
      invocationId: 'native-turn',
      agentCarrierSessionFactory: inspect,
    }))
      assert.notEqual(event.type, 'error', event.error);
  }
  assert.equal(observed, 3);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config);
});
