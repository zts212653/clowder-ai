import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { runCodexAppServerInitializedRpc } from '../dist/domains/cats/services/agents/providers/CodexAppServerNativeRpc.js';
import { CodexRequiredToolsUnavailableError } from '../dist/domains/cats/services/agents/providers/CodexRequiredToolsPreflight.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const REQUIRED_SERVER = 'cat-cafe-collab';
const REQUIRED_TOOL_NAME = 'cat_cafe_required_tools_probe';
const REQUIRED_TOOL = `${REQUIRED_SERVER}::${REQUIRED_TOOL_NAME}`;
const KNOWN_COLLAB_TOOL = 'required-tools-probe::cat_cafe_read_entrusted_work';
const PROBE_SERVER = fileURLToPath(new URL('../../mcp-server/dist/collab.js', import.meta.url));

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function preparedProbeRequest(body) {
  return {
    v: 1,
    message: { body },
    nativeInstructions: [],
    runtime: { provider: 'openai', carrier: 'app_server', model: 'gpt-5' },
    tools: { finalSurface: 'unknown' },
    providerNativeVisibility: 'unknown',
  };
}

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push({ resolve }));
      },
    };
  }
}

class ToolInventoryWire {
  constructor({
    serverName = 'cat-cafe-collab',
    tools = {},
    toolsError,
    statusSequence,
    neverResolveStatus = false,
  } = {}) {
    this.inbox = new AsyncInbox();
    this.serverName = serverName;
    this.tools = tools;
    this.toolsError = toolsError;
    this.statusSequence = statusSequence;
    this.neverResolveStatus = neverResolveStatus;
    this.statusReadCount = 0;
    this.writes = [];
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.inbox.push({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const threadId = message.method === 'thread/resume' ? message.params.threadId : 'native-thread';
      this.inbox.push({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
      return;
    }
    if (message.method === 'mcpServerStatus/list') {
      if (this.neverResolveStatus) return new Promise(() => {});
      const runtimeStatus =
        this.statusSequence?.[Math.min(this.statusReadCount++, this.statusSequence.length - 1)] ?? 'connected';
      this.inbox.push({
        id: message.id,
        result: {
          data: [
            {
              name: this.serverName,
              runtimeStatus,
              tools: this.tools,
              ...(this.toolsError ? { toolsError: this.toolsError } : {}),
            },
          ],
        },
      });
      return;
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      this.inbox.push({
        method: 'turn/completed',
        params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed' } },
      });
    }
  }

  async close() {
    this.inbox.close();
  }
}

test('required tools block an exec-configured resume before turn/start when the effective inventory is missing them', async () => {
  const wire = new ToolInventoryWire();
  let fallbackExecCalls = 0;
  const service = new CodexAgentService({
    carrierMode: 'exec_json',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('continue the entrusted work', {
      invocationId: 'required-tools-missing',
      sessionId: 'native-thread',
      requiredTools: [REQUIRED_TOOL],
      agentCarrierSessionFactory: async () => wire,
      spawnCliOverride: async function* () {
        fallbackExecCalls++;
        yield { type: 'thread.started', thread_id: 'unexpected-exec-thread' };
        yield { type: 'turn.completed', status: 'completed' };
      },
    }),
  );

  assert.equal(fallbackExecCalls, 0, 'declared tools must promote the invocation to a preflight-capable carrier');
  assert.equal(wire.writes.filter((message) => message.method === 'mcpServerStatus/list').length, 1);
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 0);
  const error = output.find((message) => message.type === 'error');
  assert.equal(error?.errorCode, 'required_tools_unavailable');
  assert.deepEqual(error?.metadata?.requiredToolsUnavailable, {
    code: 'required_tools_unavailable',
    missingTools: [REQUIRED_TOOL],
  });
  const done = output.find((message) => message.type === 'done');
  assert.equal(done?.errorCode, 'required_tools_unavailable');
});

test('required tools use the effective tool map, not a server name or total count', async () => {
  const wire = new ToolInventoryWire({
    tools: {
      cat_cafe_other_tool: { name: 'cat_cafe_other_tool', inputSchema: {} },
      [REQUIRED_TOOL_NAME]: { name: REQUIRED_TOOL_NAME, inputSchema: {} },
    },
  });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('continue the entrusted work', {
      invocationId: 'required-tools-present',
      requiredTools: [REQUIRED_TOOL],
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  const statusIndex = wire.writes.findIndex((message) => message.method === 'mcpServerStatus/list');
  const turnIndex = wire.writes.findIndex((message) => message.method === 'turn/start');
  assert.ok(statusIndex >= 0);
  assert.ok(turnIndex > statusIndex, 'the actual tool map must be read before turn/start');
  assert.equal(
    output.some((message) => message.type === 'error'),
    false,
  );
});

test('a same-named tool from an unrelated MCP server cannot satisfy a Clowder AI requirement', async () => {
  const wire = new ToolInventoryWire({
    serverName: 'unrelated-third-party',
    tools: { [REQUIRED_TOOL_NAME]: { name: REQUIRED_TOOL_NAME, inputSchema: {} } },
  });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('continue the entrusted work', {
      invocationId: 'required-tools-wrong-server',
      requiredTools: [REQUIRED_TOOL],
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 0);
  assert.deepEqual(output.find((message) => message.type === 'error')?.metadata?.requiredToolsUnavailable, {
    code: 'required_tools_unavailable',
    missingTools: [REQUIRED_TOOL],
  });
  assert.equal(wire.writes.filter((message) => message.method === 'mcpServerStatus/list').length, 1);
});

test('preflight waits for the required server to finish starting before it permits turn/start', async () => {
  const wire = new ToolInventoryWire({
    statusSequence: ['starting', 'connected'],
    tools: { [REQUIRED_TOOL_NAME]: { name: REQUIRED_TOOL_NAME, inputSchema: {} } },
  });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('continue the entrusted work', {
      invocationId: 'required-tools-starting',
      requiredTools: [REQUIRED_TOOL],
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  const statusIndex = wire.writes.findLastIndex((message) => message.method === 'mcpServerStatus/list');
  const turnIndex = wire.writes.findIndex((message) => message.method === 'turn/start');
  assert.equal(wire.writes.filter((message) => message.method === 'mcpServerStatus/list').length, 2);
  assert.ok(turnIndex > statusIndex, 'turn/start must wait for a connected server inventory');
  assert.equal(
    output.some((message) => message.type === 'error'),
    false,
  );
});

test('a hung status RPC reaches the typed fail-closed terminal before turn/start', { timeout: 4_000 }, async () => {
  const wire = new ToolInventoryWire({ neverResolveStatus: true });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });
  let deadlineTimer;
  try {
    const output = await Promise.race([
      collect(
        service.invoke('continue the entrusted work', {
          invocationId: 'required-tools-status-hung',
          requiredTools: [REQUIRED_TOOL],
          agentCarrierSessionFactory: async () => wire,
        }),
      ),
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error('required-tools preflight did not reach a terminal state')),
          3_500,
        );
      }),
    ]);
    assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 0);
    assert.equal(output.find((message) => message.type === 'error')?.errorCode, 'required_tools_unavailable');
    assert.deepEqual(output.find((message) => message.type === 'done')?.metadata?.requiredToolsUnavailable, {
      code: 'required_tools_unavailable',
      missingTools: [REQUIRED_TOOL],
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
});

test('an unqualified tool name fails closed instead of disabling the server identity check', async () => {
  const wire = new ToolInventoryWire({
    tools: { [REQUIRED_TOOL_NAME]: { name: REQUIRED_TOOL_NAME, inputSchema: {} } },
  });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('continue the entrusted work', {
      invocationId: 'required-tools-unqualified',
      requiredTools: [REQUIRED_TOOL_NAME],
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 0);
  assert.deepEqual(output.find((message) => message.type === 'error')?.metadata?.requiredToolsUnavailable, {
    code: 'required_tools_unavailable',
    missingTools: [REQUIRED_TOOL_NAME],
  });
});

test('a connected server with a tool-load error cannot satisfy requiredTools', async () => {
  const wire = new ToolInventoryWire({
    tools: { [REQUIRED_TOOL_NAME]: { name: REQUIRED_TOOL_NAME, inputSchema: {} } },
    toolsError: 'MCP tool discovery failed',
  });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('continue the entrusted work', {
      invocationId: 'required-tools-load-error',
      requiredTools: [REQUIRED_TOOL],
      agentCarrierSessionFactory: async () => wire,
    }),
  );

  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 0);
  assert.equal(output.find((message) => message.type === 'done')?.errorCode, 'required_tools_unavailable');
});

test('omitting requiredTools preserves the configured exec_json carrier', async () => {
  let execCalls = 0;
  const service = new CodexAgentService({
    carrierMode: 'exec_json',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await collect(
    service.invoke('ordinary invocation', {
      invocationId: 'required-tools-omitted',
      spawnCliOverride: async function* () {
        execCalls++;
        yield { type: 'thread.started', thread_id: 'ordinary-exec-thread' };
        yield { type: 'turn.completed', status: 'completed' };
      },
      agentCarrierSessionFactory: async () => {
        throw new Error('required-tools-free invocation must not create an app-server carrier');
      },
    }),
  );

  assert.equal(execCalls, 1);
  assert.equal(
    output.some((message) => message.type === 'error'),
    false,
  );
});

const hasCodex = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;
const runRealProtocolProbe = hasCodex && existsSync(PROBE_SERVER);
const REAL_PROTOCOL_PROBE_RPC_TIMEOUT_MS = 60_000;
const REAL_PROTOCOL_PROBE_TEST_TIMEOUT_MS = 2 * REAL_PROTOCOL_PROBE_RPC_TIMEOUT_MS;

test(
  'real app-server reads a resumed thread inventory and blocks before a synthetic model turn',
  { skip: !runRealProtocolProbe, timeout: REAL_PROTOCOL_PROBE_TEST_TIMEOUT_MS },
  async (t) => {
    let phase = 'start local responses fixture';
    let syntheticProviderRequestCount = 0;
    const home = await mkdtemp(join(tmpdir(), 'codex-required-tools-probe-'));
    const workspace = join(home, 'workspace');
    const wires = [];
    const reportAbort = () => t.diagnostic(`real required-tools probe aborted during ${phase}`);
    t.signal.addEventListener('abort', reportAbort, { once: true });
    const gitTracePath = join(home, 'git-trace.jsonl');
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(404);
        response.end();
        return;
      }
      for await (const _chunk of request) {
        // Consume the synthetic request body without persisting it.
      }
      syntheticProviderRequestCount++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          { type: 'response.created', response: { id: 'synthetic', object: 'response', status: 'in_progress' } },
          {
            type: 'response.completed',
            response: {
              id: 'synthetic',
              object: 'response',
              status: 'completed',
              output: [],
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const config = {
      mcp_servers: {
        'required-tools-probe': {
          command: process.execPath,
          args: [PROBE_SERVER],
          enabled: true,
        },
      },
    };
    const createProbeWire = async (invocationId) => {
      const wire = await createDirectAgentCarrierSession({
        command: 'codex',
        args: [
          'app-server',
          '--stdio',
          // Curated-plugin sync is unrelated to the real MCP inventory under test.
          '--disable',
          'plugins',
          '--config',
          'model_provider="fixture"',
          '--config',
          'model_providers.fixture.name="fixture"',
          '--config',
          `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,
          '--config',
          'model_providers.fixture.wire_api="responses"',
          '--config',
          'model_providers.fixture.env_key="OPENAI_API_KEY"',
        ],
        cwd: workspace,
        invocationId,
        signal: t.signal,
        env: {
          HOME: home,
          CODEX_HOME: home,
          // HOME alone leaves the parent's guarded-zsh startup context in place.
          ZDOTDIR: home,
          // This protocol fixture needs local Git metadata, never a remote repository.
          GIT_ALLOW_PROTOCOL: 'file',
          GIT_TRACE2_EVENT: gitTracePath,
          OPENAI_API_KEY: 'synthetic-only',
          NO_PROXY: '127.0.0.1,localhost',
          CAT_CAFE_CALLBACK_TOKEN: null,
          CAT_CAFE_INVOCATION_ID: null,
          CAT_CAFE_AGENT_KEY_SECRET: null,
          CAT_CAFE_RUNTIME_ROOT: null,
          CAT_CAFE_MCP_SERVER_PATH: null,
        },
      });
      wires.push(wire);
      return wire;
    };

    let probeFailure;
    const cleanupErrors = [];
    try {
      // Repo skills and the developer checkout are not inputs to this protocol test.
      await mkdir(workspace);
      const gitInit = spawnSync('git', ['init', '--quiet', workspace], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      });
      assert.equal(gitInit.status, 0, gitInit.stderr);
      const freshWire = await createProbeWire('required-tools-real-fresh-probe');
      const freshClient = new CodexAppServerClient({ wire: freshWire });
      phase = 'fresh native thread positive tool inventory preflight';
      await assert.rejects(
        () =>
          collect(
            freshClient.run({
              prompt: { kind: 'frozen', prompt: 'this local provider must not receive a request' },
              thread: { kind: 'start' },
              model: 'gpt-5',
              cwd: workspace,
              signal: t.signal,
              sandbox: 'read-only',
              approvalPolicy: 'never',
              config,
              requiredTools: [KNOWN_COLLAB_TOOL],
              prepareRequest: preparedProbeRequest,
              beforeProviderLaunch: async () => {
                throw new Error('required_tools_probe_pre_provider_stop');
              },
            }),
          ),
        /required_tools_probe_pre_provider_stop/,
      );
      assert.equal(
        syntheticProviderRequestCount,
        0,
        'the positive inventory probe must stop before its synthetic model turn',
      );

      const seededWire = await createProbeWire('required-tools-real-synthetic-seed');
      let persistedThreadId;
      let seededTurnId;
      let resolveSeededTurn;
      const seededTurnCompleted = new Promise((resolve) => {
        resolveSeededTurn = resolve;
      });
      await runCodexAppServerInitializedRpc({
        wire: seededWire,
        timeoutMs: REAL_PROTOCOL_PROBE_RPC_TIMEOUT_MS,
        signal: t.signal,
        onNotification: async (event) => {
          if (event.method === 'turn/completed' && event.params?.turn?.id === seededTurnId) {
            resolveSeededTurn();
          }
        },
        run: async (client) => {
          phase = 'seed thread/start without MCP config';
          const seeded = await client.request('thread/start', {
            cwd: workspace,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: 'gpt-5',
            modelProvider: 'fixture',
          });
          persistedThreadId = seeded?.thread?.id;
          assert.equal(typeof persistedThreadId, 'string');
          phase = 'synthetic turn/start';
          const turn = await client.request('turn/start', {
            threadId: persistedThreadId,
            input: [{ type: 'text', text: 'synthetic persistence seed' }],
          });
          seededTurnId = turn?.turn?.id;
          assert.equal(typeof seededTurnId, 'string');
          phase = 'synthetic turn/completed';
          let timer;
          let onAbort;
          try {
            await Promise.race([
              seededTurnCompleted,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic_turn_completion_timeout')), 10_000);
                onAbort = () => reject(t.signal.reason);
                if (t.signal.aborted) onAbort();
                else t.signal.addEventListener('abort', onAbort, { once: true });
              }),
            ]);
          } finally {
            clearTimeout(timer);
            if (onAbort) t.signal.removeEventListener('abort', onAbort);
          }
        },
      });

      const resumedWire = await createProbeWire('required-tools-real-resume-probe');
      const client = new CodexAppServerClient({ wire: resumedWire });
      phase = 'required-tools preflight on resumed native thread';
      await assert.rejects(
        () =>
          collect(
            client.run({
              prompt: { kind: 'frozen', prompt: 'this local provider must not receive a second request' },
              thread: { kind: 'resume', threadId: persistedThreadId },
              model: 'gpt-5',
              cwd: workspace,
              signal: t.signal,
              sandbox: 'read-only',
              approvalPolicy: 'never',
              config,
              requiredTools: ['required-tools-probe::cat_cafe_nonexistent_required_tools_probe'],
            }),
          ),
        (error) => {
          assert.ok(error instanceof CodexRequiredToolsUnavailableError);
          assert.deepEqual(error.details.missingTools, [
            'required-tools-probe::cat_cafe_nonexistent_required_tools_probe',
          ]);
          return true;
        },
      );
      assert.equal(
        syntheticProviderRequestCount,
        1,
        'the only synthetic provider request seeds the old thread; preflight must not send a new turn',
      );
      const gitStarts = (await readFile(gitTracePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === 'start');
      assert.ok(gitStarts.length > 0, 'native Git trace must observe the local metadata reads');
      assert.deepEqual(
        gitStarts
          .filter((event) => event.argv?.some((arg) => ['ls-remote', 'clone', 'fetch', 'pull', 'push'].includes(arg)))
          .map((event) => event.argv),
        [],
        'the local MCP protocol fixture must not launch unrelated Git network operations',
      );
    } catch (error) {
      probeFailure = new Error(`real required-tools probe failed during ${phase}`, { cause: error });
    } finally {
      t.signal.removeEventListener('abort', reportAbort);
      const closed = await Promise.allSettled(wires.map((wire) => wire.close()));
      cleanupErrors.push(...closed.filter((result) => result.status === 'rejected').map((result) => result.reason));
      try {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [...(probeFailure ? [probeFailure] : []), ...cleanupErrors],
        'required-tools probe cleanup failed',
      );
    }
    if (probeFailure) throw probeFailure;
  },
);
