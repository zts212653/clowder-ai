import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  CodexAgentService,
  codexConfigObjectFromArgs,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

test('read-only exec retains the Apps fence even when member config requests Apps', async () => {
  let launch;
  const service = new CodexAgentService({
    model: 'gpt-6.1-sol',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    spawnFn: (_command, args, options) => {
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
          `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
        );
        proc.emit('exit', 0);
        proc.emit('close', 0);
      });
      return proc;
    },
  });
  for await (const _event of service.invoke('read-only probe', {
    cliConfigArgs: ['--enable', 'apps'],
    toolExecutionPolicy: { mode: 'read_only' },
  })) {
  }
  const config = codexConfigObjectFromArgs(launch.args);
  assert.equal(config.features.apps, false);
  assert.equal(config.features.plugins, false);
  assert.equal(config.apps._default.enabled, false);
  assert.ok(launch.args.includes('--ignore-user-config'));
});

test('Live thread cannot revive Apps through its configure result', async () => {
  const fixture = wireFixture();
  const write = fixture.wire.write;
  fixture.wire.write = async (message) => {
    if (message.method === 'configRequirements/read') fixture.push({ id: message.id, result: { requirements: null } });
    else if (message.method === 'account/read')
      fixture.push({ id: message.id, result: { account: { type: 'chatgpt' } } });
    else await write(message);
  };
  let launch;
  let finish;
  const service = new CodexAgentService({
    model: 'gpt-6.1-sol',
    cliCommand: process.execPath,
    carrierMode: 'app_server',
    l0CompilerFn: fakeL0Compiler,
  });
  const errors = [];
  for await (const event of service.invoke('Live probe', {
    callbackEnv: {},
    agentCarrierSessionFactory: async (options) => {
      launch = options;
      return fixture.wire;
    },
    liveCompanion: {
      configure: async () => ({ mcp_servers: {}, features: { apps: true } }),
      finished: new Promise((resolve) => {
        finish = resolve;
      }),
      ready: async () => finish(),
      observe: async () => {},
    },
  }))
    if (event.type === 'error') errors.push(event.error);
  assert.deepEqual(errors, []);
  assert.equal(codexConfigObjectFromArgs(launch.args).features.apps, false);
  const config = fixture.writes.find((message) => message.method === 'thread/start').params.config;
  assert.equal(config.features.apps, false);
  assert.equal(config.features.plugins, false);
});
