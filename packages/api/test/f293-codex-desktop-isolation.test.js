import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  CodexAgentService,
  codexConfigObjectFromArgs,
  stripReservedCodexSystemConfigs,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const conflictingConfigs = ['--enable=plugins', '-cfeatures.plugins=true'];

function selectedAccount(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'f293-selected-codex-')));
  const config = '[features]\nplugins=true\napps=true\n';
  writeFileSync(join(home, 'config.toml'), config);
  t.after(() => {
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), config);
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function assertIsolation(args, env, home, apps) {
  const config = codexConfigObjectFromArgs(args);
  assert.equal(config.features?.plugins, false, 'desktop plugins must be disabled');
  assert.equal(config.features?.apps, apps, 'ordinary calls must retain native Apps preferences');
  assert.equal(env.CODEX_HOME, home, 'selected account home must remain intact');
  assert.equal(args.includes('--ignore-user-config'), false, 'ordinary calls retain account configuration');
  return config;
}

test('member CLI arguments cannot revive desktop plugins', () => {
  assert.deepEqual(
    stripReservedCodexSystemConfigs([...conflictingConfigs, '--config', 'features.web_search=true'], 'codex61-sol'),
    ['--config', 'features.web_search=true'],
  );
});

for (const apps of [undefined, true, false])
  for (const sessionId of [undefined, 'fixture-session']) {
    test(`exec desktop isolation preserves MCP and account on ${sessionId ? 'resume' : 'start'} (apps=${apps})`, async (t) => {
      const home = selectedAccount(t);
      let launch;
      const spawnFn = (_command, args, options) => {
        launch = { args, ...options };
        const proc = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          stdin: new PassThrough(),
          pid: 12345,
          exitCode: null,
          kill() {},
        });
        setImmediate(() => {
          proc.stdout.end(
            `${[
              { type: 'thread.started', thread_id: 'fixture-session' },
              { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } },
            ]
              .map((event) => JSON.stringify(event))
              .join('\n')}\n`,
          );
          proc.emit('exit', 0);
          proc.emit('close', 0);
        });
        return proc;
      };
      const service = new CodexAgentService({
        catId: 'codex61-sol',
        model: 'gpt-6.1-sol',
        cliCommand: process.execPath,
        spawnFn,
        l0CompilerFn: fakeL0Compiler,
      });
      for await (const _event of service.invoke('hello', {
        sessionId,
        cliConfigArgs: [...conflictingConfigs, ...(apps === undefined ? [] : ['--config', `features.apps=${apps}`])],
        accountEnv: { CODEX_HOME: home },
        callbackEnv: { CODEX_AUTH_MODE: 'oauth' },
      })) {
      }
      assert.ok(launch, 'the native launch must be reached');
      const config = assertIsolation(launch.args, launch.env, home, apps);
      assert.ok(config.mcp_servers?.['cat-cafe']?.command, 'explicit Clowder AI MCP remains configured');
    });
  }

for (const apps of [undefined, true, false])
  for (const pooled of [false, true]) {
    test(`app-server desktop isolation preserves account (${pooled ? 'pooled' : 'direct'}, apps=${apps})`, async (t) => {
      const home = selectedAccount(t);
      let launch;
      const capture = async (options) => {
        launch = options;
        throw new Error('fixture-stop-after-launch');
      };
      const service = new CodexAgentService({
        catId: 'codex61-sol',
        model: 'gpt-6.1-sol',
        cliCommand: process.execPath,
        carrierMode: 'app_server',
        l0CompilerFn: fakeL0Compiler,
        ...(pooled ? { appServerHostPool: { createSession: capture } } : {}),
      });
      for await (const _event of service.invoke('hello', {
        cliConfigArgs: [...conflictingConfigs, ...(apps === undefined ? [] : ['--config', `features.apps=${apps}`])],
        accountEnv: { CODEX_HOME: home },
        callbackEnv: { CODEX_AUTH_MODE: 'oauth' },
        ...(pooled ? {} : { agentCarrierSessionFactory: capture }),
      })) {
      }
      assert.ok(launch, 'the native launch must be reached');
      assertIsolation(launch.args, launch.env, home, apps);
    });
  }

test('native capability probes use the same isolated tool surface and selected account', async (t) => {
  const home = selectedAccount(t);
  let launch;
  const service = new CodexAgentService({
    catId: 'codex61-sol',
    model: 'gpt-6.1-sol',
    cliCommand: process.execPath,
    carrierMode: 'app_server',
    appServerHostPool: {
      createSession: async (options) => {
        launch = options;
        throw new Error('fixture-stop-after-launch');
      },
    },
  });
  await assert.rejects(
    service.requestNativeCapabilitySource({
      invocationId: 'fixture-capability',
      timeoutMs: 5000,
      cwd: process.cwd(),
      account: { id: 'fixture', client: 'openai', authType: 'oauth', envVars: { CODEX_HOME: home } },
      cliConfigArgs: conflictingConfigs,
    }),
    /fixture-stop-after-launch/,
  );
  assert.ok(launch);
  assertIsolation(launch.args, launch.env, home);
});

for (const pooled of [false, true]) {
  test(`thread RPC keeps desktop isolation and Clowder AI MCP (${pooled ? 'pooled' : 'direct'})`, async (t) => {
    const home = selectedAccount(t);
    const fixture = wireFixture();
    const originalWrite = fixture.wire.write;
    fixture.wire.write = async (message) => {
      if (message.method === 'configRequirements/read') {
        fixture.push({ id: message.id, result: { requirements: null } });
      } else if (message.method === 'account/read') {
        fixture.push({ id: message.id, result: { account: { type: 'chatgpt' } } });
      } else await originalWrite(message);
    };
    const capture = async (launch) => {
      assertIsolation(launch.args, launch.env, home);
      return fixture.wire;
    };
    const service = new CodexAgentService({
      catId: 'codex61-sol',
      model: 'gpt-6.1-sol',
      cliCommand: process.execPath,
      carrierMode: 'app_server',
      l0CompilerFn: fakeL0Compiler,
      ...(pooled ? { appServerHostPool: { createSession: capture } } : {}),
    });
    const errors = [];
    for await (const event of service.invoke('hello', {
      accountEnv: { CODEX_HOME: home },
      callbackEnv: { CODEX_AUTH_MODE: 'oauth' },
      ...(pooled ? {} : { agentCarrierSessionFactory: capture }),
    }))
      if (event.type === 'error') errors.push(event.error);
    assert.deepEqual(errors, []);
    const config = fixture.writes.find((message) => message.method === 'thread/start')?.params.config;
    assert.deepEqual(config?.features, { plugins: false });
    if (pooled) assert.ok(config.mcp_servers, 'per-thread MCP config remains in the RPC overlay');
  });
}

for (const flag of [
  '--enable',
  '--enable=apps',
  '--disable',
  '--disable=apps',
  '--config',
  '--config=features.apps=true',
  '-c',
  '-cfeatures.apps=false',
]) {
  test(`member native Apps preference survives ${flag}`, () => {
    const args =
      flag === '--enable' || flag === '--disable'
        ? [flag, 'apps']
        : flag === '--config' || flag === '-c'
          ? [flag, 'features.apps=true']
          : [flag];
    assert.deepEqual(stripReservedCodexSystemConfigs(args, 'codex61-sol'), args);
  });
}
