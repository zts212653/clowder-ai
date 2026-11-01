import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { ClaudeAgentService } from '../src/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { captureClaudeMemberOptions } from '../src/domains/cats/services/agents/providers/claude-scoped-native.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'claude-scoped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = {
    name: 'scope_game',
    command: process.execPath,
    args: ['/fixture/game.mjs'],
    env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture-activation' },
    transport: 'stdio' as const,
    workingDirectory: root,
  };
  const options: AgentServiceOptions = {
    workingDirectory: root,
    signal: new AbortController().signal,
    accountEnv: { ANTHROPIC_API_KEY: 'fixture-selected-key' },
    executionAccount: {
      accountRef: 'existing-claude',
      displayName: 'Existing',
      authType: 'api_key',
      accountRevision: 'a'.repeat(64),
    },
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

test('Claude advertises only the bounded member form of plugin native execution', () => {
  const service = new ClaudeAgentService({ catId: createCatId('opus'), model: 'claude-opus-5-5' });
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
});

test('the actual Claude service freezes selected identity/account and exposes only the admitted MCP', async (t) => {
  const f = await fixture(t),
    proc = createMockProcess();
  f.server.name = 'scope.game';
  let compiled: unknown,
    launches = 0;
  const service = new ClaudeAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-5-5',
    l0CompilerFn: async (input) => {
      compiled = input;
      f.options.accountEnv!.ANTHROPIC_API_KEY = 'changed-after-await';
      f.server.args[0] = '/outside/replacement.mjs';
      await writeFile(input.outPath!, 'SCOPED_IDENTITY');
      return 'SCOPED_IDENTITY';
    },
    spawnFn: (_command, argv, spawn) => {
      launches++;
      const args = argv ?? [],
        value = (flag: string) => args[args.indexOf(flag) + 1];
      assert.equal(value('--model'), 'claude-opus-5-5');
      assert.equal(value('--tools'), '');
      assert.equal(value('--setting-sources'), '');
      assert.equal(value('--allowedTools'), 'mcp__scope_game__*');
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(args.includes('--no-chrome'));
      assert.ok(args.includes('--disable-slash-commands'));
      assert.ok(!args.includes('--resume') && !args.includes('--chrome') && !args.includes('--bare'));
      const mcp = JSON.parse(readFileSync(value('--mcp-config')!, 'utf8')).mcpServers;
      assert.deepEqual(Object.keys(mcp), ['scope.game']);
      assert.equal(mcp['scope.game'].args[0], '/fixture/game.mjs');
      const settings = JSON.parse(readFileSync(value('--settings')!, 'utf8'));
      assert.equal(settings.disableAllHooks, true);
      assert.equal(settings.autoMemoryEnabled, false);
      assert.equal(spawn!.env!.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
      assert.equal(spawn!.env!.ANTHROPIC_API_KEY, 'fixture-selected-key');
      return proc;
    },
  });
  const events: unknown[] = [];
  const collecting = (async () => {
    for await (const event of service.invoke('APPROVED_LOCAL_EVENT', {
      ...f.options,
      sessionId: 'outside',
      cliConfigArgs: ['--tools', 'Bash'],
    }))
      events.push(event);
  })();
  await emitEvents(proc, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'result', subtype: 'success', result: 'done' },
  ]);
  await collecting;
  assert.equal(launches, 1);
  assert.equal((compiled as { projection: string }).projection, 'scoped-member');
  assert.equal((compiled as { runtimeModel: string }).runtimeModel, 'claude-opus-5-5');
  assert.ok(events.length > 0);
});

test('owner revocation after provider recording prevents the actual Claude spawn', async (t) => {
  const f = await fixture(t);
  let revoked = false,
    launches = 0;
  f.options.pluginNativeLaunch!.assertCurrent = async () => {
    if (revoked) throw new Error('owner_revoked');
  };
  const service = new ClaudeAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-5-5',
    l0CompilerFn: async (input) => {
      await writeFile(input.outPath!, 'SCOPED_IDENTITY');
      return 'SCOPED_IDENTITY';
    },
    spawnFn: () => {
      launches++;
      throw new Error('must not launch');
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
  assert.equal(launches, 0);
  assert.ok(events.some((event) => event.error?.includes('owner_revoked')));
});

test('missing authority, public tools, malformed server names and inherited home context are refused', async (t) => {
  const f = await fixture(t);
  assert.throws(() => captureClaudeMemberOptions({ ...f.options, executionAccount: undefined }), /scoped_native/);
  assert.throws(() => captureClaudeMemberOptions({ ...f.options, systemPrompt: 'HOME_CONTEXT' }), /scoped_member/);
  assert.throws(() => captureClaudeMemberOptions({ ...f.options, pluginNativeLaunch: undefined }), /native_launch/);
  assert.throws(
    () =>
      captureClaudeMemberOptions({
        ...f.options,
        pluginNativeLaunch: { ...f.options.pluginNativeLaunch!, sandbox: { kind: 'public', workspaceRoot: f.root } },
      }),
    /scoped_member/,
  );
  f.server.name = 'scope*';
  assert.throws(() => captureClaudeMemberOptions(f.options), /native_server/);
});

test('selected OAuth token remains the existing account while ambient API credentials are cleared', async (t) => {
  const f = await fixture(t),
    proc = createMockProcess(),
    token = 'sk-ant-oat01-fixture-existing';
  const service = new ClaudeAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-5-5',
    l0CompilerFn: async (input) => {
      await writeFile(input.outPath!, 'SCOPED_IDENTITY');
      return 'SCOPED_IDENTITY';
    },
    spawnFn: (_command, args, spawn) => {
      assert.equal(spawn!.env!.CLAUDE_CODE_OAUTH_TOKEN, token);
      assert.equal(spawn!.env!.ANTHROPIC_API_KEY, undefined);
      assert.ok(!args!.includes('--bare'));
      return proc;
    },
  });
  const collecting = (async () => {
    for await (const _ of service.invoke('event', {
      ...f.options,
      executionAccount: { ...f.options.executionAccount!, authType: 'oauth' },
      claudeTokenAccount: true,
      accountEnv: { ANTHROPIC_API_KEY: 'ambient-other-account', CLAUDE_CODE_OAUTH_TOKEN: token },
    })) {
      /* consume existing carrier */
    }
  })();
  await emitEvents(proc, [{ type: 'result', subtype: 'success', result: 'done' }]);
  await collecting;
});
