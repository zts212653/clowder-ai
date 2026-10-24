import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  buildCodexActiveWriterWaitSignal,
  CodexAgentService,
  codexConfigObjectFromArgs,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { resolveProviderMcpConfig } from '../dist/domains/cats/services/agents/providers/provider-mcp-config.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { syncMcpProject } from '../dist/mcp/mcp-sync-engine.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';
import { getCliExecutionExit, isCliExecutionRunning } from '../dist/utils/CliExecutionObservation.js';
import { createHarness, sessionOptions } from './helpers/codex-host-pool-harness.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';
import { callMcpProbe, writeMcpProbe } from './helpers/mcp-probe.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;
  #failure = null;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error) {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#failure) return Promise.reject(this.#failure);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

class PoolWire {
  constructor(threadId, reusedSessionHost = false, turnCompletion = { status: 'completed' }, turnNotifications = []) {
    this.threadId = threadId;
    this.cwd = join(tmpdir(), 'cat-cafe-pooling-retained-thread');
    this.reusedSessionHost = reusedSessionHost;
    this.turnCompletion = turnCompletion;
    this.turnNotifications = turnNotifications;
    this.inbox = new AsyncInbox();
    this.writes = [];
    this.rememberedSessions = [];
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.inbox.push({ id: message.id, result: { userAgent: 'fake-pool' } });
    } else if (message.method === 'config/read') {
      this.inbox.push({ id: message.id, result: { config: { mcp_servers: {} } } });
    } else if (message.method === 'configRequirements/read') {
      this.inbox.push({ id: message.id, result: { requirements: null } });
    } else if (message.method === 'account/read') {
      this.inbox.push({ id: message.id, result: { account: { type: 'chatgpt' } } });
    } else if (message.method === 'thread/read') {
      this.inbox.push({
        id: message.id,
        result: { thread: { id: message.params.threadId, cwd: this.cwd, turns: [] } },
      });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const threadId = message.method === 'thread/resume' ? message.params.threadId : this.threadId;
      this.inbox.push({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    } else if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      setImmediate(() => {
        for (const notification of this.turnNotifications) this.inbox.push(notification);
        this.inbox.push({
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: { id: 'turn-1', ...this.turnCompletion, items: [] },
          },
        });
      });
    }
  }

  rememberSession(sessionId) {
    this.rememberedSessions.push(sessionId);
  }

  async close() {
    this.inbox.close();
  }
}

class ActiveWriterWire extends PoolWire {
  constructor(threadId, reusedSessionHost = false) {
    super(threadId, reusedSessionHost);
    this.previousThreadId = threadId;
  }

  async write(message) {
    if (message.method === 'thread/resume') {
      this.writes.push(message);
      this.inbox.push({
        id: message.id,
        error: { code: -32600, message: `thread ${this.previousThreadId} already has an active writer` },
      });
      return;
    }
    if (message.method === 'thread/read') {
      this.writes.push(message);
      this.inbox.push({
        id: message.id,
        result: {
          thread: {
            id: this.previousThreadId,
            cwd: this.cwd,
            status: { type: 'active', activeFlags: [] },
            turns: [{ id: 'turn-old', status: 'inProgress', startedAt: 1_786_630_000, items: [] }],
          },
        },
      });
      return;
    }
    return super.write(message);
  }
}

class OversizedResumeWire extends PoolWire {
  constructor(previousThreadId, replacementThreadId) {
    super(replacementThreadId);
    this.previousThreadId = previousThreadId;
  }

  async write(message) {
    if (message.method === 'thread/resume') {
      this.writes.push(message);
      this.inbox.push({ id: message.id, error: { code: -32600, message: 'Max payload size exceeded' } });
      return;
    }
    return super.write(message);
  }
}

class CarrierKilledByOversizedResumeWire extends PoolWire {
  constructor(previousThreadId) {
    super(previousThreadId);
    this.previousThreadId = previousThreadId;
  }

  async write(message) {
    if (message.method === 'thread/resume') {
      this.writes.push(message);
      this.inbox.fail(new Error('Max payload size exceeded'));
      return;
    }
    return super.write(message);
  }
}

class FakeHostPool {
  constructor() {
    this.calls = [];
    this.wires = [];
    this.rejectedSessionIds = new Set();
    this.replacementSessionIds = new Set();
    this.turnCompletions = [];
    this.turnNotifications = [];
  }

  async createSession(options) {
    this.calls.push(options);
    if (options.sessionId && this.rejectedSessionIds.has(options.sessionId)) {
      throw new Error(`session ${options.sessionId} already has an active host lease`);
    }
    const reusedSessionHost = !!options.sessionId && !this.replacementSessionIds.has(options.sessionId);
    const wire = new PoolWire(
      'codex-thread-1',
      reusedSessionHost,
      this.turnCompletions.shift(),
      this.turnNotifications.shift(),
    );
    this.wires.push(wire);
    return wire;
  }

  async closeAll() {}
}

const credsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-codex-pool-creds-'));
process.env.CAT_CAFE_MCP_CREDS_DIR = credsDir;
// Credential tests must not depend on the developer workspace's enabled tools.
mkdirSync(join(credsDir, '.cat-cafe'));
writeFileSync(
  join(credsDir, '.cat-cafe', 'capabilities.json'),
  JSON.stringify({
    version: 1,
    capabilities: [
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [] },
      },
    ],
  }),
);

after(() => {
  delete process.env.CAT_CAFE_MCP_CREDS_DIR;
  rmSync(credsDir, { recursive: true, force: true });
});

for (const resumeKind of ['replacement', 'cold', 'unregistered-project']) {
  test(`${resumeKind} pooled resume authenticates a real plugin wrapper child with the current credential file`, async (t) => {
    const project = mkdtempSync(join(credsDir, 'plugin-wrapper-'));
    const childPath = join(project, 'native-action-child.mjs');
    writeMcpProbe(
      childPath,
      `
      let credential;
      try { credential = JSON.parse(readFileSync(process.env.CAT_CAFE_CREDENTIAL_FILE, 'utf8')); }
      catch { return { credentialReadable: false }; }
      const response = await fetch(process.env.CAT_CAFE_API_URL + '/api/plugin-runtime/action', {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-invocation-id': credential.invocationId, 'x-callback-token': credential.callbackToken,
          'x-clowder-plugin-action-token': process.env.CLOWDER_PLUGIN_ACTION_TOKEN },
        body: JSON.stringify({ method: 'fixture.run', input: {} }),
      });
      return { credentialReadable: true, status: response.status };
    `,
    );
    const registry = new InvocationRegistry();
    const authority = {
      instance: {
        pluginInstanceId: 'wrapper-fixture',
        pluginId: 'fixture',
        activationState: 'enabled',
        lifecycleState: 'installed',
        configReadiness: 'ready',
        packageDigest: 'fixture-digest',
      },
      packageRecord: {
        pluginId: 'fixture',
        manifest: {
          features: [{ capabilities: [], contributions: [{ type: 'mcp', id: 'native' }] }],
          contributions: [{ type: 'mcp', id: 'native', actions: [{ method: 'fixture.run' }] }],
        },
      },
      effectiveGrants: [],
    };
    let actionCalls = 0;
    let actions = new NativePluginActions(async () => authority);
    actions.activate(authority, 0, async () => {
      actionCalls++;
      return { ok: true };
    });
    const activation = actions.environment('wrapper-fixture', 'native');
    if (resumeKind === 'unregistered-project') {
      actions.deactivateAll();
      actions = new NativePluginActions(async () => authority);
      actions.activate(authority, 0, async () => {
        actionCalls++;
        return { ok: true };
      });
    }
    const app = Fastify();
    t.after(() => app.close());
    await app.register(pluginNativeActionRoutes, {
      actions,
      registry,
      sources: { invocationTracker: { getActiveSlots: () => [] }, messageStore: { getById: async () => null } },
    });
    const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    mkdirSync(join(project, '.cat-cafe'));
    const managed = JSON.parse(readFileSync(join(credsDir, '.cat-cafe/capabilities.json'), 'utf8')).capabilities;
    const pluginName = 'plugin__fixture__native';
    writeFileSync(
      join(project, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [
          ...managed,
          {
            id: 'plugin:fixture:native',
            type: 'mcp',
            source: 'plugin',
            pluginId: 'fixture',
            enabled: true,
            globalEnabled: true,
            mcpServer: { command: process.execPath, args: [childPath], env: activation },
          },
        ],
      }),
    );
    let lateHome;
    let sharedProject;
    {
      lateHome = mkdtempSync(join(tmpdir(), 'plugin-unregistered-home-'));
      if (resumeKind === 'unregistered-project')
        sharedProject = mkdtempSync(join(tmpdir(), 'plugin-unregistered-shared-'));
      const saved = Object.fromEntries(
        ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'].map((key) => [key, process.env[key]]),
      );
      t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(lateHome, { recursive: true, force: true });
        if (sharedProject) rmSync(sharedProject, { recursive: true, force: true });
      });
      process.env.CAT_CAFE_RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
      process.env.CAT_CAFE_WORKSPACE_ROOT = lateHome;
      mkdirSync(join(lateHome, '.cat-cafe'));
      const original = JSON.parse(readFileSync(join(project, '.cat-cafe/capabilities.json'), 'utf8'));
      const hostFile = join(lateHome, '.cat-cafe/capabilities.json');
      writeFileSync(hostFile, JSON.stringify(original));
      if (sharedProject) {
        await syncMcpProject(project, lateHome);
        mkdirSync(join(sharedProject, '.cat-cafe'));
        writeFileSync(
          join(sharedProject, '.cat-cafe/capabilities.json'),
          readFileSync(join(project, '.cat-cafe/capabilities.json')),
        );
        // Both consumer projects are outside this Host and absent from governance.
        // A normal activation rotates only the authoritative descriptor here.
        actions.deactivate('wrapper-fixture');
        actions.activate(authority, actions.generation('wrapper-fixture'), async () => {
          actionCalls++;
          return { ok: true };
        });
      }
      original.capabilities.find((entry) => entry.source === 'plugin').mcpServer.env = actions.environmentReferences(
        'wrapper-fixture',
        'native',
      );
      writeFileSync(hostFile, JSON.stringify(original));
      assert.ok(
        !readFileSync(hostFile, 'utf8').includes(
          actions.environment('wrapper-fixture', 'native').CLOWDER_PLUGIN_ACTION_TOKEN,
        ),
      );
      assert.ok(!existsSync(join(lateHome, '.cat-cafe/governance-registry.json')));
    }
    const pool = new FakeHostPool();
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      appServerHostPool: pool,
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
    });
    const envFor = (auth) => ({ ...callbackEnv(auth.invocationId, auth.callbackToken), CAT_CAFE_API_URL: apiUrl });
    const runChild = async (config) => {
      const server = config.mcp_servers[pluginName];
      assert.ok(server, 'the plugin must be present on the actual thread/resume wire');
      assert.ok(
        !JSON.stringify(server).includes(activation.CLOWDER_PLUGIN_ACTION_TOKEN),
        'activation secrets must remain outside the provider config',
      );
      return callMcpProbe(server);
    };
    let oldPath;
    let seed;
    if (resumeKind === 'replacement') {
      seed = await registry.create('user-1', 'codex-sol', 'cafe-thread-1');
      await drain(service.invoke('seed', { workingDirectory: project, callbackEnv: envFor(seed) }));
      const start = pool.wires.at(-1).writes.find((item) => item.method === 'thread/start');
      oldPath = managedCredentialPath(start);
      assert.deepEqual(await runChild(start.params.config), { credentialReadable: true, status: 200 });
      pool.replacementSessionIds.add('codex-thread-1');
    }
    const current = await registry.create('user-1', 'codex-sol', 'cafe-thread-1');
    const sessionId = resumeKind === 'replacement' ? 'codex-thread-1' : 'previous-process-native-session';
    pool.replacementSessionIds.add(sessionId);
    await drain(service.invoke('resume', { workingDirectory: project, sessionId, callbackEnv: envFor(current) }));
    const resumed = pool.wires.at(-1).writes.find((item) => item.method === 'thread/resume');
    const currentPath = managedCredentialPath(resumed);
    assert.ok(
      !JSON.stringify(resumed).includes(current.callbackToken),
      'callback secrets must stay outside the RPC wire',
    );
    assert.ok(currentPath, 'managed MCP has a current credential file');
    assert.ok(JSON.parse(readFileSync(currentPath, 'utf8')).invocationId === current.invocationId);
    if (oldPath) {
      assert.ok(oldPath !== currentPath, 'replacement host must isolate its credential file');
      assert.ok(
        JSON.parse(readFileSync(oldPath, 'utf8')).invocationId === seed.invocationId,
        'old host file must stay frozen',
      );
    }
    assert.deepEqual(
      await runChild(resumed.params.config),
      { credentialReadable: true, status: 200 },
      'fresh plugin child must pass real Host HTTP callback authentication on resumed host',
    );
    if (sharedProject) {
      const servers = await resolveProviderMcpConfig({
        callbackEnv: { ...envFor(current), CAT_CAFE_CREDENTIAL_FILE: currentPath },
        workingDirectory: sharedProject,
        mcpServerPath: join(process.env.CAT_CAFE_RUNTIME_ROOT, 'packages/mcp-server/dist/index.js'),
        credentialFile: currentPath,
      });
      const shared = servers[pluginName];
      assert.deepEqual(
        await callMcpProbe(shared),
        { credentialReadable: true, status: 200 },
        'shared provider must use the current Host activation despite a stale project copy',
      );
      const file = join(sharedProject, '.cat-cafe/capabilities.json');
      const config = JSON.parse(readFileSync(file, 'utf8'));
      config.capabilities.find((entry) => entry.source === 'plugin').blockedCats = ['codex-sol'];
      writeFileSync(file, JSON.stringify(config));
      const blocked = await resolveProviderMcpConfig({
        callbackEnv: { ...envFor(current), CAT_CAFE_CREDENTIAL_FILE: currentPath },
        workingDirectory: sharedProject,
        mcpServerPath: join(process.env.CAT_CAFE_RUNTIME_ROOT, 'packages/mcp-server/dist/index.js'),
        credentialFile: currentPath,
      });
      assert.equal(blocked[pluginName], undefined, 'Host connection binding must not lift an explicit member disable');
      const stale = await callMcpProbe({
        command: process.execPath,
        args: [childPath],
        env: { ...envFor(current), ...activation, CAT_CAFE_CREDENTIAL_FILE: currentPath },
      });
      assert.deepEqual(stale, { credentialReadable: true, status: 401 }, 'revoked activation must remain rejected');
      const hostConnection = actions.environment('wrapper-fixture', 'native');
      const sameChild = () =>
        callMcpProbe({
          command: process.execPath,
          args: [childPath],
          env: { ...envFor(current), ...hostConnection, CAT_CAFE_CREDENTIAL_FILE: currentPath },
        });
      actions.deactivate('wrapper-fixture');
      assert.equal((await sameChild()).status, 401, 'a disabled plugin must not execute');
      actions.activate(authority, actions.generation('wrapper-fixture'), async () => {
        actionCalls++;
        return { ok: true };
      });
      assert.deepEqual(
        await sameChild(),
        { credentialReadable: true, status: 200 },
        'reenable must work with the same child credentials, without sync or restart',
      );

      const unchanged = JSON.parse(readFileSync(join(project, '.cat-cafe/capabilities.json'), 'utf8'));
      assert.equal(
        unchanged.capabilities.find((entry) => entry.pluginId === 'fixture').mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN,
        activation.CLOWDER_PLUGIN_ACTION_TOKEN,
        'binding must not rewrite project storage',
      );
    }
    assert.equal(actionCalls, sharedProject ? 3 : resumeKind === 'replacement' ? 2 : 1);
  });
}

test('capability source deadline covers host acquisition before native RPC starts', async () => {
  let acquisitionSignal;
  const appServerHostPool = {
    createSession: async (options) => {
      acquisitionSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('acquisition aborted')), { once: true });
      });
    },
  };
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool,
    model: 'gpt-5.6-sol',
    l0CompilerFn: fakeL0Compiler,
  });

  await assert.rejects(
    service.requestNativeCapabilitySource({
      invocationId: 'marketplace-deadline',
      timeoutMs: 10,
      cwd: '/workspace',
    }),
    /authoritative_native_capability_source_timeout/,
  );
  assert.equal(acquisitionSignal?.aborted, true);
});

function callbackEnv(invocationId, callbackToken) {
  return {
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_INVOCATION_ID: invocationId,
    CAT_CAFE_CALLBACK_TOKEN: callbackToken,
    CAT_CAFE_USER_ID: 'user-1',
    CAT_CAFE_CAT_ID: 'codex-sol',
    CAT_CAFE_THREAD_ID: 'cafe-thread-1',
  };
}

test('active-writer ownership wait becomes a transient non-History status only after 10 seconds', () => {
  const event = {
    type: 'app_server.recovery',
    reason: 'active_writer_retry',
    attempt: 7,
    retryBudget: null,
    elapsedMs: 10_000,
    threadId: 'native-old',
  };
  assert.equal(
    buildCodexActiveWriterWaitSignal({
      catId: 'codex',
      metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
      event: { ...event, elapsedMs: 9_999 },
    }),
    null,
  );
  const signal = buildCodexActiveWriterWaitSignal({
    catId: 'codex',
    metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
    event,
    timestamp: 123,
  });
  assert.equal(signal.type, 'provider_signal');
  assert.equal(signal.timestamp, 123);
  assert.deepEqual(JSON.parse(signal.content), {
    type: 'warning',
    presentation: 'transient_status',
    message: '正在等待该成员的原生会话释放，可点 Stop 取消',
  });
  assert.equal(signal.metadata.diagnostics.appServerRecovery.elapsedMs, 10_000);
});

async function drain(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test('pooled Codex materializes ordered MCP overlays without duplicate TOML tables', () => {
  const config = codexConfigObjectFromArgs([
    '--config',
    'mcp_servers.cat-cafe.command="echo"',
    '--config',
    'mcp_servers.cat-cafe.args=["legacy-shim"]',
    '--config',
    'mcp_servers.cat-cafe.enabled=false',
    '--config',
    'mcp_servers.cat-cafe.command="node"',
    '--config',
    'mcp_servers.cat-cafe.args=["legacy.js"]',
    '--config',
    'mcp_servers.cat-cafe.enabled=true',
    '-c',
    'mcp_servers.cat-cafe.default_tools_approval_mode="approve"',
    '--config',
    'mcp_servers.cat-cafe.env.CAT_CAFE_CREDENTIAL_FILE="/tmp/session.json"',
  ]);

  assert.deepEqual(config, {
    mcp_servers: {
      'cat-cafe': {
        command: 'node',
        args: ['legacy.js'],
        enabled: true,
        default_tools_approval_mode: 'approve',
        env: { CAT_CAFE_CREDENTIAL_FILE: '/tmp/session.json' },
      },
    },
  });
});

test('pooled host lease observes the invocation abort signal', async () => {
  const pool = new FakeHostPool();
  const abortController = new AbortController();
  const owner = {
    invocationId: 'invocation-signal',
    executionId: 'parent-signal',
    userId: 'pooled-user',
    threadId: 'pooled-thread',
    catId: 'codex-sol',
  };
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
    rawArchive: { append: async () => {} },
  });

  await drain(
    service.invoke('signal plumbing', {
      invocationId: 'invocation-signal',
      signal: abortController.signal,
      auditContext: owner,
    }),
  );

  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].signal, abortController.signal);
  assert.equal(getCliExecutionExit(owner), undefined, 'warm-host close is not an exact turn process exit');
  assert.equal(isCliExecutionRunning(owner), false, 'warm host must not be pinned to one invocation');
  assert.equal(pool.calls[0].executionOwner, undefined);
});

test('CodexAgentService hides a recovered model-capacity failure from the Clowder AI message stream', async () => {
  const pool = new FakeHostPool();
  pool.turnCompletions.push(
    {
      status: 'failed',
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    },
    { status: 'completed' },
  );
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('keep working', {
      invocationId: 'invocation-capacity-retry',
      recoveryAnchor: {
        threadId: 'cat-thread-7',
        invocationId: 'invocation-capacity-retry',
        promptMessageIds: ['message-keep-working'],
      },
    }),
  );

  assert.equal(pool.calls.length, 2);
  assert.equal(pool.calls[1].sessionId, 'codex-thread-1');
  assert.equal(
    output.some((event) => event.type === 'error'),
    false,
    'a recovered capacity terminal must not force the user to send a new message',
  );
  assert.equal(
    output.some((event) => event.metadata?.diagnostics?.appServerRecovery?.reason === 'model_capacity'),
    true,
  );
  const recoveryIndex = output.findIndex(
    (event) => event.metadata?.diagnostics?.appServerRecovery?.reason === 'model_capacity',
  );
  assert.equal(
    output.slice(0, recoveryIndex).some((event) => event.type === 'status' && event.content === 'done'),
    false,
    'the hidden failed attempt must not publish a premature terminal status',
  );
  const retryTurn = pool.wires[1].writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(retryTurn.params.input, []);
  assert.equal(retryTurn.params.additionalContext?.['cat-cafe.capacity-recovery']?.kind, 'application');
});

test('CodexAgentService waits out active-writer ownership without a public failure or replacement session', async () => {
  const first = new ActiveWriterWire('native-old', true);
  const second = new ActiveWriterWire('native-old');
  const third = new PoolWire('native-old');
  const wires = [first, second, third];
  let factoryCalls = 0;
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('continue', {
      invocationId: 'invocation-active-writer-reborn',
      sessionId: 'native-old',
      agentCarrierSessionFactory: async () => wires[factoryCalls++],
    }),
  );

  assert.equal(factoryCalls, 3, 'the same native session remains pending until its writer releases');
  assert.equal(
    output.filter((message) => message.type === 'session_init' && message.sessionReplacement).length,
    0,
    'active-writer refusal must not mint replacement provenance or a new native session',
  );
  assert.equal(
    output.some((message) => message.type === 'error'),
    false,
    'writer ownership is transient scheduling state, not a public task failure',
  );
  assert.equal(
    output.filter((message) => message.metadata?.diagnostics?.appServerRecovery?.reason === 'active_writer_retry')
      .length,
    2,
    'each internal wait attempt remains observable without claiming a replacement',
  );
  assert.equal(
    output.some((message) => message.metadata?.diagnostics?.appServerLifecycle?.failureReason),
    false,
    'discarded ownership probes must not project a failed lifecycle into the active invocation',
  );
});

test(
  'ordinary typing to Live retires only the released local writer and resumes the same history',
  { timeout: 10000 },
  async () => {
    const { pool, hosts } = createHarness({ idleTtlMs: 300000 });
    const original = await pool.createSession(sessionOptions());
    original.rememberSession('native-old');
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.6-sol',
      appServerHostPool: pool,
    });
    let created = 0;
    const failures = [];
    const wire = new PoolWire('native-old');
    const invoke = async () => {
      let finish;
      return drain(
        service.invoke('continue this same conversation in Live', {
          invocationId: 'ordinary-to-live',
          sessionId: 'native-old',
          callbackEnv: {},
          agentCarrierSessionFactory: async () => {
            created++;
            assert.equal(hosts[0].isAlive, false);
            return wire;
          },
          liveCompanion: {
            configure: async () => ({ mcp_servers: {} }),
            finished: new Promise((resolve) => {
              finish = resolve;
            }),
            ready: async (id) => {
              assert.equal(id, 'native-old');
              finish();
            },
            observe: async () => {},
            fail: async (error) => {
              failures.push(error);
            },
          },
        }),
      );
    };
    try {
      const blocked = await invoke();
      assert.equal(created, 0, 'an active local writer forbids opening a second carrier');
      assert.equal(hosts[0].closeCalls, 0);
      assert.equal(failures[0].name, 'CodexActiveWriterRecoveryError');
      assert.equal(
        blocked.some((event) => event.type === 'session_init'),
        false,
      );
      await original.close();
      const resumed = await invoke();
      assert.equal(created, 1);
      assert.equal(hosts[0].closeCalls, 1);
      assert.deepEqual(wire.writes.find((message) => message.method === 'thread/read').params, {
        threadId: 'native-old',
        includeTurns: false,
      });
      assert.deepEqual(wire.writes.findLast((message) => message.method === 'config/read').params, {
        cwd: wire.cwd,
        includeLayers: false,
      });
      assert.ok(
        wire.writes.findLastIndex((message) => message.method === 'config/read') <
          wire.writes.findIndex((message) => message.method === 'thread/resume'),
      );
      assert.equal(wire.writes.find((message) => message.method === 'thread/resume').params.threadId, 'native-old');
      assert.equal(
        wire.writes.some((message) => ['thread/start', 'thread/archive', 'turn/interrupt'].includes(message.method)),
        false,
      );
      assert.equal(
        resumed.some((event) => event.type === 'session_init' && event.sessionReplacement),
        false,
      );
    } finally {
      await pool.closeAll();
    }
  },
);

test(
  'Live receives the typed final writer refusal without replacement or a ready media call',
  { timeout: 10000 },
  async () => {
    const wires = [new ActiveWriterWire('native-old'), new ActiveWriterWire('native-old')];
    for (const wire of wires) {
      const write = wire.write.bind(wire);
      wire.write = async (message) => {
        if (message.method === 'config/read') {
          wire.writes.push(message);
          wire.inbox.push({ id: message.id, result: { config: { mcp_servers: {} } } });
          return;
        }
        return write(message);
      };
    }
    let factoryCalls = 0;
    const failures = [];
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.6-sol',
    });
    const output = await drain(
      service.invoke('ordinary typing into Live', {
        invocationId: 'invocation-live-writer-refusal',
        sessionId: 'native-old',
        callbackEnv: {},
        agentCarrierSessionFactory: async () => wires[factoryCalls++],
        liveCompanion: {
          finished: new Promise(() => {}),
          configure: async () => ({ mcp_servers: {} }),
          ready: async () => {
            throw new Error('busy writer must not become a ready Live call');
          },
          fail: async (error) => {
            failures.push(error);
            assert.equal(factoryCalls, 1);
          },
        },
      }),
    );
    assert.equal(factoryCalls, 1, 'Live keeps its zero-replay transport policy');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, 'CodexActiveWriterRecoveryError');
    assert.equal(
      output.some((event) => event.type === 'session_init'),
      false,
    );
    for (const wire of wires.slice(0, factoryCalls)) {
      assert.deepEqual(wire.writes.findLast((message) => message.method === 'config/read').params, {
        cwd: wire.cwd,
        includeLayers: false,
      });
      assert.equal(
        wire.writes.some((message) => ['thread/start', 'thread/archive', 'turn/interrupt'].includes(message.method)),
        false,
      );
      assert.equal(wire.writes.find((message) => message.method === 'thread/resume').params.threadId, 'native-old');
    }
  },
);

test('CodexAgentService carries oversized native replacement provenance on the pre-turn session_init', async () => {
  const wire = new OversizedResumeWire('native-oversized', 'native-cold');
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('continue from cold navigation', {
      invocationId: 'invocation-oversized-rollover',
      sessionId: 'native-oversized',
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  const init = output.find((message) => message.type === 'session_init');
  assert.equal(init.sessionId, 'native-cold');
  assert.equal(init.sessionReplacement?.cause, 'native_resume_rejected');
  assert.equal(init.sessionReplacement?.previousNativeThreadId, 'native-oversized');
  assert.equal(init.sessionReplacement?.rejection, 'max_payload_size_exceeded');
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 1);
});

test('CodexAgentService replaces an oversized resume on a fresh carrier before turn/start', async () => {
  const deadResumeWire = new CarrierKilledByOversizedResumeWire('native-oversized');
  const coldStartWire = new PoolWire('native-cold');
  const wires = [deadResumeWire, coldStartWire];
  const factoryOptions = [];
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('continue from cold navigation', {
      invocationId: 'invocation-oversized-carrier-rollover',
      sessionId: 'native-oversized',
      agentCarrierSessionFactory: async (options) => {
        factoryOptions.push(options);
        return wires.shift();
      },
    }),
  );

  assert.equal(factoryOptions.length, 2, 'the dead resume carrier must receive one bounded replacement attempt');
  assert.equal(factoryOptions[0].sessionId, 'native-oversized');
  assert.equal(factoryOptions[1].sessionId, undefined, 'replacement must acquire a fresh carrier');

  const init = output.find((message) => message.type === 'session_init');
  assert.equal(init.sessionId, 'native-cold');
  assert.equal(init.sessionReplacement?.cause, 'native_resume_rejected');
  assert.equal(init.sessionReplacement?.previousNativeThreadId, 'native-oversized');
  assert.equal(init.sessionReplacement?.rejection, 'max_payload_size_exceeded');
  assert.equal(
    output.some((message) => message.type === 'error'),
    false,
  );

  assert.equal(deadResumeWire.writes.filter((message) => message.method === 'thread/resume').length, 1);
  assert.equal(deadResumeWire.writes.filter((message) => message.method === 'thread/start').length, 0);
  assert.equal(deadResumeWire.writes.filter((message) => message.method === 'turn/start').length, 0);
  assert.equal(coldStartWire.writes.filter((message) => message.method === 'thread/resume').length, 0);
  assert.equal(coldStartWire.writes.filter((message) => message.method === 'thread/start').length, 1);
  assert.equal(coldStartWire.writes.filter((message) => message.method === 'turn/start').length, 1);
});

test('CodexAgentService surfaces one checkpoint card when an in-flight tool blocks capacity recovery', async () => {
  const pool = new FakeHostPool();
  pool.turnCompletions.push({
    status: 'failed',
    error: { message: 'Selected model is at capacity. Please try a different model.' },
  });
  pool.turnNotifications.push([
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        plan: [
          { step: 'Inspect pull request 42', status: 'completed' },
          { step: 'Finish exact-head review', status: 'inProgress' },
        ],
      },
    },
    {
      method: 'item/started',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        item: { id: 'command-1', type: 'commandExecution', command: 'pnpm test' },
      },
    },
  ]);
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('review pull request 42', {
      invocationId: 'invocation-capacity-blocked',
      recoveryAnchor: {
        threadId: 'cafe-thread-1',
        invocationId: 'invocation-capacity-blocked',
        promptMessageIds: ['message-42'],
      },
    }),
  );

  const cards = output
    .filter((event) => event.type === 'system_info')
    .map((event) => {
      try {
        return JSON.parse(event.content);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.type === 'rich_block' && event.block?.meta?.kind === 'codex_capacity_recovery');
  const errors = output.filter((event) => event.type === 'error');

  assert.equal(cards.length, 1);
  assert.equal(cards[0].block.meta.reason, 'blocked_inflight_tool');
  assert.match(cards[0].block.fields.find((field) => field.label === '下一步').value, /exact-head review/);
  assert.equal(errors.length, 1, 'the invocation must remain a failure even though diagnostics use a rich card');
  assert.doesNotMatch(errors[0].error, /Selected model is at capacity/);
  assert.match(errors[0].error, /没有猜测或切换任务/);
  assert.equal(errors[0].metadata.upstreamError.kind, 'capacity');
});

function managedCredentialPath(threadStart) {
  const servers = threadStart.params.config?.mcp_servers ?? {};
  return Object.values(servers)
    .map((server) => server?.env?.CAT_CAFE_CREDENTIAL_FILE)
    .find((value) => typeof value === 'string');
}

test('pooled Codex carries MCP config per session and refreshes an isolated credential file', async () => {
  const pool = new FakeHostPool();
  const archived = [];
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
    rawArchive: { append: async (_invocationId, payload) => archived.push(payload) },
  });

  const firstCallbackEnv = {
    ...callbackEnv('invocation-1', 'callback-token-1'),
    CAT_CAFE_EXECUTION_ID: 'parent-execution-1',
    CAT_CAFE_PROCESS_EXECUTION_OWNER: '1',
  };
  const firstEvents = await drain(
    service.invoke('first turn', {
      workingDirectory: credsDir,
      invocationId: 'invocation-1',
      callbackEnv: firstCallbackEnv,
      auditContext: {
        invocationId: 'invocation-1',
        threadId: 'cafe-thread-1',
        userId: 'user-1',
        catId: 'codex-sol',
      },
    }),
  );

  assert.equal(pool.calls.length, 1, 'the app-server carrier must acquire the injected warm pool');
  assert.deepEqual(
    firstEvents.filter((event) => event.type === 'error'),
    [],
  );
  const firstWire = pool.wires[0];
  const firstStart = firstWire.writes.find((message) => message.method === 'thread/start');
  const credentialPath = managedCredentialPath(firstStart);
  assert.ok(
    credentialPath,
    `managed MCP config must receive a session credential path; servers=${Object.keys(firstStart.params.config?.mcp_servers ?? {})}`,
  );
  assert.deepEqual(firstWire.rememberedSessions, ['codex-thread-1']);
  assert.equal(JSON.parse(readFileSync(credentialPath, 'utf8')).invocationId, 'invocation-1');

  const firstLaunch = JSON.stringify(pool.calls[0]);
  assert.doesNotMatch(firstLaunch, /callback-token-1/);
  assert.doesNotMatch(firstLaunch, /mcp_servers\.cat-cafe/);
  assert.doesNotMatch(firstLaunch, /parent-execution-1|CAT_CAFE_PROCESS_EXECUTION_OWNER/);
  assert.doesNotMatch(JSON.stringify(firstStart), /callback-token-1|CAT_CAFE_CALLBACK_TOKEN/);
  assert.equal(
    archived.some((payload) => JSON.stringify(payload).includes('callback-token-1')),
    false,
    'raw archive must not contain callback secrets moved into the credential file',
  );

  pool.rejectedSessionIds.add('codex-thread-1');
  await drain(
    service.invoke('overlapping resume', {
      workingDirectory: credsDir,
      invocationId: 'invocation-overlap',
      sessionId: 'codex-thread-1',
      callbackEnv: callbackEnv('invocation-overlap', 'callback-token-overlap'),
    }),
  );
  assert.equal(
    JSON.parse(readFileSync(credentialPath, 'utf8')).invocationId,
    'invocation-1',
    'a rejected concurrent lease must not rotate credentials under the active invocation',
  );
  pool.rejectedSessionIds.clear();
  const callsBeforeSuccessfulResume = pool.calls.length;

  await drain(
    service.invoke('resume turn', {
      workingDirectory: credsDir,
      invocationId: 'invocation-2',
      sessionId: 'codex-thread-1',
      callbackEnv: callbackEnv('invocation-2', 'callback-token-2'),
    }),
  );

  assert.equal(pool.calls.length, callsBeforeSuccessfulResume + 1);
  assert.equal(pool.calls.at(-1).sessionId, 'codex-thread-1');
  const resume = pool.wires.at(-1).writes.find((message) => message.method === 'thread/resume');
  assert.equal(managedCredentialPath(resume), credentialPath, 'resume must refresh the bound file, not rotate it');
  assert.equal(JSON.parse(readFileSync(credentialPath, 'utf8')).invocationId, 'invocation-2');
  assert.doesNotMatch(JSON.stringify(resume), /callback-token-2|CAT_CAFE_CALLBACK_TOKEN/);
});

test('replacement host rotates credentials while leaving the superseded host file unchanged', async () => {
  const pool = new FakeHostPool();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
  });

  await drain(
    service.invoke('seed turn', {
      workingDirectory: credsDir,
      invocationId: 'replacement-seed',
      callbackEnv: callbackEnv('replacement-seed', 'seed-token'),
    }),
  );
  const seedStart = pool.wires[0].writes.find((message) => message.method === 'thread/start');
  const oldPath = managedCredentialPath(seedStart);
  assert.ok(oldPath);
  assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).invocationId, 'replacement-seed');

  pool.replacementSessionIds.add('codex-thread-1');
  await drain(
    service.invoke('replacement turn', {
      workingDirectory: credsDir,
      invocationId: 'replacement-next',
      sessionId: 'codex-thread-1',
      callbackEnv: callbackEnv('replacement-next', 'replacement-token'),
    }),
  );

  const replacementResume = pool.wires.at(-1).writes.find((message) => message.method === 'thread/resume');
  const replacementPath = managedCredentialPath(replacementResume);
  assert.ok(replacementPath);
  assert.notEqual(replacementPath, oldPath, 'a different host must not receive the superseded host credential path');
  assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).invocationId, 'replacement-seed');
  assert.equal(JSON.parse(readFileSync(replacementPath, 'utf8')).invocationId, 'replacement-next');
});

test('plugin MCP wrapper follows the replacement host credential file instead of a completed turn', async () => {
  const configPath = join(credsDir, '.cat-cafe', 'capabilities.json');
  const originalConfig = readFileSync(configPath, 'utf8');
  const fixture = join(credsDir, 'plugin-credential-probe.mjs');
  writeMcpProbe(
    fixture,
    `
    const credential = JSON.parse(readFileSync(process.env.CAT_CAFE_CREDENTIAL_FILE, 'utf8'));
    return { invocationId: credential.invocationId };
  `,
  );
  const config = JSON.parse(originalConfig);
  config.capabilities.push({
    id: 'plugin:official.github-operations:github-tracking',
    type: 'mcp',
    source: 'plugin',
    enabled: true,
    pluginId: 'official.github-operations',
    mcpServer: {
      command: process.execPath,
      args: [fixture],
      env: {
        CLOWDER_PLUGIN_ACTION_TOKEN: 'a'.repeat(64),
        CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
      },
    },
  });
  const oldPluginVariable = process.env.MCP_WRAPPER_FIXTURE_TOKEN;
  process.env.MCP_WRAPPER_FIXTURE_TOKEN = 'a'.repeat(64);
  config.capabilities.at(-1).mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN = '${MCP_WRAPPER_FIXTURE_TOKEN}';
  writeFileSync(configPath, JSON.stringify(config));
  const previousRoots = Object.fromEntries(
    ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'].map((key) => [key, process.env[key]]),
  );
  process.env.CAT_CAFE_RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  process.env.CAT_CAFE_WORKSPACE_ROOT = credsDir;
  try {
    const pool = new FakeHostPool();
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      appServerHostPool: pool,
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      model: 'gpt-5.3-codex',
    });
    await drain(
      service.invoke('seed plugin transport', {
        workingDirectory: credsDir,
        invocationId: 'plugin-seed',
        callbackEnv: callbackEnv('plugin-seed', 'seed-token'),
      }),
    );
    const seedStart = pool.wires[0].writes.find((m) => m.method === 'thread/start');
    const oldPath = managedCredentialPath(seedStart);
    pool.replacementSessionIds.add('codex-thread-1');
    await drain(
      service.invoke('replacement plugin transport', {
        workingDirectory: credsDir,
        invocationId: 'plugin-current',
        sessionId: 'codex-thread-1',
        callbackEnv: callbackEnv('plugin-current', 'current-token'),
      }),
    );
    const resume = pool.wires.at(-1).writes.find((m) => m.method === 'thread/resume');
    const server = Object.entries(resume.params.config.mcp_servers).find(([id]) => id.includes('github-tracking'))?.[1];
    assert.ok(server, 'the declared plugin must remain available');
    const result = await callMcpProbe(server);
    assert.equal(result.invocationId, 'plugin-current');
    assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).invocationId, 'plugin-seed');
    assert.doesNotMatch(JSON.stringify(resume), /seed-token|current-token|CAT_CAFE_CALLBACK_TOKEN/);
  } finally {
    if (oldPluginVariable === undefined) delete process.env.MCP_WRAPPER_FIXTURE_TOKEN;
    else process.env.MCP_WRAPPER_FIXTURE_TOKEN = oldPluginVariable;
    for (const [key, value] of Object.entries(previousRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    writeFileSync(configPath, originalConfig);
    rmSync(fixture, { force: true });
  }
});

for (const conflict of [false, true])
  test(`capability probe uses admitted API home and validates native config before inventory (conflict=${conflict})`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-probe-home-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'missing', '.codex');
    class CapabilityWire extends PoolWire {
      async write(message) {
        if (message.method === 'config/read' && conflict) {
          this.writes.push(message);
          this.inbox.push({ id: message.id, result: { config: { sqlite_home: join(root, 'wrong') } } });
        } else if (
          [
            'skills/list',
            'app/list',
            'app/installed',
            'plugin/list',
            'plugin/installed',
            'mcpServerStatus/list',
          ].includes(message.method)
        ) {
          this.writes.push(message);
          this.inbox.push({ id: message.id, result: { data: [], apps: [], marketplaces: [] } });
        } else await super.write(message);
      }
    }
    const wire = new CapabilityWire('probe-without-thread');
    const pool = {
      createSession: async (options) => {
        assert.notEqual(options.env.CODEX_HOME, home);
        assert.equal(existsSync(options.env.CODEX_HOME), true, 'mkdir must precede actual pool spawn');
        return wire;
      },
    };
    const service = new CodexAgentService({
      carrierMode: 'app_server',
      appServerHostPool: pool,
      l0CompilerFn: fakeL0Compiler,
    });
    const account = {
      id: 'api-fixture',
      authType: 'api_key',
      apiKey: 'fixture-never-used',
      baseUrl: 'http://127.0.0.1:1',
      envVars: { HOME: root, CAT_CAFE_DATA_DIR: join(root, 'data'), CODEX_HOME: home },
    };
    const probe = () =>
      service.requestNativeCapabilitySource({ invocationId: 'probe-fixture', timeoutMs: 1000, cwd: root, account });
    if (conflict) await assert.rejects(probe(), /configuration_conflict:sqlite_home/);
    else assert.equal((await probe()).availability, 'live');
    const methods = wire.writes.map((message) => message.method);
    assert.deepEqual(methods.slice(0, 5), [
      'initialize',
      'initialized',
      'config/read',
      'configRequirements/read',
      'account/read',
    ]);
    assert.equal(methods.includes('thread/start'), false);
    assert.equal(methods.includes('app/list'), !conflict);
    assert.deepEqual(wire.writes.find((message) => message.method === 'account/read').params, { refreshToken: false });
  });
