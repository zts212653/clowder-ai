import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeOpeningCapsuleRevision } from '../dist/domains/cats/services/agents/invocation/request-generation-capsule-source.js';
import { directMcpContract } from './helpers/direct-mcp-contract.js';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);

function fixture(
  l0CompilerFn = async () => '# Identity\nYou are F325-TEST-CAT.\n',
  profilePatch = {},
  servicePatch = {},
) {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-service-'));
  const workspace = join(base, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
      ...profilePatch,
    },
    command: '/usr/bin/true',
    l0CompilerFn,
    ...servicePatch,
  });
  return { base, workspace, service, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function geminiDir(launch) {
  const flag = launch.args.find((arg) => arg.startsWith('--gemini_dir='));
  assert.ok(flag, 'the invocation must select its own native configuration');
  return flag.slice('--gemini_dir='.length);
}

function fakeEvents(agentName, cwd, conversationId, response, deniedActions = []) {
  return [
    {
      event: 'init',
      conversation_id: conversationId,
      init: { cwd, agent: agentName, model: 'gemini-3.8-flash-high', permission_mode: 'request-review', tools: [] },
    },
    {
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'SUCCESS',
        response,
        denied_actions: deniedActions,
        num_turns: 1,
      },
    },
  ];
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('F325 one-turn native AGY carrier', () => {
  test('normal MCP discovery uses project capabilities, identity env and per-turn credentials', async () => {
    const f = fixture();
    mkdirSync(join(f.workspace, '.cat-cafe'));
    writeFileSync(
      join(f.workspace, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [
          {
            id: 'cat-cafe-memory',
            type: 'mcp',
            source: 'cat-cafe',
            enabled: true,
            mcpServer: { command: 'node', args: [] },
          },
          {
            id: 'cat-cafe-limb',
            type: 'mcp',
            source: 'cat-cafe',
            enabled: true,
            mcpServer: { command: 'node', args: [] },
          },
          {
            id: 'cat-cafe-finance',
            type: 'mcp',
            source: 'cat-cafe',
            blockedCats: ['gemini38'],
            mcpServer: { command: 'node', args: [] },
          },
          {
            id: 'project-fixture',
            type: 'mcp',
            source: 'external',
            enabled: true,
            mcpServer: { command: '/usr/bin/true', args: ['--fixture'] },
          },
        ],
      }),
    );
    let servers;
    let credential;
    let currentAuth;
    try {
      const events = await collect(
        f.service.invoke('Use the tools enabled for this project.', {
          workingDirectory: f.workspace,
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'discovery-inv',
            CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
            CAT_CAFE_CAT_ID: 'gemini38',
            CAT_CAFE_THREAD_ID: 'discovery-thread',
            CAT_CAFE_USER_ID: 'owner',
          },
          spawnCliOverride: async function* (launch) {
            servers = JSON.parse(readFileSync(join(geminiDir(launch), 'config/mcp_config.json'), 'utf8')).mcpServers;
            credential = servers['cat-cafe-memory']?.env.CAT_CAFE_CREDENTIAL_FILE;
            const stored = JSON.parse(readFileSync(credential, 'utf8'));
            currentAuth = stored.invocationId === 'discovery-inv' && stored.callbackToken === 'fixture-token';
            yield* fakeEvents(
              launch.args[launch.args.indexOf('--agent') + 1],
              launch.cwd,
              'discovery-session',
              'Done.',
            );
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
      assert.deepEqual(Object.keys(servers).sort(), ['cat-cafe-limb', 'cat-cafe-memory', 'project-fixture']);
      assert.equal(currentAuth, true, 'the per-turn file must hold the current invocation credentials before spawn');
      for (const entry of ['memory', 'limb']) {
        const { launchEnv, upstream } = directMcpContract(servers[`cat-cafe-${entry}`]);
        assert.equal(upstream.command, process.execPath);
        assert.deepEqual(upstream.args, [fileURLToPath(new URL(`../../mcp-server/dist/${entry}.js`, import.meta.url))]);

        assert.equal(upstream.env.ALLOWED_WORKSPACE_DIRS, process.env.ALLOWED_WORKSPACE_DIRS?.trim() || f.workspace);
        assert.equal(
          launchEnv.ALLOWED_WORKSPACE_DIRS,
          upstream.env.ALLOWED_WORKSPACE_DIRS,
          'secret protection must inspect the same admitted workspace as the upstream reader',
        );
        for (const env of [launchEnv, upstream.env]) {
          assert.equal(env.CAT_CAFE_API_URL, 'http://127.0.0.1:3012');
          assert.equal(env.CAT_CAFE_CAT_ID, 'gemini38');
          assert.equal(env.CAT_CAFE_THREAD_ID, 'discovery-thread');
          assert.equal(env.CAT_CAFE_USER_ID, 'owner');
          assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, credential);
          assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
          assert.equal(env.CAT_CAFE_INVOCATION_ID, undefined);
        }
      }
      const { launchEnv, upstream } = directMcpContract(servers['project-fixture']);
      assert.equal(upstream.command, '/usr/bin/true');
      assert.deepEqual(upstream.args, ['--fixture']);

      assert.deepEqual(upstream.env, {}, 'external tools must not inherit host callback authority');
      assert.equal(launchEnv.CAT_CAFE_CREDENTIAL_FILE, undefined);
      assert.equal(launchEnv.CAT_CAFE_CALLBACK_TOKEN, undefined);
      assert.equal(launchEnv.CAT_CAFE_INVOCATION_ID, undefined);
      assert.ok(credential && !existsSync(credential), 'terminal cleanup retires the exact credential');
    } finally {
      f.cleanup();
    }
  });

  test('every normal native launch installs the host target guard before any tool can execute', async () => {
    for (const autoApprove of [false, true]) {
      const f = fixture(undefined, { autoApprove });
      let installed;
      try {
        const events = await collect(
          f.service.invoke('Do ordinary project work.', {
            workingDirectory: f.workspace,
            spawnCliOverride: async function* (launch) {
              const path = join(geminiDir(launch), 'config/hooks.json');
              installed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
              const frames = fakeEvents(
                launch.args[launch.args.indexOf('--agent') + 1],
                launch.cwd,
                'guarded-session',
                'Done.',
              );
              frames[0].init.permission_mode = autoApprove ? 'always-proceed' : 'request-review';
              yield* frames;
            },
          }),
        );
        assert.equal(events.at(-1).errorCode, undefined);
        const group = installed?.['cat-cafe-native-effect']?.PreToolUse?.[0];
        assert.equal(group?.matcher, '*', 'the provider must not execute tools outside host guard observation');
        assert.match(group.hooks[0].command, /agy-native-effect-guard\.mjs/);
        assert.ok(group.hooks[0].timeout > 0);
      } finally {
        f.cleanup();
      }
    }
  });

  for (const [directory, name] of [
    ['.agents', 'hooks.json'],
    ['.agents', 'agents'],
    ['.agents', 'plugins'],
    ['.agents', 'skills.json'],
    ['.agents', 'mcp_config.json'],
    ['.Agents', 'MCP_CONFIG.JSON'],
  ]) {
    for (const withSensitiveFile of [false, true]) {
      test(`autoApprove refuses ${directory}/${name}${withSensitiveFile ? ' alongside .env' : ''} before spawn`, async () => {
        const f = fixture(undefined, { autoApprove: true });
        const customization = join(f.workspace, directory, name);
        mkdirSync(join(f.workspace, directory));
        if (['agents', 'plugins'].includes(name)) mkdirSync(customization);
        else writeFileSync(customization, '{}');
        if (withSensitiveFile) writeFileSync(join(f.workspace, '.env'), 'FIXTURE_ONLY=yes\n');
        let spawned = false;
        try {
          const events = await collect(
            f.service.invoke('Hello.', {
              workingDirectory: f.workspace,
              spawnCliOverride: async function* (launch) {
                spawned = true;
                const agent = launch.args[launch.args.indexOf('--agent') + 1];
                const frames = fakeEvents(agent, launch.cwd, 'unexpected-customized-session', 'Hello.');
                frames[0].init.permission_mode = 'always-proceed';
                yield* frames;
              },
            }),
          );
          assert.equal(spawned, false, JSON.stringify(events));
          assert.equal(events.at(-1).errorCode, 'AGY_WORKSPACE_CUSTOMIZATION');
          assert.ok(events.find((event) => event.type === 'error').error.includes(name));
        } finally {
          f.cleanup();
        }
      });
    }
  }

  test('explicit autoApprove launches a normal repository with official bypass mode and native commands', async () => {
    const f = fixture(undefined, { autoApprove: true, trustedWorkspaces: [] });
    writeFileSync(join(f.workspace, '.env'), 'FIXTURE_ONLY=yes\n');
    let launch, body;
    try {
      const events = await collect(
        f.service.invoke('Say hello.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (options) {
            launch = options;
            const agent = options.args[options.args.indexOf('--agent') + 1];
            body = readFileSync(join(geminiDir(options), 'config/agents', agent, 'agent.md'), 'utf8');
            const frames = fakeEvents(agent, options.cwd, 'auto-approved-session', 'Hello.');
            frames[0].init.permission_mode = 'always-proceed';
            yield* frames;
          },
        }),
      );
      assert.ok(launch, JSON.stringify(events));
      assert.ok(launch.args.includes('--dangerously-skip-permissions'));
      assert.ok(!launch.args.includes('--sandbox'));
      assert.equal(launch.inheritParentEnv, false);
      assert.equal(launch.env.CAT_CAFE_AGENT_KEY_SECRET, null);
      assert.match(body, / {2}- run_command\n/);
      assert.ok(!body.includes('commandExecutionPolicy: off'));
      const settings = JSON.parse(readFileSync(join(launch.env.HOME, '.gemini/antigravity-cli/settings.json')));
      assert.equal(settings.toolPermission, 'request-review', 'shared settings never become a different turn policy');
      assert.equal(settings.enableTerminalSandbox, true);
      assert.deepEqual(settings.permissions.deny, []);
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
    } finally {
      f.cleanup();
    }
  });

  test('permission changes require an explicit new session; matching durable bindings resume', async () => {
    const f = fixture(undefined, { autoApprove: true, trustedWorkspaces: [] });
    const launches = [];
    const options = {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        launches.push(launch);
        const agent = launch.args[launch.args.indexOf('--agent') + 1];
        const resumeIndex = launch.args.indexOf('--conversation');
        const id = resumeIndex < 0 ? `mode-${launches.length}` : launch.args[resumeIndex + 1];
        const frames = fakeEvents(agent, launch.cwd, id, 'OK');
        frames[0].init.permission_mode = launch.args.includes('--dangerously-skip-permissions')
          ? 'always-proceed'
          : 'request-review';
        yield* frames;
      },
    };
    try {
      const first = await collect(f.service.invoke('Automatic.', options));
      assert.equal(first.at(-1).errorCode, undefined);
      const mismatch = await collect(
        f.service.invoke('Read only.', {
          ...options,
          sessionId: 'mode-1',
          nativeSessionBinding: first[0].nativeSessionBinding,
          toolExecutionPolicy: { mode: 'read_only' },
        }),
      );
      assert.equal(mismatch.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, 1);
      const readonly = await collect(
        f.service.invoke('Read only.', {
          ...options,
          toolExecutionPolicy: { mode: 'read_only' },
        }),
      );
      assert.equal(readonly.at(-1).errorCode, undefined);
      assert.ok(launches[1].args.includes('--sandbox'));
      assert.ok(!launches[1].args.includes('--dangerously-skip-permissions'));
      assert.ok(!launches[1].args.includes('--conversation'), 'a permissive session cannot be resumed as read-only');
      const resumed = await collect(
        f.service.invoke('Read only again.', {
          ...options,
          sessionId: 'mode-2',
          nativeSessionBinding: readonly[0].nativeSessionBinding,
          toolExecutionPolicy: { mode: 'read_only' },
        }),
      );
      assert.equal(resumed.at(-1).errorCode, undefined);
      assert.ok(launches[2].args.includes('--conversation'), 'same-mode sessions still resume');
    } finally {
      f.cleanup();
    }
  });

  test('an automatic launch rejects a provider claiming the restricted permission mode', async () => {
    const f = fixture(undefined, { autoApprove: true });
    try {
      const events = await collect(
        f.service.invoke('Hello.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            yield* fakeEvents(agent, launch.cwd, 'wrong-mode', 'OK');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events.find((e) => e.type === 'error').error, /permission mode/);
    } finally {
      f.cleanup();
    }
  });

  test('read_only can enter an ordinary repository while keeping writes and MCP unavailable', async () => {
    const f = fixture(undefined, { autoApprove: true, trustedWorkspaces: [] });
    writeFileSync(join(f.workspace, '.env'), 'FIXTURE_ONLY=yes');
    let launch, hooks, body, mcp;
    try {
      const events = await collect(
        f.service.invoke('Read only.', {
          workingDirectory: f.workspace,
          toolExecutionPolicy: { mode: 'read_only' },
          spawnCliOverride: async function* (options) {
            launch = options;
            hooks = JSON.parse(readFileSync(join(geminiDir(options), 'config/hooks.json'), 'utf8'));
            mcp = JSON.parse(readFileSync(join(geminiDir(options), 'config/mcp_config.json'), 'utf8'));
            const agent = options.args[options.args.indexOf('--agent') + 1];
            body = readFileSync(join(geminiDir(options), 'config/agents', agent, 'agent.md'), 'utf8');
            yield* fakeEvents(
              options.args[options.args.indexOf('--agent') + 1],
              options.cwd,
              'read-only-session',
              'Read.',
            );
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
      assert.ok(launch.args.includes('--sandbox'));
      assert.ok(!launch.args.includes('--dangerously-skip-permissions'));
      const settings = JSON.parse(readFileSync(join(launch.env.HOME, '.gemini/antigravity-cli/settings.json'), 'utf8'));
      assert.equal(settings.toolPermission, 'request-review');
      assert.equal(settings.allowNonWorkspaceAccess, false);
      assert.deepEqual(mcp.mcpServers, {});
      assert.doesNotMatch(body, / {2}- (?:run_command|write_to_file|call_mcp_tool)\n/);
      const guardCommand = hooks['cat-cafe-native-effect'].PreToolUse[0].hooks[0].command;
      assert.ok(guardCommand.endsWith(`'read-only' '${launch.env.HOME}'`), guardCommand);
    } finally {
      f.cleanup();
    }
  });

  test('compiles owner-bound L0 independently of caller prepend and resume fallback', async () => {
    const calls = [];
    const f = fixture(async (options) => {
      calls.push(options);
      return '# Identity\nHOST-COMPILED-NATIVE-L0\n## 主人画像\n\n先讲结果。';
    });
    try {
      let prepared;
      const events = await collect(
        f.service.invoke('Answer the task.', {
          workingDirectory: f.workspace,
          systemPrompt: 'DYNAMIC-PACK-PREPEND',
          resumeFallbackSystemPrompt: 'DYNAMIC-PACK-RESUME',
          callbackEnv: {
            CAT_CAFE_USER_ID: 'owner-native',
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'l0-inv',
            CAT_CAFE_CALLBACK_TOKEN: 'fixture-l0-token',
          },
          beforeProviderLaunch: async (request) => {
            prepared = request;
          },
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            yield* fakeEvents(agent, launch.cwd, 'compiled-l0-session', 'OK');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined);
      assert.equal(f.service.injectsL0Natively(), true);
      assert.deepEqual(calls, [{ catId: 'gemini38', userId: 'owner-native', projection: 'owner' }]);
      assert.match(prepared.nativeInstructions[0].body, /HOST-COMPILED-NATIVE-L0/);
      assert.ok(!prepared.nativeInstructions[0].body.includes('DYNAMIC-PACK'));
      assert.equal(
        nativeOpeningCapsuleRevision(prepared, { mode: 'cold' }, 'owner-native', {
          readCapsule: () => ({ content: '先讲结果。', revision: 'sha256:agy-opening' }),
        }),
        'sha256:agy-opening',
        'the actual AGY agent-file instructions must preserve their capsule source',
      );
    } finally {
      f.cleanup();
    }
  });

  test('fails closed before AGY starts when canonical L0 compilation fails', async () => {
    const f = fixture(async () => {
      throw new Error('canonical L0 unavailable');
    });
    try {
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: 'A caller prepend cannot substitute for native L0.',
          spawnCliOverride: async function* () {
            spawned = true;
          },
        }),
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events[0].error, /canonical L0 unavailable/);
    } finally {
      f.cleanup();
    }
  });

  test('requires an explicit resolved workspace instead of inheriting the API process cwd', async () => {
    const f = fixture();
    try {
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.match(events[0].error, /explicit.*workingDirectory/i);
    } finally {
      f.cleanup();
    }
  });

  test('refuses a workspace outside the operator trusted list before AGY starts', async () => {
    const f = fixture();
    try {
      const other = join(f.base, 'other');
      mkdirSync(other);
      for (const trustedWorkspaces of [[], [other]]) {
        const service = new AgyNativeAgentService({
          catId: 'gemini38',
          profile: {
            enabled: true,
            profileId: 'gemini38',
            homeRoot: join(f.base, 'profiles'),
            model: 'gemini-3.8-flash-high',
            trustedWorkspaces,
          },
          command: '/usr/bin/true',
          l0CompilerFn: async () => '# Identity\nF325.\n',
        });
        for (const toolExecutionPolicy of [undefined, { mode: 'read_only' }]) {
          let spawned = false;
          const events = await collect(
            service.invoke('Read.', {
              workingDirectory: f.workspace,
              systemPrompt: '# Identity\nF325.\n',
              ...(toolExecutionPolicy ? { toolExecutionPolicy } : {}),
              spawnCliOverride: async function* () {
                spawned = true;
                yield* [];
              },
            }),
          );
          assert.equal(spawned, false);
          assert.match(events[0].error, /trusted workspace/i);
        }
      }
    } finally {
      f.cleanup();
    }
  });

  test('refuses an OAuth profile overlapping the model-readable workspace', async () => {
    const f = fixture();
    try {
      const service = new AgyNativeAgentService({
        catId: 'gemini38',
        profile: {
          enabled: true,
          profileId: 'gemini38',
          homeRoot: join(f.workspace, 'profiles'),
          model: 'gemini-3.8-flash-high',
          trustedWorkspaces: [f.workspace],
        },
        command: '/usr/bin/true',
        l0CompilerFn: async () => '# Identity\nF325.\n',
      });
      let spawned = false;
      const events = await collect(
        service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.equal(events[0].errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events[0].error, /profile HOME overlaps/i);
    } finally {
      f.cleanup();
    }
  });

  test('native launch ignores retired freshness hooks and preserves the original input', async () => {
    const f = fixture();
    try {
      assert.deepEqual(f.service.freshnessCarrierCapability(), {
        provider: 'google',
        carrier: 'agy_stream_json',
        deliverySemantics: 'queued_internal_turn',
        activeInvocationGuidance: 'supported',
      });
      const notice = { text: '📬 One new message. Read the current thread with cat_cafe_get_thread_context.' };
      const actions = [];
      const events = await collect(
        f.service.invoke('Continue the task.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'freshness-inv-1',
            CAT_CAFE_CALLBACK_TOKEN: 'freshness-token-1',
          },
          activeInvocationFreshness: {
            idle: {
              prepare: async () => {
                actions.push('prepare');
                return notice;
              },
              commitDelivered: async (value, result) => actions.push(['commit', value, result]),
              defer: () => actions.push('defer'),
              markMissed: async () => actions.push('missed'),
            },
          },
          spawnCliOverride: async function* (options) {
            assert.deepEqual(actions, []);
            const text = JSON.parse(options.stdinInput).message.content[0].text;
            assert.match(text, /^Continue the task\./);
            assert.doesNotMatch(text, /📬 One new message/);
            assert.ok(!text.includes('SECRET-MESSAGE-BODY'));
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-freshness-1', 'I will read it.');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined);
      assert.deepEqual(actions, []);
    } finally {
      f.cleanup();
    }
  });

  test('native launch failure never invokes retired freshness cleanup', async () => {
    const f = fixture();
    try {
      const actions = [];
      const events = await collect(
        f.service.invoke('Continue.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'freshness-inv-2',
            CAT_CAFE_CALLBACK_TOKEN: 'freshness-token-2',
          },
          activeInvocationFreshness: {
            idle: {
              prepare: async () => ({ text: '📬 One new message.' }),
              commitDelivered: async () => actions.push('commit'),
              defer: () => actions.push('defer'),
              markMissed: async () => actions.push('missed'),
            },
          },
          spawnCliOverride: async function* () {
            yield* [];
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.deepEqual(actions, []);
    } finally {
      f.cleanup();
    }
  });

  test('native denial and failure never invoke retired freshness cleanup', async () => {
    for (const outcome of ['denied', 'upstream-error']) {
      const f = fixture();
      try {
        const actions = [];
        const notice = { text: '📬 Read the current thread.' };
        const events = await collect(
          f.service.invoke('Continue.', {
            workingDirectory: f.workspace,
            systemPrompt: '# Identity\nF325.\n',
            callbackEnv: {
              CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
              CAT_CAFE_INVOCATION_ID: 'freshness-inv-failure',
              CAT_CAFE_CALLBACK_TOKEN: 'freshness-token-failure',
            },
            activeInvocationFreshness: {
              idle: {
                prepare: async () => {
                  actions.push('prepare');
                  return notice;
                },
                commitDelivered: async () => actions.push('commit'),
                defer: () => actions.push('defer'),
                markMissed: async () => actions.push('missed'),
              },
            },
            spawnCliOverride: async function* (options) {
              const agentName = options.args[options.args.indexOf('--agent') + 1];
              const records = fakeEvents(
                agentName,
                options.cwd,
                'agy-freshness-failed',
                '',
                outcome === 'denied' ? [{ action: 'view_file', display_name: 'view_file' }] : [],
              );
              if (outcome === 'upstream-error') records[1].result.status = 'ERROR';
              yield* records;
            },
          }),
        );
        assert.equal(events.at(-1).errorCode, outcome === 'denied' ? 'AGY_PERMISSION_DENIED' : 'AGY_NATIVE_FAILED');
        assert.deepEqual(actions, [], outcome);
      } finally {
        f.cleanup();
      }
    }
  });

  test('launches one native L0 session with isolated HOME, canonical tools, and typed final', async () => {
    const f = fixture();
    const previousProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://native-proxy.example:8080';
    try {
      let launch;
      let prepared;
      const events = await collect(
        f.service.invoke('Say hello.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nYou are F325-TEST-CAT.\n',
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'invocation-1',
            CAT_CAFE_CALLBACK_TOKEN: 'test-callback-token',
            CAT_CAFE_AGENT_KEY_FILES: 'must-not-inherit',
            F325_CALLBACK_EXTRA: 'fake-extra-secret',
          },
          beforeProviderLaunch: async (request) => {
            prepared = request;
            return { requestGenerationId: 'rg-1', generationOrdinal: 1, sessionId: 's-1' };
          },
          spawnCliOverride: async function* (options) {
            launch = options;
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-session-1', 'Hello from native AGY.\n');
          },
        }),
      );
      assert.equal(prepared.message.body, 'Say hello.');
      assert.equal(prepared.nativeInstructions.length, 1);
      assert.match(prepared.nativeInstructions[0].body, /F325-TEST-CAT/);
      assert.equal(prepared.runtime.protocol, 'stream-json');
      assert.equal(launch.env.HOME, realpathSync(join(f.base, 'profiles', 'gemini38')));
      assert.equal(launch.env.HTTPS_PROXY, 'http://native-proxy.example:8080');
      assert.equal(launch.env.GEMINI_API_KEY, null);
      assert.equal(launch.env.CAT_CAFE_AGENT_KEY_SECRET, null);
      assert.equal(launch.env.CAT_CAFE_AGENT_KEY_FILES, null);
      assert.equal(launch.env.CAT_CAFE_CREDENTIAL_FILE, null);
      assert.equal(launch.env.CAT_CAFE_CALLBACK_TOKEN, null);
      assert.equal(launch.env.CAT_CAFE_INVOCATION_ID, null);
      assert.equal(launch.env.F325_CALLBACK_EXTRA, undefined);
      assert.equal(launch.inheritParentEnv, false);
      assert.ok(launch.args.includes('--sandbox'));
      assert.ok(launch.args.includes('--input-format'));
      assert.ok(!launch.args.includes('-p'));
      assert.equal(JSON.parse(launch.stdinInput).message.content[0].text, 'Say hello.');
      assert.ok(!launch.args.includes('--dangerously-skip-permissions'));
      assert.ok(!launch.args.includes('run_command'));
      const settings = JSON.parse(
        readFileSync(join(launch.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'),
      );
      assert.deepEqual(settings.permissions.allow, ['mcp(*)']);
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'text', 'done'],
      );
      assert.equal(events[0].sessionId, 'agy-session-1');
      assert.equal(events[1].content, 'Hello from native AGY.\n');
      assert.equal(events[2].errorCode, undefined);
    } finally {
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
      f.cleanup();
    }
  });

  test('maps upstream SUCCESS with denied_actions to a terminal typed denial', async () => {
    const f = fixture();
    try {
      const events = await collect(
        f.service.invoke('Edit.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* (options) {
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-denied-1', '', [
              { action: 'write_file', display_name: 'write task.ts' },
            ]);
          },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'error', 'done'],
      );
      assert.equal(events[1].errorCode, 'AGY_PERMISSION_DENIED');
      assert.equal(events[2].errorCode, 'AGY_PERMISSION_DENIED');
    } finally {
      f.cleanup();
    }
  });

  test('reports cancellation before AGY init as a typed cancelled terminal', async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          signal: controller.signal,
          spawnCliOverride: async function* () {
            controller.abort();
            yield* [];
          },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events.at(-1).errorCode, 'AGY_CANCELLED');
    } finally {
      f.cleanup();
    }
  });

  test('keeps an observed successful result when stop arrives after the terminal event', async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          signal: controller.signal,
          spawnCliOverride: async function* (options) {
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-done-before-stop', 'Completed.');
            controller.abort();
          },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'text', 'done'],
      );
      assert.equal(events.at(-1).errorCode, undefined);
    } finally {
      f.cleanup();
    }
  });

  test('binds canonical MCP to a per-turn credential file that disappears after the turn', async () => {
    const f = fixture();
    try {
      let credentialPath;
      let config;
      const events = await collect(
        f.service.invoke('Read the current thread.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          requiredTools: ['cat-cafe-collab::cat_cafe_get_thread_context'],
          auditContext: {
            invocationId: 'inv-1',
            executionId: 'parent-execution',
            threadId: 'thread-1',
            catId: 'gemini38',
            userId: 'owner',
          },
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'inv-1',
            CAT_CAFE_CALLBACK_TOKEN: 'secret-1',
          },
          spawnCliOverride: async function* (options) {
            assert.equal(options.env.CAT_CAFE_CALLBACK_TOKEN, null);
            assert.equal(options.bindExecutionOwner, true);
            assert.equal(options.env.CAT_CAFE_INVOCATION_ID, 'inv-1');
            assert.equal(options.env.CAT_CAFE_EXECUTION_ID, 'parent-execution');
            assert.equal(options.env.CAT_CAFE_THREAD_ID, 'thread-1');
            assert.equal(options.env.CAT_CAFE_USER_ID, 'owner');
            assert.equal(options.env.CAT_CAFE_CAT_ID, 'gemini38');
            config = JSON.parse(readFileSync(join(geminiDir(options), 'config', 'mcp_config.json'), 'utf8'));
            credentialPath = config.mcpServers['cat-cafe-collab'].env.CAT_CAFE_CREDENTIAL_FILE;
            assert.deepEqual(JSON.parse(readFileSync(credentialPath, 'utf8')), {
              invocationId: 'inv-1',
              callbackToken: 'secret-1',
            });
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-mcp-1', 'Read complete.');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
      assert.ok(Object.hasOwn(config.mcpServers, 'cat-cafe-collab'));
      assert.ok(Object.hasOwn(config.mcpServers, 'cat-cafe-memory'));
      assert.ok(Object.hasOwn(config.mcpServers, 'cat-cafe-limb'));
      assert.ok(!JSON.stringify(config).includes('secret-1'));
      assert.throws(() => readFileSync(credentialPath, 'utf8'), /ENOENT/);
    } finally {
      f.cleanup();
    }
  });

  test('refuses executable workspace hooks before spawning AGY', async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.workspace, '.agents'));
      writeFileSync(join(f.workspace, '.agents', 'hooks.json'), '{}');
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events[0].errorCode, 'AGY_WORKSPACE_CUSTOMIZATION');
    } finally {
      f.cleanup();
    }
  });

  test('refuses an unvalidated MCP server in the isolated profile before spawn', async () => {
    const f = fixture();
    try {
      const configDir = join(f.base, 'profiles', 'gemini38', '.gemini', 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { rogue: { command: '/bin/echo' } } }),
      );
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.match(events[0].error, /MCP server is not host-owned/i);
    } finally {
      f.cleanup();
    }
  });
});

test('Native archives provider frames with invocation provenance and retains unknown event evidence', async () => {
  const archived = [];
  const f = fixture(
    undefined,
    {},
    {
      rawArchive: {
        append: async (id, payload) => archived.push({ id, payload }),
        getPath: (id) => `data/cli-raw-archive/${id}.ndjson`,
      },
    },
  );
  try {
    const events = await collect(
      f.service.invoke('Read the project.', {
        workingDirectory: f.workspace,
        invocationId: 'native-raw-test',
        spawnCliOverride: async function* (launch) {
          const frames = fakeEvents(
            launch.args[launch.args.indexOf('--agent') + 1],
            launch.cwd,
            'raw-session',
            'Done.',
          );
          yield frames[0];
          yield { event: 'future_observation', callbackToken: 'must-not-archive', detail: 'retain as unknown' };
          yield frames[1];
        },
      }),
    );
    assert.equal(archived.length, 3);
    assert.ok(archived.every((item) => item.id === 'native-raw-test'));
    assert.equal(archived[1].payload.callbackToken, '[redacted]');
    assert.deepEqual(events.at(-1).metadata.diagnostics.agyNative.unknownEvents, ['future_observation']);
    assert.equal(
      events.at(-1).metadata.diagnostics.agyNative.rawArchivePath,
      'data/cli-raw-archive/native-raw-test.ndjson',
    );
  } finally {
    f.cleanup();
  }
});

test('shared launch writes native AGY HTTP descriptors with original names and retires private headers', async () => {
  const f = fixture();
  let path;
  try {
    mkdirSync(join(f.workspace, '.cat-cafe'));
    writeFileSync(
      join(f.workspace, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'].map((name) => ({
          id: `cat-cafe-${name}`,
          type: 'mcp',
          source: 'cat-cafe',
          enabled: true,
          mcpServer: { command: 'node', args: [] },
        })),
      }),
    );
    const events = await collect(
      f.service.invoke('Owned HTTP launch control.', {
        workingDirectory: f.workspace,
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
          CAT_CAFE_INVOCATION_ID: 'owned-agy-A',
          CAT_CAFE_CALLBACK_TOKEN: 'owned-agy-token',
          CAT_CAFE_CAT_ID: 'gemini38',
          CAT_CAFE_THREAD_ID: 'owned-agy-thread',
          CAT_CAFE_USER_ID: 'owner',
          CAT_CAFE_MCP_TRANSPORT: 'shared',
        },
        spawnCliOverride: async function* (launch) {
          path = join(geminiDir(launch), 'config/mcp_config.json');
          const servers = JSON.parse(readFileSync(path, 'utf8')).mcpServers;
          assert.equal(Object.keys(servers).length, 6);
          for (const [name, server] of Object.entries(servers)) {
            assert.equal(server.command, undefined);
            assert.equal(new URL(server.serverUrl).searchParams.get('family'), name.slice('cat-cafe-'.length));
            assert.equal(server.headers['x-invocation-id'], 'owned-agy-A');
            assert.equal(server.headers['x-callback-token'], 'owned-agy-token');
          }
          assert.ok(!JSON.stringify({ args: launch.args, env: launch.env }).includes('owned-agy-token'));
          yield* fakeEvents(launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, 'owned-agy-session', 'Done.');
        },
      }),
    );
    assert.equal(
      events.some((x) => x.type === 'error'),
      false,
      JSON.stringify(events),
    );
    assert.ok(path && !existsSync(path), 'private native config follows the existing turn owner');
  } finally {
    f.cleanup();
  }
});
