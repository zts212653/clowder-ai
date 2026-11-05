import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function collect(stream) {
  const messages = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

function init(launch, id) {
  return {
    event: 'init',
    conversation_id: id,
    init: {
      cwd: launch.cwd,
      agent: launch.args[launch.args.indexOf('--agent') + 1],
      model: 'gemini-3.8-flash-high',
      permission_mode: 'request-review',
      tools: [],
    },
  };
}

test('same cat starts another thread while its first CLI remains active; callback/config and cancellation stay isolated', async () => {
  const base = mkdtempSync(join(tmpdir(), 'f325-parallel-'));
  const workspaceA = join(base, 'workspace-a');
  const workspaceB = join(base, 'workspace-b');
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  for (const workspace of [workspaceA, workspaceB]) {
    mkdirSync(join(workspace, '.cat-cafe'));
    writeFileSync(
      join(workspace, '.cat-cafe/capabilities.json'),
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
        ],
      }),
    );
  }
  const profile = {
    enabled: true,
    profileId: 'gemini38',
    homeRoot: join(base, 'profiles'),
    model: 'gemini-3.8-flash-high',
    trustedWorkspaces: [workspaceA, workspaceB],
  };
  const services = ['A', 'B'].map(
    (name) =>
      new AgyNativeAgentService({
        catId: 'gemini38',
        profile,
        command: '/usr/bin/true',
        l0CompilerFn: async () => `# Identity\nIndependent ${name} context.\n`,
      }),
  );
  const active = [deferred(), deferred()];
  const drain = [deferred(), deferred()];
  const aborts = [new AbortController(), new AbortController()];
  const launches = [];
  const snapshots = [];
  const configRoots = [];
  const credentials = [];
  const running = [];
  let deadline;
  const options = (index) => ({
    workingDirectory: [workspaceA, workspaceB][index],
    invocationId: `parallel-${index}`,
    signal: aborts[index].signal,
    auditContext: {
      userId: 'owner',
      catId: 'gemini38',
      threadId: `thread-${index}`,
      invocationId: `parallel-${index}`,
    },
    callbackEnv: {
      CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
      CAT_CAFE_USER_ID: 'owner',
      CAT_CAFE_CAT_ID: 'gemini38',
      CAT_CAFE_THREAD_ID: `thread-${index}`,
      CAT_CAFE_INVOCATION_ID: `parallel-${index}`,
      CAT_CAFE_CALLBACK_TOKEN: `synthetic-token-${index}`,
    },
    spawnCliOverride: async function* (launch) {
      launches[index] = launch;
      configRoots[index] = launch.args.find((arg) => arg.startsWith('--gemini_dir=')).slice('--gemini_dir='.length);
      snapshots[index] = readFileSync(join(configRoots[index], 'config/mcp_config.json'), 'utf8');
      credentials[index] = JSON.parse(snapshots[index]).mcpServers['cat-cafe-memory']?.env.CAT_CAFE_CREDENTIAL_FILE;
      yield init(launch, `conversation-${index}`);
      active[index].resolve(true);
      await drain[index].promise;
      yield {
        event: 'result',
        result: { conversation_id: `conversation-${index}`, status: 'SUCCESS', response: 'Complete.', num_turns: 1 },
      };
    },
  });
  try {
    running.push(collect(services[0].invoke('Work in A.', options(0))));
    await active[0].promise;
    running.push(collect(services[1].invoke('Work in B.', options(1))));
    const concurrentInit = await Promise.race([
      active[1].promise,
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve(false), 1500);
      }),
    ]);
    assert.equal(concurrentInit, true, 'thread B must init before thread A releases its active CLI');
    clearTimeout(deadline);
    assert.equal(launches[0].env.HOME, launches[1].env.HOME, 'both processes retain the same authenticated account');
    assert.notEqual(configRoots[0], configRoots[1], 'mutable configuration belongs to each invocation');
    assert.notEqual(credentials[0], credentials[1]);
    for (const index of [0, 1]) {
      assert.equal(readFileSync(join(configRoots[index], 'config/mcp_config.json'), 'utf8'), snapshots[index]);
      assert.deepEqual(JSON.parse(readFileSync(credentials[index], 'utf8')), {
        invocationId: `parallel-${index}`,
        callbackToken: `synthetic-token-${index}`,
      });
      assert.equal(
        launches[index].args[launches[index].args.indexOf('--add-dir') + 1],
        realpathSync([workspaceA, workspaceB][index]),
      );
      assert.equal(launches[index].env.CAT_CAFE_THREAD_ID, `thread-${index}`);
    }
    aborts[0].abort();
    drain[0].resolve();
    const old = await running[0];
    assert.equal(old.at(-1).errorCode, 'AGY_CANCELLED');
    assert.equal(aborts[1].signal.aborted, false);
    assert.equal(existsSync(configRoots[0]), false, 'A releases only its disposable configuration');
    assert.equal(readFileSync(join(configRoots[1], 'config/mcp_config.json'), 'utf8'), snapshots[1]);
    assert.equal(existsSync(credentials[1]), true, 'A cleanup must not revoke B callback');
    drain[1].resolve();
    const other = await running[1];
    assert.equal(other.at(-1).errorCode, undefined, JSON.stringify(other));
  } finally {
    clearTimeout(deadline);
    for (const controller of aborts) controller.abort();
    for (const barrier of drain) barrier.resolve();
    await Promise.allSettled(running);
    rmSync(base, { recursive: true, force: true });
  }
});

test('same-conversation resume waits for process drain; canceling a waiter does not release the owner', async () => {
  const base = mkdtempSync(join(tmpdir(), 'f325-same-session-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
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
    l0CompilerFn: async () => '# Identity\nStable identity.\n',
  });
  const firstInit = deferred();
  const drain = deferred();
  const firstCancel = new AbortController();
  const waiterCancel = new AbortController();
  const running = [];
  let nextSpawned = false;
  try {
    running.push(
      (async () => {
        const messages = [];
        for await (const message of service.invoke('first', {
          workingDirectory: workspace,
          signal: firstCancel.signal,
          spawnCliOverride: async function* (launch) {
            yield init(launch, 'shared-conversation');
            await drain.promise;
            yield {
              event: 'result',
              result: { conversation_id: 'shared-conversation', status: 'SUCCESS', response: 'Done.', num_turns: 1 },
            };
          },
        })) {
          messages.push(message);
          if (message.type === 'session_init') firstInit.resolve(message.nativeSessionBinding);
        }
        return messages;
      })(),
    );
    const binding = await firstInit.promise;
    const resume = {
      workingDirectory: workspace,
      sessionId: binding.cliSessionId,
      nativeSessionBinding: binding,
      spawnCliOverride: async function* (launch) {
        nextSpawned = true;
        assert.equal(launch.args[launch.args.indexOf('--conversation') + 1], 'shared-conversation');
        yield init(launch, 'shared-conversation');
        yield {
          event: 'result',
          result: { conversation_id: 'shared-conversation', status: 'SUCCESS', response: 'Resumed.', num_turns: 2 },
        };
      },
    };
    const waiting = collect(service.invoke('canceled waiter', { ...resume, signal: waiterCancel.signal }));
    running.push(waiting);
    await new Promise((resolve) => setTimeout(resolve, 30));
    waiterCancel.abort();
    assert.equal((await waiting).at(-1).errorCode, 'AGY_CANCELLED');
    assert.equal(nextSpawned, false);
    const successor = collect(service.invoke('real successor', resume));
    running.push(successor);
    firstCancel.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(nextSpawned, false, 'cancellation must retain the lease until the owning process drains');
    drain.resolve();
    assert.equal((await running[0]).at(-1).errorCode, 'AGY_CANCELLED');
    assert.equal((await successor).at(-1).errorCode, undefined);
    assert.equal(nextSpawned, true);
  } finally {
    firstCancel.abort();
    waiterCancel.abort();
    drain.resolve();
    await Promise.allSettled(running);
    rmSync(base, { recursive: true, force: true });
  }
});

test('successive CLI runs receive one canonical data pathname before SQLite opens any new file', async () => {
  const base = mkdtempSync(join(tmpdir(), 'f325-native-data-coordinate-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
    },
    l0CompilerFn: async () => '# Identity\nCanonical native data.\n',
  });
  const launches = [];
  try {
    for (const turn of [0, 1]) {
      const messages = await collect(
        service.invoke('Work.', {
          workingDirectory: workspace,
          spawnCliOverride: async function* (launch) {
            const config = launch.args.find((arg) => arg.startsWith('--gemini_dir=')).slice('--gemini_dir='.length);
            const selector = launch.args.find((arg) => arg.startsWith('--app_data_dir='));
            const data = selector ? selector.slice('--app_data_dir='.length) : 'antigravity-cli';
            launches.push({ home: launch.env.HOME, config, nativePath: resolve(config, data) });
            yield init(launch, `canonical-data-${turn}`);
            yield {
              event: 'result',
              result: {
                conversation_id: `canonical-data-${turn}`,
                status: 'SUCCESS',
                response: 'Complete.',
                num_turns: 1,
              },
            };
          },
        }),
      );
      assert.equal(messages.at(-1).errorCode, undefined);
    }
    assert.notEqual(launches[0].config, launches[1].config);
    for (const launch of launches) {
      assert.equal(
        launch.nativePath,
        join(launch.home, '.gemini/antigravity-cli'),
        'SQLite must receive the canonical pathname even while a new database file does not exist; resolving an existing symlink after creation is too late',
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
