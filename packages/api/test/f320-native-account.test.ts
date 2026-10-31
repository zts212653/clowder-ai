import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import {
  buildCodexAppServerArgs,
  CodexAgentService,
} from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import type { AgentCarrierSession } from '../src/domains/cats/services/types.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

class Wire implements AgentCarrierSession {
  writes: Record<string, unknown>[] = [];
  private values: unknown[] = [];
  private wake?: () => void;
  private closed = false;
  constructor(
    private config: Record<string, unknown>,
    private requirements: unknown = null,
    private account: unknown = { type: 'chatgpt' },
  ) {}
  async *read() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift();
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
  private push(value: unknown) {
    this.values.push(value);
    this.wake?.();
  }
  async write(message: Record<string, unknown>) {
    this.writes.push(message);
    if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === 'config/read') result = { config: this.config };
    if (message.method === 'configRequirements/read') result = { requirements: this.requirements };
    if (message.method === 'account/read') result = { account: this.account };
    if (message.method === 'thread/start') result = { thread: { id: 'fixture-thread', turns: [] } };
    if (message.method === 'turn/start') result = { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } };
    this.push({ id: message.id, result });
    if (message.method === 'turn/start')
      this.push({
        method: 'turn/completed',
        params: {
          threadId: 'fixture-thread',
          turn: { id: 'fixture-turn', status: 'completed', items: [] },
        },
      });
  }
  async close() {
    this.closed = true;
    this.wake?.();
  }
}

for (const scenario of [
  'valid',
  'valid-default',
  'chatgpt-endpoint',
  'managed-chatgpt-default',
  'managed-chatgpt-endpoint',
  'provider',
  'endpoint',
  'sqlite',
  'identity',
  'managed-provider',
  'managed-definition',
  'managed-path-uri',
] as const) {
  test(`actual service checks native ${scenario} before business RPC`, async (t) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'f320-native-config-')));
    t.after(() => rm(home, { recursive: true, force: true }));
    const config: Record<string, unknown> = { model_provider: 'openai', sqlite_home: home };
    if (scenario === 'provider') config.model_provider = 'custom';
    if (scenario === 'valid-default') config.chatgpt_base_url = 'https://chatgpt.com/backend-api/';
    if (scenario === 'chatgpt-endpoint') config.chatgpt_base_url = 'https://fixture.invalid/backend-api/';
    if (scenario === 'endpoint') config.openai_base_url = 'https://fixture.invalid';
    if (scenario === 'sqlite') config.sqlite_home = join(home, 'other');
    const requirements =
      scenario === 'managed-provider'
        ? { model_provider: 'custom' }
        : scenario === 'managed-definition'
          ? { model_providers: { openai: { base_url: 'https://fixture.invalid' } } }
          : scenario === 'managed-path-uri'
            ? { sqlite_home: pathToFileURL(home).href }
            : null;
    const constraints =
      scenario === 'managed-chatgpt-default'
        ? { chatgpt_base_url: 'https://chatgpt.com/backend-api/' }
        : scenario === 'managed-chatgpt-endpoint'
          ? { chatgpt_base_url: 'https://fixture.invalid/backend-api/' }
          : requirements;
    const wire = new Wire(config, constraints, scenario === 'identity' ? { type: 'apiKey' } : { type: 'chatgpt' });
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      rawArchive: { append: async () => {} },
    });
    const descriptor = resolveCodexAccountLaunch(
      { id: 'codex', authType: 'oauth', envVars: { CODEX_HOME: home } },
      { cwd: home },
    );
    const events = [];
    for await (const event of service.invoke('fixture', {
      invocationId: 'fixture',
      workingDirectory: home,
      codexAccountLaunch: descriptor,
      agentCarrierSessionFactory: async () => wire,
    }))
      events.push(event);
    const methods = wire.writes.map((message) => message.method);
    assert.equal(methods[0], 'initialize', JSON.stringify(events.filter((event) => event.type === 'error')));
    const business = methods.filter(
      (method) => method === 'thread/start' || method === 'turn/start' || method === 'model/list',
    );
    if (
      scenario !== 'valid' &&
      scenario !== 'valid-default' &&
      scenario !== 'managed-chatgpt-default' &&
      scenario !== 'managed-path-uri'
    ) {
      assert.deepEqual(business, [], 'a conflicting native observation must stop before thread/model/turn');
      assert.ok(events.some((event) => event.type === 'error'));
    } else {
      assert.deepEqual(methods.slice(0, 5), [
        'initialize',
        'initialized',
        'config/read',
        'configRequirements/read',
        'account/read',
      ]);
      assert.deepEqual(wire.writes.find((message) => message.method === 'account/read')?.params, {
        refreshToken: false,
      });
      assert.ok(
        business.includes('thread/start') && business.includes('turn/start'),
        JSON.stringify(events.filter((event) => event.type === 'error')),
      );
      assert.equal(events.filter((event) => event.type === 'error').length, 0);
      assert.ok(events.some((event) => event.type === 'done'));
    }
  });
}

test('app-server argv preserves every native config spelling and refuses unsupported v2 profiles', () => {
  for (const args of [['--config=x=1'], ['-cx=1'], ['-c=x=1'], ['-c', 'x=1']])
    assert.deepEqual(buildCodexAppServerArgs(args), ['app-server', '--stdio', '--config', 'x=1']);
  assert.throws(() => buildCodexAppServerArgs(['--profile', 'work']), /profile_unsupported/);
  assert.deepEqual(buildCodexAppServerArgs(['--enable=hooks', '--disable=apps']), [
    'app-server',
    '--stdio',
    '--enable',
    'hooks',
    '--disable',
    'apps',
  ]);
});
