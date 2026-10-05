import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);

function fixture(l0CompilerFn = async () => '# Identity\nYou are F325-TEST-CAT.\n') {
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
    },
    command: '/usr/bin/true',
    l0CompilerFn,
  });
  return { base, workspace, service, cleanup: () => rmSync(base, { recursive: true, force: true }) };
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
  test('only one of two successors claims a canceled profile after it drains', async () => {
    const f = fixture();
    const controller = new AbortController();
    let releaseDrain, reportStarted;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let launches = 0;
    const options = {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        launches++;
        const agent = launch.args[launch.args.indexOf('--agent') + 1];
        if (launches === 1) {
          reportStarted();
          await drained;
        }
        yield* fakeEvents(agent, launch.cwd, `exclusive-session-${launches}`, 'OK');
      },
    };
    let first, second, third;
    try {
      first = collect(f.service.invoke('Canceled holder.', { ...options, signal: controller.signal }));
      await started;
      controller.abort();
      second = collect(f.service.invoke('Successor A.', options));
      third = collect(f.service.invoke('Successor B.', options));
      await new Promise(setImmediate);
      assert.equal(launches, 1, 'neither successor may overlap the draining holder');
      releaseDrain();
      const [oldEvents, ...nextEvents] = await Promise.all([first, second, third]);
      assert.equal(oldEvents.at(-1).errorCode, 'AGY_CANCELLED');
      assert.equal(launches, 2, 'only one successor may launch after the holder releases');
      assert.equal(nextEvents.filter((events) => events.at(-1).errorCode === undefined).length, 1);
      assert.equal(nextEvents.filter((events) => events.at(-1).errorCode === 'AGY_NATIVE_BUSY').length, 1);
    } finally {
      releaseDrain();
      await Promise.allSettled([first, second, third]);
      f.cleanup();
    }
  });

  test('waits for a canceled native profile to drain before launching its next work', async () => {
    const f = fixture();
    const controller = new AbortController();
    let releaseDrain;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let launches = 0;
    const options = {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        launches++;
        const agent = launch.args[launch.args.indexOf('--agent') + 1];
        const frames = fakeEvents(agent, launch.cwd, `drain-session-${launches}`, 'OK');
        if (launches === 1) {
          reportStarted();
          yield frames[0];
          await drained;
          yield frames[1];
        } else {
          yield* frames;
        }
      },
    };
    let first, second;
    try {
      first = collect(f.service.invoke('Canceled work.', { ...options, signal: controller.signal }));
      await started;
      controller.abort();
      let nextWorkEnded = false;
      second = collect(f.service.invoke('Next work.', options)).then((events) => {
        nextWorkEnded = true;
        return events;
      });
      await new Promise(setImmediate);
      assert.equal(launches, 1, 'a live canceled CLI must retain exclusive profile access');
      assert.equal(nextWorkEnded, false, 'next work must wait for cleanup rather than fail AGY_NATIVE_BUSY');
      releaseDrain();
      const [oldEvents, nextEvents] = await Promise.all([first, second]);
      assert.equal(oldEvents.at(-1).errorCode, 'AGY_CANCELLED');
      assert.equal(nextEvents.at(-1).errorCode, undefined);
      assert.equal(launches, 2);
    } finally {
      releaseDrain();
      await Promise.allSettled([first, second]);
      f.cleanup();
    }
  });

  test('still refuses a genuinely concurrent native turn that has not been canceled', async () => {
    const f = fixture();
    let releaseDrain;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let first;
    try {
      first = collect(
        f.service.invoke('Active work.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            reportStarted();
            await drained;
            yield* fakeEvents(agent, launch.cwd, 'active-session', 'OK');
          },
        }),
      );
      await started;
      let secondSpawned = false;
      const events = await collect(
        f.service.invoke('Concurrent work.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* () {
            secondSpawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(secondSpawned, false);
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_BUSY');
    } finally {
      releaseDrain();
      await first;
      f.cleanup();
    }
  });

  test('never launches next work canceled while the prior profile is draining', async () => {
    const f = fixture();
    const previousAbort = new AbortController();
    const nextAbort = new AbortController();
    let releaseDrain;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let first, next;
    try {
      first = collect(
        f.service.invoke('Previous work.', {
          workingDirectory: f.workspace,
          signal: previousAbort.signal,
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            reportStarted();
            await drained;
            yield* fakeEvents(agent, launch.cwd, 'canceled-profile-session', 'OK');
          },
        }),
      );
      await started;
      previousAbort.abort();
      let nextSpawned = false;
      next = collect(
        f.service.invoke('Canceled next work.', {
          workingDirectory: f.workspace,
          signal: nextAbort.signal,
          spawnCliOverride: async function* () {
            nextSpawned = true;
            yield* [];
          },
        }),
      );
      await new Promise(setImmediate);
      nextAbort.abort();
      releaseDrain();
      const events = await next;
      assert.equal(nextSpawned, false);
      assert.equal(events.at(-1).errorCode, 'AGY_CANCELLED');
    } finally {
      releaseDrain();
      await Promise.allSettled([first, next]);
      f.cleanup();
    }
  });

  test('compiles owner-bound L0 independently of caller prepend and resume fallback', async () => {
    const calls = [];
    const f = fixture(async (options) => {
      calls.push(options);
      return '# Identity\nHOST-COMPILED-NATIVE-L0\n';
    });
    try {
      let prepared;
      const events = await collect(
        f.service.invoke('Answer the task.', {
          workingDirectory: f.workspace,
          systemPrompt: 'DYNAMIC-PACK-PREPEND',
          resumeFallbackSystemPrompt: 'DYNAMIC-PACK-RESUME',
          callbackEnv: { CAT_CAFE_USER_ID: 'owner-native' },
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
        assert.match(events[0].error, /trusted workspace/i);
      }
    } finally {
      f.cleanup();
    }
  });

  test('refuses a write grant bound to another workspace or without a Task', async () => {
    const f = fixture();
    try {
      const other = join(f.base, 'other');
      mkdirSync(other);
      for (const scope of [
        { workspaceRoot: other, taskId: 'task-pilot', writableFiles: ['src/task.ts'], mcpTools: [] },
        { workspaceRoot: f.workspace, writableFiles: ['src/task.ts'], mcpTools: [] },
      ]) {
        let spawned = false;
        const events = await collect(
          f.service.invoke('Write.', {
            workingDirectory: f.workspace,
            systemPrompt: '# Identity\nF325.\n',
            agyNativeScope: scope,
            spawnCliOverride: async function* () {
              spawned = true;
              yield* [];
            },
          }),
        );
        assert.equal(spawned, false);
        assert.equal(events[0].errorCode, 'AGY_NATIVE_PREFLIGHT');
        assert.match(events[0].error, /Task workspace binding/);
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

  test('declares queued native freshness and delivers a content-free notice before the next turn', async () => {
    const f = fixture();
    try {
      assert.deepEqual(f.service.freshnessCarrierCapability(), {
        provider: 'google',
        carrier: 'agy_stream_json',
        deliverySemantics: 'queued_internal_turn',
      });
      const notice = { text: '📬 One new message. Read the current thread with cat_cafe_get_thread_context.' };
      const actions = [];
      const events = await collect(
        f.service.invoke('Continue the task.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          agyNativeScope: { writableFiles: [], mcpTools: ['cat-cafe-collab/cat_cafe_get_thread_context'] },
          toolExecutionPolicy: {
            mode: 'callback_allowlist',
            allowedCallbackRoutes: ['GET /api/callbacks/thread-context'],
          },
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
            assert.equal(actions[0], 'prepare');
            const text = JSON.parse(options.stdinInput).message.content[0].text;
            assert.match(text, /^Continue the task\./);
            assert.match(text, /📬 One new message/);
            assert.ok(!text.includes('SECRET-MESSAGE-BODY'));
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-freshness-1', 'I will read it.');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined);
      assert.deepEqual(actions, ['prepare', ['commit', notice, { acceptedTurnId: 'agy-freshness-1' }]]);
    } finally {
      f.cleanup();
    }
  });

  test('defers a prepared freshness notice if AGY never accepts the turn', async () => {
    const f = fixture();
    try {
      const actions = [];
      const events = await collect(
        f.service.invoke('Continue.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          agyNativeScope: { writableFiles: [], mcpTools: ['cat-cafe-collab/cat_cafe_get_thread_context'] },
          toolExecutionPolicy: {
            mode: 'callback_allowlist',
            allowedCallbackRoutes: ['GET /api/callbacks/thread-context'],
          },
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
      assert.deepEqual(actions, ['defer']);
    } finally {
      f.cleanup();
    }
  });

  test('defers a prepared freshness notice when the accepted turn is denied or fails upstream', async () => {
    for (const outcome of ['denied', 'upstream-error']) {
      const f = fixture();
      try {
        const actions = [];
        const notice = { text: '📬 Read the current thread.' };
        const events = await collect(
          f.service.invoke('Continue.', {
            workingDirectory: f.workspace,
            systemPrompt: '# Identity\nF325.\n',
            agyNativeScope: { writableFiles: [], mcpTools: ['cat-cafe-collab/cat_cafe_get_thread_context'] },
            toolExecutionPolicy: {
              mode: 'callback_allowlist',
              allowedCallbackRoutes: ['GET /api/callbacks/thread-context'],
            },
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
        assert.deepEqual(actions, ['prepare', 'defer'], outcome);
      } finally {
        f.cleanup();
      }
    }
  });

  test('launches one native L0 session with isolated HOME, exact grants, and typed final', async () => {
    const f = fixture();
    try {
      let launch;
      let prepared;
      const events = await collect(
        f.service.invoke('Say hello.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nYou are F325-TEST-CAT.\n',
          agyNativeScope: {
            workspaceRoot: f.workspace,
            taskId: 'fixture-task',
            writableFiles: ['src/task.ts'],
            mcpTools: [],
          },
          callbackEnv: {
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
      assert.deepEqual(settings.permissions.allow, [
        `write_file(${join(realpathSync(f.workspace), 'src', 'task.ts')})`,
      ]);
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'text', 'done'],
      );
      assert.equal(events[0].sessionId, 'agy-session-1');
      assert.equal(events[1].content, 'Hello from native AGY.\n');
      assert.equal(events[2].errorCode, undefined);
    } finally {
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

  test('binds one exact MCP read to a scoped credential file that disappears after the turn', async () => {
    const f = fixture();
    try {
      let credentialPath;
      let config;
      const events = await collect(
        f.service.invoke('Read the current thread.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          agyNativeScope: {
            writableFiles: [],
            mcpTools: ['cat-cafe-collab/cat_cafe_get_thread_context'],
          },
          requiredTools: ['cat-cafe-collab::cat_cafe_get_thread_context'],
          toolExecutionPolicy: {
            mode: 'callback_allowlist',
            allowedCallbackRoutes: ['GET /api/callbacks/thread-context'],
          },
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'inv-1',
            CAT_CAFE_CALLBACK_TOKEN: 'secret-1',
          },
          spawnCliOverride: async function* (options) {
            assert.equal(options.env.CAT_CAFE_CALLBACK_TOKEN, null);
            assert.equal(options.env.CAT_CAFE_INVOCATION_ID, null);
            config = JSON.parse(readFileSync(join(options.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
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
      assert.equal(events.at(-1).errorCode, undefined);
      assert.deepEqual(Object.keys(config.mcpServers), ['cat-cafe-collab']);
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
