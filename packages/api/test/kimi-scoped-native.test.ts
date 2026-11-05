import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { parse } from 'yaml';
import { KimiAgentService } from '../src/domains/cats/services/agents/providers/KimiAgentService.js';
import {
  assertKimiMemberAccount,
  captureKimiMemberOptions,
  prepareKimiMemberProfile,
} from '../src/domains/cats/services/agents/providers/kimi-scoped-native.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import { createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

const previousPath = process.env.PATH;
const cliDirectory = dirname(ensureFakeCliOnPath('kimi'));
assert.equal(dirname(cliDirectory), tmpdir());
after(async () => {
  process.env.PATH = previousPath;
  await rm(cliDirectory, { recursive: true, force: true });
});

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'kimi-scoped-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = {
    name: 'scope_game',
    command: process.execPath,
    args: ['/fixture/game.mjs'],
    env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture-activation' },
    workingDirectory: root,
    transport: 'stdio' as const,
  };
  const options: AgentServiceOptions = {
    workingDirectory: root,
    signal: new AbortController().signal,
    callbackEnv: { CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback' },
    accountEnv: {
      KIMI_MODEL_API_KEY: 'fixture-account-secret',
      KIMI_MODEL_BASE_URL: 'http://127.0.0.1:5189/v1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_NAME: 'fixture-model',
    },
    executionAccount: {
      accountRef: 'existing-api',
      displayName: 'Existing',
      authType: 'api_key',
      accountRevision: 'a'.repeat(64),
    },
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'game',
      memberSession: { sessionId: 'session', generation: 1, executionId: 'event' },
    },
    pluginNativeLaunch: {
      server,
      sandbox: { kind: 'scoped-member', workspaceRoot: root },
      assertCurrent: async () => {},
    },
  };
  return { root, options, server };
}

test('native member options capture credentials/descriptor and discard ordinary resume and CLI override paths', async (t) => {
  const f = await fixture(t);
  const scoped = captureKimiMemberOptions({
    ...f.options,
    sessionId: 'outside-session',
    cliSessionId: 'outside-cli',
    cliConfigArgs: ['--agent-file', '/outside/owner.md'],
  });
  assert.ok(scoped);
  f.options.accountEnv!.KIMI_MODEL_API_KEY = 'changed-after-capture';
  f.server.args[0] = '/outside/replacement.mjs';
  assert.equal(scoped.accountEnv?.KIMI_MODEL_API_KEY, 'fixture-account-secret');
  assert.equal(scoped.pluginNativeLaunch?.server.args[0], '/fixture/game.mjs');
  assert.equal(scoped.sessionId, undefined);
  assert.equal(scoped.cliSessionId, undefined);
  assert.equal(scoped.cliConfigArgs, undefined);
  assert.equal(captureKimiMemberOptions({ workingDirectory: f.root }), undefined);
});

test('the scoped profile exposes only the declared MCP and no base prompt, skills, subagents, credentials or login copy', async (t) => {
  const f = await fixture(t);
  const options = captureKimiMemberOptions(f.options)!;
  const profile = await prepareKimiMemberProfile({
    options,
    catId: 'kimi31-pro',
    l0: 'ACTUAL_SCOPED_IDENTITY',
    parentDirectory: f.root,
  });
  const home = profile.env.KIMI_CODE_HOME;
  const agent = await readFile(profile.agentFile, 'utf8');
  const frontmatter = parse(agent.split('---')[1]!);
  assert.deepEqual(frontmatter.tools, ['mcp__scope_game__*']);
  assert.deepEqual(frontmatter.subagents, []);
  assert.match(agent, /ACTUAL_SCOPED_IDENTITY/);
  assert.ok(!agent.includes('${base_prompt}'));
  const mcpText = await readFile(join(home, 'mcp.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(mcpText).mcpServers), ['scope_game']);
  assert.ok(!mcpText.includes('fixture-account-secret'));
  assert.ok(!agent.includes('fixture-account-secret'));
  assert.equal((await stat(home)).mode & 0o077, 0);
  assert.deepEqual(await readdir(profile.skillsDirectory), []);
  assert.ok(!(await readdir(home)).includes('credentials'));
  await profile.dispose();
  await assert.rejects(stat(home), /ENOENT/);
});

test('revocation during profile preparation cleans its owned directory and cannot return a launch', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  f.options.pluginNativeLaunch!.assertCurrent = async () => {
    if (++checks > 1) throw new Error('revoked');
  };
  await assert.rejects(
    prepareKimiMemberProfile({
      options: captureKimiMemberOptions(f.options)!,
      catId: 'kimi31-pro',
      l0: 'identity',
      parentDirectory: f.root,
    }),
    /revoked/,
  );
  assert.deepEqual(await readdir(f.root), []);
});

test('a missing port, wrong policy, broad MCP name or unverified OAuth combination refuses admission', async (t) => {
  const f = await fixture(t);
  assert.throws(() => captureKimiMemberOptions({ ...f.options, pluginNativeLaunch: undefined }), /native_launch/);
  assert.throws(
    () =>
      captureKimiMemberOptions({ ...f.options, toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] } }),
    /scoped_member/,
  );
  f.server.name = 'scope*';
  assert.throws(() => captureKimiMemberOptions(f.options), /native_server/);
  assert.throws(
    () => assertKimiMemberAccount({ ...f.options.executionAccount!, authType: 'oauth' }),
    /oauth_unavailable/,
  );
});

test('the real Kimi service uses scoped identity, frozen API environment and its private sole-MCP profile', async (t) => {
  const f = await fixture(t),
    proc = createMockProcess();
  let agent = '',
    home = '',
    skills = '',
    model = '',
    compiled: unknown;
  const service = new KimiAgentService({
    catId: createCatId('kimi'),
    model: 'fixture-model',
    l0CompilerFn: async (input) => {
      compiled = input;
      return 'ACTUAL_SCOPED_IDENTITY';
    },
    spawnFn: (_command, argv, spawnOptions) => {
      const args = argv ?? [];
      agent = readFileSync(args[args.indexOf('--agent-file') + 1]!, 'utf8');
      assert.ok(!args.includes('--session'));
      assert.ok(!args.includes('--model'));
      assert.ok(!args.includes('/outside/override.md'));
      skills = args[args.indexOf('--skills-dir') + 1]!;
      home = spawnOptions!.env!.KIMI_CODE_HOME!;
      model = spawnOptions!.env!.KIMI_MODEL_NAME!;
      assert.equal(spawnOptions!.env!.KIMI_MODEL_API_KEY, 'fixture-account-secret');
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers), [
        'scope_game',
      ]);
      return proc;
    },
  });
  const events: unknown[] = [];
  const collecting = (async () => {
    for await (const event of service.invoke('APPROVED_LOCAL_EVENT', {
      ...f.options,
      cliConfigArgs: ['--agent-file', '/outside/override.md'],
      sessionId: 'outside-session',
    }))
      events.push(event);
  })();
  await emitEvents(proc, [{ role: 'assistant', content: 'fixture response' }]);
  await collecting;
  assert.deepEqual(compiled, {
    frozenInput: undefined,
    requireFrozenInput: true,
    catId: 'kimi',
    userId: undefined,
    projection: 'scoped-member',
    runtimeModel: 'fixture-model',
  });
  assert.match(agent, /ACTUAL_SCOPED_IDENTITY/);
  assert.ok(!agent.includes('${base_prompt}'));
  assert.equal(model, 'fixture-model');
  assert.ok(skills);
  await assert.rejects(stat(home), /ENOENT/);
  assert.ok(events.length > 0);
});

test('revocation during beforeProviderLaunch prevents the real spawn boundary', async (t) => {
  const f = await fixture(t);
  let stopped = false,
    starts = 0;
  f.options.pluginNativeLaunch!.assertCurrent = async () => {
    if (stopped) throw new Error('owner_revoked');
  };
  const service = new KimiAgentService({
    catId: createCatId('kimi'),
    model: 'fixture-model',
    l0CompilerFn: async () => 'identity',
    spawnFn: () => {
      starts++;
      throw new Error('must not start');
    },
  });
  const events = [];
  for await (const event of service.invoke('local', {
    ...f.options,
    beforeProviderLaunch: async (request) => {
      assert.match(request.nativeInstructions[0]?.body ?? '', /mcp__scope_game__/);
      stopped = true;
    },
  }))
    events.push(event);
  assert.equal(starts, 0);
  assert.ok(events.some((event) => event.type === 'error' && event.error?.includes('owner_revoked')));
});
