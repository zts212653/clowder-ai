import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-scoped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = {
    name: 'scope.game',
    command: process.execPath,
    args: ['/fixture/game.mjs'],
    env: {},
    workingDirectory: root,
    transport: 'stdio' as const,
  };
  const options: AgentServiceOptions = {
    workingDirectory: root,
    signal: new AbortController().signal,
    executionAccount: {
      accountRef: 'existing',
      displayName: 'Existing',
      authType: 'api_key',
      accountRevision: 'a'.repeat(64),
    },
    accountEnv: { ANTHROPIC_API_KEY: 'fixture-selected-key' },
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'installed',
      contributionId: 'player',
      memberSession: { sessionId: 'member', generation: 1, executionId: 'event' },
    },
    pluginNativeLaunch: {
      server,
      sandbox: { kind: 'scoped-member', workspaceRoot: root },
      assertCurrent: async () => {},
    },
  };
  return { root, options, server };
}

test('the real SDK carrier advertises the bounded member capability without changing its ordinary carrier', () => {
  const service = new ClaudeSdkAgentService({ catId: createCatId('opus'), model: 'claude-opus-5-5' });
  assert.equal(
    service.supportsToolExecutionPolicy({
      mode: 'plugin_native',
      pluginInstanceId: 'p',
      contributionId: 'c',
      memberSession: { sessionId: 's', generation: 1, executionId: 'e' },
    }),
    true,
  );
  assert.equal(
    service.supportsToolExecutionPolicy({ mode: 'plugin_native', pluginInstanceId: 'p', contributionId: 'c' }),
    false,
  );
  assert.equal(service.freshnessCarrierCapability().carrier, 'claude_agent_sdk');
});

test('SDK preparation freezes the selected account and exact admitted MCP before awaiting scoped identity', async (t) => {
  const f = await fixture(t);
  let compiled: unknown;
  const launch = await prepareClaudeSdkLaunch({
    catId: createCatId('opus'),
    model: 'claude-opus-5-5',
    prompt: 'APPROVED_LOCAL_EVENT',
    abortController: new AbortController(),
    options: { ...f.options, sessionId: 'home-session', cliConfigArgs: ['--tools', 'Bash'] },
    l0CompilerFn: async (input) => {
      compiled = input;
      assert.ok(f.options.accountEnv);
      f.options.accountEnv.ANTHROPIC_API_KEY = 'changed';
      f.server.args[0] = '/outside/replacement.mjs';
      return 'SCOPED_IDENTITY';
    },
  });
  const sdk = launch.sdkOptions;
  assert.equal((compiled as { projection: string }).projection, 'scoped-member');
  assert.equal(launch.model, 'claude-opus-5-5');
  assert.deepEqual(sdk.tools, []);
  assert.deepEqual(sdk.allowedTools, ['mcp__scope_game__*']);
  assert.deepEqual(sdk.settingSources, []);
  assert.equal(sdk.resume, undefined);
  assert.equal(sdk.permissionMode, 'default');
  assert.equal(sdk.persistSession, false);
  assert.equal(sdk.env?.ANTHROPIC_API_KEY, 'fixture-selected-key');
  assert.equal(sdk.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  const path = sdk.extraArgs?.['mcp-config'];
  assert.ok(typeof path === 'string');
  const servers = JSON.parse(readFileSync(path, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['scope.game']);
  assert.equal(servers['scope.game'].args[0], '/fixture/game.mjs');
  assert.equal(JSON.parse(sdk.settings as string).disableAllHooks, true);
  assert.equal(sdk.extraArgs?.chrome, undefined);
  assert.ok(sdk.extraArgs && Object.hasOwn(sdk.extraArgs, 'disable-slash-commands'));
});

test('revocation while recording an actual SDK launch prevents the query boundary', async (t) => {
  const f = await fixture(t);
  let revoked = false,
    queries = 0;
  assert.ok(f.options.pluginNativeLaunch);
  f.options.pluginNativeLaunch.assertCurrent = async () => {
    if (revoked) throw new Error('owner_revoked');
  };
  const service = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-5-5',
    l0CompilerFn: async () => 'SCOPED_IDENTITY',
    queryFn: () => {
      queries++;
      throw new Error('unexpected_query');
    },
  });
  const events = [];
  for await (const event of service.invoke('event', {
    ...f.options,
    beforeProviderLaunch: async () => {
      revoked = true;
    },
  }))
    events.push(event);
  assert.equal(queries, 0);
  assert.ok(events.some((event) => event.error?.includes('owner_revoked')));
});
