/**
 * AcpAgentService unit tests — Phase C: pool-backed AgentService via AcpClient.
 * F161: Renamed from GeminiAcpAdapter tests.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const { AcpAgentService: GeminiAcpAdapter } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js'
);
const { AcpProcessPool } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js');
const { AcpClient } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

const TEST_POOL_KEY = { projectPath: '/tmp', providerProfile: 'test' };

/** Create a minimal mock child process */
function createMockChild() {
  const clientStdin = new PassThrough();
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();

  const ee = new EventEmitter();
  const child = {
    pid: 12345,
    stdin: clientStdin,
    stdout: agentStdout,
    stderr: agentStderr,
    killed: false,
    kill: mock.fn(() => {
      child.killed = true;
      agentStdout.end();
      agentStderr.end();
      ee.emit('exit', 0, null);
      return true;
    }),
    on: ee.on.bind(ee),
    once: ee.once.bind(ee),
    removeListener: ee.removeListener.bind(ee),
  };

  return { child, clientStdin, agentStdout, ee };
}

const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'gemini', title: 'Gemini CLI', version: '0.35' },
  agentCapabilities: { loadSession: true },
};

/**
 * Create a pool backed by a mock spawn function that auto-responds to ACP protocol.
 * Returns { pool, captured } where captured is the list of sent JSON-RPC messages.
 */
function createPoolWithAutoRespond() {
  const { child, clientStdin, agentStdout, ee } = createMockChild();
  const captured = [];

  clientStdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      captured.push(msg);
      if (msg.method === 'initialize') {
        setImmediate(() =>
          agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
        );
      } else if (msg.method === 'session/new') {
        setImmediate(() =>
          agentStdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                sessionId: `sess-${Date.now()}`,
                configOptions: [
                  {
                    id: 'model',
                    type: 'select',
                    currentValue: 'google/gemini-default',
                    options: [
                      { value: 'google/gemini-default', name: 'Gemini Default' },
                      { value: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6' },
                    ],
                  },
                ],
              },
            }) + '\n',
          ),
        );
      } else if (msg.method === 'session/load') {
        setImmediate(() =>
          agentStdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                sessionId: msg.params.sessionId,
                configOptions: [],
              },
            }) + '\n',
          ),
        );
      } else if (msg.method === 'session/set_config_option') {
        setImmediate(() =>
          agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } }) + '\n'),
        );
      } else if (msg.method === 'session/prompt') {
        setImmediate(() => {
          agentStdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: msg.params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from ACP!' } },
              },
            }) + '\n',
          );
          setTimeout(() => {
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          }, 10);
        });
      }
    }
  });

  const pool = new AcpProcessPool(
    { maxLiveProcesses: 5, idleTtlMs: 999_999, healthCheckIntervalMs: 999_999 },
    {},
    () => new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child }),
  );

  return { pool, captured, child, agentStdout, ee };
}

/**
 * Create a pool backed by a custom spawn function.
 */
function createPoolWithSpawn(spawnFn) {
  return new AcpProcessPool(
    { maxLiveProcesses: 5, idleTtlMs: 999_999, healthCheckIntervalMs: 999_999 },
    {},
    () => new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn }),
  );
}

describe('GeminiAcpAdapter', () => {
  let pool = null;

  afterEach(async () => {
    if (pool) {
      await pool.closeAll();
      pool = null;
    }
  });

  it('invoke yields session_init + text + done', async () => {
    const result = createPoolWithAutoRespond();
    pool = result.pool;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('session_init'), `Expected session_init in ${JSON.stringify(types)}`);
    assert.ok(types.includes('text'), `Expected text in ${JSON.stringify(types)}`);
    assert.ok(types.includes('done'), `Expected done in ${JSON.stringify(types)}`);

    for (const msg of messages) {
      assert.equal(msg.catId, 'gemini');
    }

    const textMsg = messages.find((m) => m.type === 'text');
    assert.equal(textMsg.content, 'Hello from ACP!');

    const doneMsg = messages.find((m) => m.type === 'done');
    assert.equal(doneMsg.metadata.provider, 'google');
  });

  it('passes mcpServers to session/new when mcpServers configured', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    // F161: AcpAgentService receives pre-resolved mcpServers from AcpServiceFactory
    // (whitelist → server resolution happens at factory level, not adapter level)
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      mcpServers: [{ name: 'cat-cafe-collab', command: 'node', args: ['collab.js'] }],
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const sessionNew = captured.find((m) => m.method === 'session/new');
    assert.ok(sessionNew, 'Expected session/new in captured messages');
    assert.ok(sessionNew.params.mcpServers.length > 0, 'Should have resolved MCP servers');
    assert.equal(sessionNew.params.mcpServers[0].name, 'cat-cafe-collab');
  });

  it('reloads resumed ACP sessions with fresh callback MCP env', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      mcpServers: [
        {
          name: 'cat-cafe-collab',
          command: 'node',
          args: ['mcp.js'],
          env: [
            { name: 'CAT_CAFE_INVOCATION_ID', value: 'old-invocation' },
            { name: 'CAT_CAFE_CALLBACK_TOKEN', value: 'old-token' },
          ],
        },
      ],
    });

    for await (const _ of adapter.invoke('resume turn', {
      sessionId: 'sess-existing',
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
        CAT_CAFE_INVOCATION_ID: 'new-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'new-token',
        CAT_CAFE_THREAD_ID: 'thread-new',
      },
    })) {
      /* drain */
    }

    const sessionLoad = captured.find((m) => m.method === 'session/load');
    assert.ok(sessionLoad, 'resumed ACP turns must call session/load to refresh per-invocation MCP env');
    assert.equal(sessionLoad.params.sessionId, 'sess-existing');
    assert.equal(
      captured.some((m) => m.method === 'session/new'),
      false,
      'successful resume must not create a new session',
    );
    const env = sessionLoad.params.mcpServers[0].env;
    assert.deepEqual(Object.fromEntries(env.map((entry) => [entry.name, entry.value])), {
      CAT_CAFE_INVOCATION_ID: 'new-invocation',
      CAT_CAFE_CALLBACK_TOKEN: 'new-token',
      CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
      CAT_CAFE_THREAD_ID: 'thread-new',
    });
  });

  it('preserves ACP session affinity when resuming across idle pool clients', async () => {
    const makeClient = (name, ownedSessionIds) => {
      const client = {
        name,
        loadSessionCalls: [],
        newSessionCalls: 0,
        promptedSessionIds: [],
        recentCapacitySignal: null,
        async newSession() {
          client.newSessionCalls++;
          return { sessionId: `${name}-fresh-session` };
        },
        async loadSession(sessionId) {
          client.loadSessionCalls.push(sessionId);
          if (!ownedSessionIds.has(sessionId)) throw new Error(`${name} does not own ${sessionId}`);
          return { sessionId };
        },
        async setSessionConfigOption() {},
        cancelSession() {},
        async *promptStream(sessionId) {
          client.promptedSessionIds.push(sessionId);
          yield {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `resumed via ${name}` } },
          };
        },
        onCapacity() {},
        offCapacity() {},
        clearRecentCapacitySignal() {},
      };
      return client;
    };

    const owningClient = makeClient('owner', new Set(['sess-owned']));
    const wrongClient = makeClient('wrong', new Set());
    const acquireCalls = [];
    const rememberedSessions = [];
    const fakePool = {
      async acquire(poolKey, options) {
        acquireCalls.push({ poolKey, options });
        const client = options?.sessionId === 'sess-owned' ? owningClient : wrongClient;
        return {
          client,
          poolKey,
          release() {},
        };
      },
      rememberSession(_poolKey, sessionId, lease) {
        rememberedSessions.push({ sessionId, client: lease.client.name });
      },
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: fakePool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('resume turn', { sessionId: 'sess-owned' })) {
      messages.push(msg);
    }

    assert.equal(acquireCalls[0].options?.sessionId, 'sess-owned', 'resume acquire must request session affinity');
    assert.deepEqual(owningClient.loadSessionCalls, ['sess-owned']);
    assert.deepEqual(wrongClient.loadSessionCalls, []);
    assert.equal(wrongClient.newSessionCalls, 0, 'resume must not fresh-fallback on a wrong idle client');
    assert.deepEqual(owningClient.promptedSessionIds, ['sess-owned']);
    assert.deepEqual(rememberedSessions, [{ sessionId: 'sess-owned', client: 'owner' }]);
    assert.ok(messages.some((m) => m.type === 'text' && m.content === 'resumed via owner'));
  });

  it('falls back to session/new when resumed ACP session cannot be loaded', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const captured = [];

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        captured.push(msg);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/load') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: 'session not found' },
              }) + '\n',
            ),
          );
        } else if (msg.method === 'session/new') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fresh-session' } }) + '\n',
            ),
          );
        } else if (msg.method === 'session/prompt') {
          setImmediate(() => {
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: msg.params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh ok' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          });
        }
      }
    });

    pool = createPoolWithSpawn(() => child);
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('resume turn', {
      sessionId: 'gone-session',
      resumeFallbackSystemPrompt: 'Static identity prompt',
    })) {
      messages.push(msg);
    }

    const loadIndex = captured.findIndex((m) => m.method === 'session/load');
    const newIndex = captured.findIndex((m) => m.method === 'session/new');
    const promptReq = captured.find((m) => m.method === 'session/prompt');
    assert.ok(loadIndex >= 0, 'resume should try session/load first');
    assert.ok(newIndex > loadIndex, 'failed session/load should fall back to session/new');
    assert.equal(promptReq.params.sessionId, 'fresh-session');
    assert.equal(
      promptReq.params.prompt[0].text,
      'Static identity prompt\n\nresume turn',
      'fresh fallback sessions must receive static identity when the outer resume turn skipped it',
    );
    assert.ok(messages.some((m) => m.type === 'session_init' && m.sessionId === 'fresh-session'));
    assert.ok(messages.some((m) => m.type === 'text' && m.content === 'fresh ok'));
  });

  it('sends empty mcpServers when not configured', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    for await (const msg of adapter.invoke('hello')) {
      /* drain */
    }

    const sessionNew = captured.find((m) => m.method === 'session/new');
    assert.ok(sessionNew, 'Expected session/new in captured messages');
    assert.deepStrictEqual(sessionNew.params.mcpServers, []);
  });

  it('F161 P2 regression: mcpSupport:false blocks per-project .mcp.json merge in invoke', async () => {
    // Setup: create a temp directory with a .mcp.json that has a server
    const userProjectDir = mkdtempSync(join(tmpdir(), 'acp-mcp-gate-'));
    writeFileSync(
      join(userProjectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'sneaky-server': { command: 'node', args: ['sneaky.js'] } } }),
    );

    try {
      const { pool: p, captured } = createPoolWithAutoRespond();
      pool = p;
      const adapter = new GeminiAcpAdapter({
        catId: 'gemini',
        pool,
        poolKey: TEST_POOL_KEY,
        projectRoot: '/tmp',
        mcpServers: [], // base servers already gated by resolver
        mcpSupport: false, // member has MCP disabled
      });

      for await (const msg of adapter.invoke('hello', { workingDirectory: userProjectDir })) {
        /* drain */
      }

      const sessionNew = captured.find((m) => m.method === 'session/new');
      assert.ok(sessionNew, 'Expected session/new in captured messages');
      assert.deepStrictEqual(
        sessionNew.params.mcpServers,
        [],
        'mcpSupport:false must block per-project .mcp.json servers — session should have zero MCP servers',
      );
    } finally {
      rmSync(userProjectDir, { recursive: true, force: true });
    }
  });

  it('sets configured ACP session model after newSession and before prompt', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'opencode',
      modelName: 'anthropic/claude-opus-4-6',
      sessionModel: 'anthropic/claude-opus-4-6',
    });

    for await (const _ of adapter.invoke('hello')) {
      /* drain */
    }

    const sessionNewIndex = captured.findIndex((m) => m.method === 'session/new');
    const setModelIndex = captured.findIndex((m) => m.method === 'session/set_config_option');
    const promptIndex = captured.findIndex((m) => m.method === 'session/prompt');
    assert.ok(sessionNewIndex >= 0, 'Expected session/new');
    assert.ok(setModelIndex >= 0, 'Expected session/set_config_option');
    assert.ok(promptIndex >= 0, 'Expected session/prompt');
    assert.ok(sessionNewIndex < setModelIndex, 'set_config_option must happen after session/new');
    assert.ok(setModelIndex < promptIndex, 'set_config_option must happen before session/prompt');
    assert.equal(captured[setModelIndex].params.configId, 'model');
    assert.equal(captured[setModelIndex].params.value, 'anthropic/claude-opus-4-6');
  });

  it('does not set ACP session model when the agent model option does not allow it', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();
    const captured = [];

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        captured.push(msg);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  sessionId: 'sess-model-mismatch',
                  configOptions: [
                    {
                      id: 'model',
                      type: 'select',
                      currentValue: 'anthropic/claude-opus-4-6',
                      options: [{ value: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6' }],
                    },
                  ],
                },
              }) + '\n',
            ),
          );
        } else if (msg.method === 'session/prompt') {
          setImmediate(() => {
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: msg.params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          });
        }
      }
    });

    pool = new AcpProcessPool(
      { maxLiveProcesses: 5, idleTtlMs: 999_999, healthCheckIntervalMs: 999_999 },
      {},
      () => new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child }),
    );
    const adapter = new GeminiAcpAdapter({
      catId: 'opencode',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'opencode',
      modelName: 'openai-compact/claude-opus-4-6',
      sessionModel: 'openai-compact/claude-opus-4-6',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) messages.push(msg);

    assert.equal(
      captured.some((m) => m.method === 'session/set_config_option'),
      false,
      'must not send unsupported model value to ACP agent',
    );
    assert.ok(
      captured.some((m) => m.method === 'session/prompt'),
      'should continue with the agent default model',
    );
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'invoke should complete',
    );
  });

  it('continues when optional ACP session model selection is rejected by the agent', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  sessionId: 'sess-model-error',
                  configOptions: [
                    {
                      id: 'model',
                      type: 'select',
                      currentValue: 'google/gemini-default',
                      options: [{ value: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6' }],
                    },
                  ],
                },
              }) + '\n',
            ),
          );
        } else if (msg.method === 'session/set_config_option') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32602, message: 'model not found' },
              }) + '\n',
            ),
          );
        } else if (msg.method === 'session/prompt') {
          setImmediate(() => {
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: msg.params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          });
        }
      }
    });

    pool = new AcpProcessPool(
      { maxLiveProcesses: 5, idleTtlMs: 999_999, healthCheckIntervalMs: 999_999 },
      {},
      () => new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child }),
    );
    const adapter = new GeminiAcpAdapter({
      catId: 'opencode',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'opencode',
      modelName: 'anthropic/claude-opus-4-6',
      sessionModel: 'anthropic/claude-opus-4-6',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) messages.push(msg);

    assert.ok(
      messages.some((m) => m.type === 'text' && m.content === 'ok'),
      'prompt should continue',
    );
    assert.equal(
      messages.some((m) => m.type === 'error'),
      false,
      'model selection failure must not abort',
    );
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'invoke should complete',
    );
  });

  it('reuses pool client across invocations (warm hit)', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const msgs1 = [];
    for await (const msg of adapter.invoke('first')) msgs1.push(msg);
    assert.ok(msgs1.some((m) => m.type === 'done'));

    const msgs2 = [];
    for await (const msg of adapter.invoke('second')) msgs2.push(msg);
    assert.ok(msgs2.some((m) => m.type === 'done'));

    // Should reuse same process — only 1 initialize
    const initCount = captured.filter((m) => m.method === 'initialize').length;
    assert.equal(initCount, 1, `Expected exactly 1 initialize, got ${initCount}`);

    // Should have 2 session/new calls
    const sessionNewCount = captured.filter((m) => m.method === 'session/new').length;
    assert.equal(sessionNewCount, 2, `Expected 2 session/new, got ${sessionNewCount}`);

    // Pool metrics: 1 cold start, 1 warm hit
    const metrics = pool.getMetrics();
    assert.strictEqual(metrics.coldStartCount, 1);
    assert.strictEqual(metrics.warmHitCount, 1);
  });

  it('classifies init failure when pool.acquire fails', async () => {
    const ee = new EventEmitter();
    const child = {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: mock.fn(() => {
        child.killed = true;
        return true;
      }),
      on: ee.on.bind(ee),
      once: ee.once.bind(ee),
      removeListener: ee.removeListener.bind(ee),
    };

    pool = createPoolWithSpawn(() => {
      setImmediate(() => ee.emit('error', new Error('spawn bad-cmd ENOENT')));
      return child;
    });

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield an error message');
    assert.ok(
      errorMsg.error.includes('init_failure') || errorMsg.errorCode === 'init_failure',
      `Expected init_failure classification, got: ${errorMsg.error} / ${errorMsg.errorCode}`,
    );
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'Should yield done after error',
    );

    child.stdout.end();
  });

  it('prepends system prompt to prompt text', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    for await (const _ of adapter.invoke('user question', { systemPrompt: 'You are a cat.' })) {
    }

    const promptReq = captured.find((m) => m.method === 'session/prompt');
    assert.ok(promptReq, 'Should have sent session/prompt');
    const promptText = promptReq.params.prompt[0].text;
    assert.ok(promptText.startsWith('You are a cat.'), `Prompt should start with system prompt`);
    assert.ok(promptText.includes('user question'), 'Prompt should contain user question');
  });

  it('P1-2: classifies mcp_pollution errors', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'mcp-sess' } }) + '\n'),
          );
        } else if (msg.method === 'session/prompt') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32002, message: 'MCP server cat-cafe-collab failed to initialize: timeout after 30s' },
              }) + '\n',
            ),
          );
        }
      }
    });

    pool = createPoolWithSpawn(() => child);
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error');
    assert.equal(errorMsg.errorCode, 'mcp_pollution', `Expected mcp_pollution, got: ${errorMsg.errorCode}`);
  });
});

describe('GeminiAcpAdapter integration', () => {
  let pool = null;

  afterEach(async () => {
    if (pool) {
      await pool.closeAll();
      pool = null;
    }
  });

  it('full invoke flow: session_init → text + thought → tool_use → text → done', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'integ-sess' } }) + '\n',
            ),
          );
        } else if (msg.method === 'session/prompt') {
          const sid = msg.params.sessionId;
          setImmediate(() => {
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: sid,
                  update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me check...' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: sid,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I found ' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: sid,
                  update: { sessionUpdate: 'tool_call', toolName: 'read_file', toolInput: { path: '/a.txt' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: sid,
                  update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: sid,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the answer.' } },
                },
              }) + '\n',
            );
          });
          setTimeout(() => {
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          }, 30);
        }
      }
    });

    pool = createPoolWithSpawn(() => child);
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('what is this?')) {
      messages.push(msg);
    }

    const types = messages.map((m) => m.type);
    assert.deepEqual(types, ['session_init', 'system_info', 'text', 'tool_use', 'text', 'done']);
    assert.equal(messages[0].sessionId, 'integ-sess');
    const thinking = JSON.parse(messages[1].content);
    assert.equal(thinking.type, 'thinking');
    assert.equal(messages[3].toolName, 'read_file');
  });

  it('P1-1: abort one invocation does not kill concurrent invocations', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();
    let sessionCounter = 0;
    const capturedCancels = [];
    const pendingPrompts = new Map();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          sessionCounter++;
          const sid = `sess-${sessionCounter}`;
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } }) + '\n'),
          );
        } else if (msg.method === 'session/prompt') {
          const sid = msg.params.sessionId;
          pendingPrompts.set(sid, msg.id);
          if (sid === 'sess-1') {
            // Long-running — will be cancelled
          } else if (sid === 'sess-2') {
            setImmediate(() => {
              agentStdout.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: sid,
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'alive!' } },
                  },
                }) + '\n',
              );
              setTimeout(
                () =>
                  agentStdout.write(
                    JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
                  ),
                10,
              );
            });
          }
        } else if (msg.method === 'session/cancel') {
          const cancelSid = msg.params?.sessionId;
          capturedCancels.push(cancelSid);
          const promptId = pendingPrompts.get(cancelSid);
          if (promptId) {
            setTimeout(() => {
              agentStdout.write(
                JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } }) + '\n',
              );
            }, 5);
          }
        }
      }
    });

    pool = createPoolWithSpawn(() => child);
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const ac1 = new AbortController();
    const msgs1 = [];
    const msgs2 = [];

    const invoke1 = (async () => {
      for await (const msg of adapter.invoke('task1', { signal: ac1.signal })) {
        msgs1.push(msg);
        if (msg.type === 'session_init') {
          setTimeout(() => ac1.abort(), 5);
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 30));

    const invoke2 = (async () => {
      for await (const msg of adapter.invoke('task2')) {
        msgs2.push(msg);
      }
    })();

    await Promise.all([invoke1, invoke2]);

    const types2 = msgs2.map((m) => m.type);
    assert.ok(types2.includes('text'), `Invocation 2 should have text, got: ${JSON.stringify(types2)}`);
    assert.ok(types2.includes('done'), `Invocation 2 should have done, got: ${JSON.stringify(types2)}`);
    assert.ok(capturedCancels.includes('sess-1'), `Should cancel sess-1, got: ${JSON.stringify(capturedCancels)}`);
  });

  it('R2-P1: abort during newSession window still cancels the session', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();
    let sawCancel = false;

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          setTimeout(
            () =>
              agentStdout.write(
                JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'slow-sess' } }) + '\n',
              ),
            30,
          );
        } else if (msg.method === 'session/prompt') {
          setImmediate(() => {
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: msg.params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'oops' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          });
        } else if (msg.method === 'session/cancel') {
          sawCancel = true;
        }
      }
    });

    const ac = new AbortController();
    pool = createPoolWithSpawn(() => child);
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    // Abort 10ms in — during the 30ms newSession delay
    setTimeout(() => ac.abort(), 10);

    const messages = [];
    for await (const msg of adapter.invoke('hello', { signal: ac.signal })) {
      messages.push(msg);
    }

    const types = messages.map((m) => m.type);
    assert.ok(!types.includes('text'), `Should NOT have text after abort, got: ${JSON.stringify(types)}`);
    assert.ok(types.includes('done'), `Should yield done, got: ${JSON.stringify(types)}`);
  });

  it('R3-P1: abort right after session_init does not run prompt', async () => {
    const { child, clientStdin, agentStdout, ee } = createMockChild();
    let sawPrompt = false;

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }) + '\n'),
          );
        } else if (msg.method === 'session/new') {
          setImmediate(() =>
            agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'r3-sess' } }) + '\n'),
          );
        } else if (msg.method === 'session/prompt') {
          sawPrompt = true;
          setImmediate(() => {
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: msg.params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'should not see' } },
                },
              }) + '\n',
            );
            agentStdout.write(
              JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\n',
            );
          });
        }
      }
    });

    const ac = new AbortController();
    pool = createPoolWithSpawn(() => child);
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello', { signal: ac.signal })) {
      messages.push(msg);
      if (msg.type === 'session_init') {
        ac.abort();
      }
    }

    const types = messages.map((m) => m.type);
    assert.ok(!types.includes('text'), `Should NOT have text after abort, got: ${JSON.stringify(types)}`);
    assert.ok(types.includes('done'), `Should yield done, got: ${JSON.stringify(types)}`);
    assert.ok(!sawPrompt, 'Prompt should NOT have been sent after abort');
  });

  it('P2: pre-aborted signal short-circuits immediately', async () => {
    const result = createPoolWithAutoRespond();
    pool = result.pool;
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'google',
      modelName: 'gemini-acp',
    });

    const ac = new AbortController();
    ac.abort(); // Abort BEFORE invoke

    const messages = [];
    for await (const msg of adapter.invoke('hello', { signal: ac.signal })) {
      messages.push(msg);
    }

    const types = messages.map((m) => m.type);
    assert.ok(!types.includes('session_init'), `Should NOT reach session_init, got: ${JSON.stringify(types)}`);
    assert.ok(types.includes('error'), `Should yield error, got: ${JSON.stringify(types)}`);
    assert.ok(types.includes('done'), `Should yield done, got: ${JSON.stringify(types)}`);
  });

  it('timeout with capacity stderr yields model_capacity not turn_budget_exceeded', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const listeners = new Set();
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      newSession: async () => ({ sessionId: 'cap-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Emit capacity signal before timeout (stderr arrived during prompt)
        for (const fn of listeners)
          fn({
            message: 'No capacity available for model gemini-3.1-pro-preview on the server',
            timestamp: Date.now(),
          });
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    assert.equal(errorMsg.errorCode, 'model_capacity', `Expected model_capacity, got ${errorMsg.errorCode}`);
    assert.match(errorMsg.error, /capacity|429/i, 'Error message should mention capacity');
  });

  it('P1: late stderr capacity signal (after timeout) still reclassifies via grace window', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const listeners = new Set();
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      newSession: async () => ({ sessionId: 'late-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Simulate: timeout fires, then stderr arrives 500ms later (during grace window)
        setTimeout(() => {
          const signal = {
            message: 'MODEL_CAPACITY_EXHAUSTED: No capacity available for gemini-3.1-pro-preview',
            timestamp: Date.now(),
          };
          for (const fn of listeners) fn(signal);
        }, 500);
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    assert.equal(
      errorMsg.errorCode,
      'model_capacity',
      `Expected model_capacity after grace window, got ${errorMsg.errorCode}`,
    );
  });

  it('capacity signal during newSession window is captured (invoke-level scope, by design)', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const listeners = new Set();
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      newSession: async () => {
        // Emit capacity signal DURING newSession (provider is 429-ing right now)
        const signal = {
          message: 'No capacity available during session setup',
          timestamp: Date.now(),
        };
        for (const fn of listeners) fn(signal);
        return { sessionId: 'newsess-cap' };
      },
      cancelSession: () => {},
      async *promptStream() {
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    // Provider was capacity-constrained during newSession → correct to classify as model_capacity
    assert.equal(
      errorMsg.errorCode,
      'model_capacity',
      `Expected model_capacity for signal during newSession, got ${errorMsg.errorCode}`,
    );
  });

  it('no capacity stderr during prompt yields turn_budget_exceeded (listener isolation)', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      newSession: async () => ({ sessionId: 'clean-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Pure timeout — no capacity signal emitted to listener
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    assert.equal(
      errorMsg.errorCode,
      'turn_budget_exceeded',
      `Expected turn_budget_exceeded when no capacity signal, got ${errorMsg.errorCode}`,
    );
  });

  it('concurrent prompts on same client both capture provider-level capacity signal', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const listeners = new Set();
    let sessionCounter = 0;
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      newSession: async () => ({ sessionId: `conc-sess-${++sessionCounter}` }),
      cancelSession: () => {},
      async *promptStream(sessionId) {
        // First session emits capacity signal (Google 429); second does not
        if (sessionId === 'conc-sess-1') {
          setTimeout(() => {
            const signal = {
              message: 'MODEL_CAPACITY_EXHAUSTED on gemini-3.1-pro',
              timestamp: Date.now(),
            };
            for (const fn of listeners) fn(signal);
          }, 50);
        }
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    // Helper to collect all messages from an invoke stream
    async function collect(stream) {
      const msgs = [];
      for await (const msg of stream) msgs.push(msg);
      return msgs;
    }

    // Two concurrent prompts on the same client (multiplexed pool)
    const [msgs1, msgs2] = await Promise.all([
      collect(adapter.invoke('prompt-1')),
      collect(adapter.invoke('prompt-2')),
    ]);

    const err1 = msgs1.find((m) => m.type === 'error');
    const err2 = msgs2.find((m) => m.type === 'error');
    assert.ok(err1 && err2, 'Both prompts should yield errors');
    // Both should see model_capacity: same process = same provider = same capacity constraint
    assert.equal(err1.errorCode, 'model_capacity', `Prompt 1: expected model_capacity, got ${err1.errorCode}`);
    assert.equal(err2.errorCode, 'model_capacity', `Prompt 2: expected model_capacity, got ${err2.errorCode}`);
  });

  it('fallback: timeout with no invoke signal but recent client-level signal → model_capacity', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      // Client-level signal from a PREVIOUS invoke (delayed stderr, 2 minutes ago)
      recentCapacitySignal: {
        message: 'MODEL_CAPACITY_EXHAUSTED: No capacity for gemini-3.1-pro-preview',
        timestamp: Date.now() - 2 * 60 * 1000,
      },
      newSession: async () => ({ sessionId: 'fallback-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Pure timeout — no invoke-level signal emitted via listeners
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    assert.equal(
      errorMsg.errorCode,
      'model_capacity',
      `Expected model_capacity via fallback, got ${errorMsg.errorCode}`,
    );
    assert.match(errorMsg.error, /recent_process_signal/, 'Should indicate evidence source');
  });

  it('fallback: stale client-level signal (>10 min old) does NOT trigger model_capacity', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      // Stale signal from 15 minutes ago — should NOT be used
      recentCapacitySignal: {
        message: 'MODEL_CAPACITY_EXHAUSTED old',
        timestamp: Date.now() - 15 * 60 * 1000,
      },
      newSession: async () => ({ sessionId: 'stale-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    assert.equal(
      errorMsg.errorCode,
      'turn_budget_exceeded',
      `Expected turn_budget_exceeded for stale signal, got ${errorMsg.errorCode}`,
    );
  });

  it('production path: timeout → delayed stderr → next timeout classified via fallback', async () => {
    // Mirrors production timeline: timeout at T, stderr arrives at T+5min,
    // next invoke times out and gets classified as model_capacity via recentCapacitySignal.
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    let invokeCount = 0;
    const recentSignal = { message: '', timestamp: 0 };
    const listeners = new Set();

    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      get recentCapacitySignal() {
        return recentSignal.timestamp > 0 ? recentSignal : null;
      },
      newSession: async () => ({ sessionId: `prod-sess-${++invokeCount}` }),
      cancelSession: () => {},
      async *promptStream() {
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    // --- Invoke 1: timeout with no signal anywhere → turn_budget_exceeded ---
    const msgs1 = [];
    for await (const msg of adapter.invoke('first prompt')) {
      msgs1.push(msg);
    }
    const err1 = msgs1.find((m) => m.type === 'error');
    assert.equal(err1.errorCode, 'turn_budget_exceeded', 'First invoke: no signal → turn_budget_exceeded');

    // --- Simulate: 429 stderr arrives 5 min later (between invokes) ---
    // Listener was removed by first invoke's finally block, so this only hits client-level capture
    recentSignal.message = 'MODEL_CAPACITY_EXHAUSTED: No capacity for gemini-3.1-pro-preview';
    recentSignal.timestamp = Date.now();

    // --- Invoke 2: timeout again, but client has recent capacity signal → model_capacity ---
    const msgs2 = [];
    for await (const msg of adapter.invoke('second prompt')) {
      msgs2.push(msg);
    }
    const err2 = msgs2.find((m) => m.type === 'error');
    assert.equal(
      err2.errorCode,
      'model_capacity',
      `Second invoke: expected model_capacity via fallback, got ${err2.errorCode}`,
    );
    assert.match(err2.error, /recent_process_signal/, 'Should mention evidence source');
  });

  it('P1-review: successful invoke clears recentCapacitySignal — no false blame on next timeout', async () => {
    // Reproduces gpt52's P1: 429 → success → unrelated timeout should NOT be model_capacity.
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    let invokeCount = 0;
    let _recentSignal = {
      message: 'MODEL_CAPACITY_EXHAUSTED: stale signal from earlier',
      timestamp: Date.now() - 60_000, // 1 minute ago — within 10min window
    };
    const listeners = new Set();

    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      get recentCapacitySignal() {
        return _recentSignal;
      },
      clearRecentCapacitySignal() {
        _recentSignal = null;
      },
      newSession: async () => ({ sessionId: `recovery-sess-${++invokeCount}` }),
      cancelSession: () => {},
      async *promptStream() {
        if (invokeCount === 1) {
          // Invoke 1: succeeds — yields content, no throw
          yield { type: 'content', content: [{ type: 'text', text: 'ok' }] };
        } else {
          // Invoke 2: pure timeout — unrelated to Google capacity
          throw new AcpTimeoutError('session/prompt', 120000);
        }
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    // --- Invoke 1: succeeds (provider recovered) — should clear recent signal ---
    const msgs1 = [];
    for await (const msg of adapter.invoke('prompt after recovery')) {
      msgs1.push(msg);
    }
    assert.ok(
      msgs1.some((m) => m.type === 'done'),
      'Invoke 1 should complete successfully',
    );
    assert.ok(!msgs1.some((m) => m.type === 'error'), 'Invoke 1 should have no errors');

    // --- Invoke 2: timeout, but provider had recovered → must be turn_budget_exceeded ---
    const msgs2 = [];
    for await (const msg of adapter.invoke('unrelated timeout')) {
      msgs2.push(msg);
    }
    const err2 = msgs2.find((m) => m.type === 'error');
    assert.ok(err2, 'Invoke 2 should yield error');
    assert.equal(
      err2.errorCode,
      'turn_budget_exceeded',
      `Expected turn_budget_exceeded after recovery, got ${err2.errorCode} — stale signal should have been cleared`,
    );
  });

  // ─── F149: Capacity Realtime Warning Tests ────────────────────

  it('F149: capacity signal during active stream yields provider_signal warning (deduped)', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'warn-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Synthetic capacity event (as real AcpClient.promptStream injects from stderr)
        yield {
          sessionId: 'warn-sess',
          update: {
            sessionUpdate: 'provider_capacity_signal',
            message: 'No capacity available',
            timestamp: Date.now(),
          },
        };
        yield {
          sessionId: 'warn-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk1' } },
        };
        // Second capacity event (should be deduped)
        yield {
          sessionId: 'warn-sess',
          update: {
            sessionUpdate: 'provider_capacity_signal',
            message: 'Attempt 2 failed with status 429',
            timestamp: Date.now(),
          },
        };
        yield {
          sessionId: 'warn-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk2' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.equal(warnings.length, 1, `Expected exactly 1 provider_signal, got ${warnings.length}`);

    const parsed = JSON.parse(warnings[0].content);
    assert.equal(parsed.type, 'warning');
    assert.match(parsed.message, /容量不足|Gemini/);

    // Normal text should still be present
    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 2, `Expected 2 text messages, got ${texts.length}`);
  });

  it('F149: capacity warning on zero-event timeout — late signal via catch path', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    // This tests the fallback: capacity signal arrives via adapter-level onCapacity
    // (not through promptStream), e.g. late stderr during grace window.
    const listeners = new Set();
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      recentCapacitySignal: { message: 'No capacity available', timestamp: Date.now() },
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'catch-warn-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Signal via adapter-level listener (simulating late stderr, not injected into stream)
        for (const fn of listeners) fn({ message: 'No capacity available', timestamp: Date.now() });
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    // Warning should appear BEFORE the error
    const warningIdx = messages.findIndex((m) => m.type === 'provider_signal');
    const errorIdx = messages.findIndex((m) => m.type === 'error');
    assert.ok(warningIdx >= 0, 'Should have a provider_signal warning');
    assert.ok(errorIdx >= 0, 'Should have an error');
    assert.ok(warningIdx < errorIdx, `Warning (idx ${warningIdx}) should come before error (idx ${errorIdx})`);

    const parsed = JSON.parse(messages[warningIdx].content);
    assert.equal(parsed.type, 'warning');
    assert.match(parsed.message, /容量不足/);
  });

  it('F149-P1: zero-event stall — capacity signal breaks through via stream event', async () => {
    const { AcpTimeoutError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'p1-stall-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Real AcpClient.promptStream injects capacity signals as synthetic events.
        // This breaks through zero-event stalls — the adapter sees this immediately.
        yield {
          sessionId: 'p1-stall-sess',
          update: {
            sessionUpdate: 'provider_capacity_signal',
            message: 'No capacity available',
            timestamp: Date.now(),
          },
        };
        // Then timeout (simulating the silent stall continuing until timeout)
        throw new AcpTimeoutError('session/prompt', 120000);
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    // P1 fix: warning is yielded from the stream loop (not catch path)
    const warningIdx = messages.findIndex((m) => m.type === 'provider_signal');
    const errorIdx = messages.findIndex((m) => m.type === 'error');
    assert.ok(warningIdx >= 0, 'Should have a provider_signal warning from stream event');
    assert.ok(errorIdx >= 0, 'Should have an error');
    assert.ok(warningIdx < errorIdx, `Warning (idx ${warningIdx}) should come before error (idx ${errorIdx})`);

    const parsed = JSON.parse(messages[warningIdx].content);
    assert.equal(parsed.type, 'warning');
    assert.match(parsed.message, /容量不足/);

    // Error should be classified as model_capacity (capacitySignal was set from stream event)
    assert.match(messages[errorIdx].error, /model_capacity/);
  });

  it('F149: no capacity signal = no provider_signal warning', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'no-warn-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        yield {
          sessionId: 'no-warn-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'clean' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.equal(warnings.length, 0, 'Should have no provider_signal when no capacity issue');
  });

  it('F149: provider_signal does not replay stale recentCapacitySignal from previous invoke', async () => {
    let invokeCount = 0;
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal() {
        this.recentCapacitySignal = null;
      },
      newSession: async () => ({ sessionId: `replay-sess-${++invokeCount}` }),
      cancelSession: () => {},
      async *promptStream() {
        // Only yield capacity event on FIRST invoke
        if (invokeCount === 1) {
          yield {
            sessionId: `replay-sess-${invokeCount}`,
            update: { sessionUpdate: 'provider_capacity_signal', message: 'Stale 429 signal', timestamp: Date.now() },
          };
        }
        yield {
          sessionId: `replay-sess-${invokeCount}`,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    // Invoke 1: capacity signal fires during promptStream → yields warning
    const msgs1 = [];
    for await (const msg of adapter.invoke('first')) msgs1.push(msg);
    assert.equal(msgs1.filter((m) => m.type === 'provider_signal').length, 1, 'Invoke 1 should have warning');

    // Invoke 2: no new stderr — should have NO warning (fresh signal only, per-invoke dedup reset)
    const msgs2 = [];
    for await (const msg of adapter.invoke('second')) msgs2.push(msg);
    assert.equal(
      msgs2.filter((m) => m.type === 'provider_signal').length,
      0,
      'Invoke 2 should NOT replay stale warning',
    );
  });

  // ─── F149: Stream Idle Watchdog Tests ─────────────────────────

  it('F149: stream idle warning after events yields liveness_signal', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'idle-warn-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Normal event first (eventCount becomes > 0)
        yield {
          sessionId: 'idle-warn-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking...' } },
        };
        // Idle warning injected by AcpClient after ~20s silence
        yield {
          sessionId: 'idle-warn-sess',
          update: {
            sessionUpdate: 'stream_idle_warning',
            idleSinceMs: 20000,
            eventCount: 1,
            timestamp: Date.now(),
          },
        };
        // More content arrives (provider recovered)
        yield {
          sessionId: 'idle-warn-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the answer' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    // Should have a liveness_signal warning
    const warnings = messages.filter((m) => m.type === 'liveness_signal');
    assert.equal(
      warnings.length,
      1,
      `Expected 1 liveness_signal, got ${warnings.length}: ${JSON.stringify(messages.map((m) => m.type))}`,
    );

    const parsed = JSON.parse(warnings[0].content);
    assert.equal(parsed.type, 'warning');
    assert.match(parsed.message, /停滞|idle|silent/i);

    // Normal text should still be present
    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 2, `Expected 2 text messages, got ${texts.length}`);
  });

  it('F149: stream idle stall classified as stream_idle_stall (not turn_budget_exceeded)', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'idle-stall-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Real events arrive (eventCount > 0)
        yield {
          sessionId: 'idle-stall-sess',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me think...' } },
        };
        yield {
          sessionId: 'idle-stall-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } },
        };
        // AcpClient idle timer fires at 45s — throws stream idle error
        const err = new Error('Stream idle: no events for 45000ms after 2 events received');
        err.code = 'STREAM_IDLE_STALL';
        throw err;
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'Should yield error message');
    assert.equal(errorMsg.errorCode, 'stream_idle_stall', `Expected stream_idle_stall, got ${errorMsg.errorCode}`);
    // Should still have partial text from before the stall
    const texts = messages.filter((m) => m.type === 'text');
    assert.ok(texts.length > 0, 'Should have partial text from before stall');
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'Should yield done after error',
    );
  });

  it('thinking buffer flushes before error on stream failure (P2: catch path must not lose pending thinking)', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'think-err-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Only thinking chunks — no non-thinking event to trigger flush
        yield {
          sessionId: 'think-err-sess',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Step 1: check the ' } },
        };
        yield {
          sessionId: 'think-err-sess',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'database schema' } },
        };
        // Stream error — pending thinking must flush before error
        const err = new Error('Stream idle: no events for 45000ms after 2 events received');
        err.code = 'STREAM_IDLE_STALL';
        throw err;
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    // Thinking must appear before error
    const thinkingMsg = messages.find((m) => m.type === 'system_info' && m.content.includes('"thinking"'));
    assert.ok(thinkingMsg, 'Pending thinking must be flushed before error');
    const thinkingContent = JSON.parse(thinkingMsg.content);
    assert.equal(thinkingContent.text, 'Step 1: check the database schema', 'All thinking chunks must be concatenated');

    // Order: thinking must come before error
    const thinkingIdx = messages.indexOf(thinkingMsg);
    const errorIdx = messages.findIndex((m) => m.type === 'error');
    assert.ok(thinkingIdx < errorIdx, `thinking (idx=${thinkingIdx}) must precede error (idx=${errorIdx})`);
  });

  it('surfaces compaction loop cancellation as an error instead of a successful turn', async () => {
    let cancelCount = 0;
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'scratchpad-loop-sess' }),
      cancelSession: (sessionId) => {
        assert.equal(sessionId, 'scratchpad-loop-sess');
        cancelCount++;
      },
      async *promptStream() {
        yield {
          sessionId: 'scratchpad-loop-sess',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Visible answer before compaction. ## Goal\n- summarize context\n\nConstraints & Preferences\n- continue',
            },
          },
        };
        for (let i = 0; i < 50; i++) {
          yield {
            sessionId: 'scratchpad-loop-sess',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `\n## Progress\n- compacting ${i}` },
            },
          };
        }
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    assert.equal(cancelCount, 1, 'Compaction loop breaker must cancel the ACP session exactly once');
    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, `Expected compaction cancellation error, got: ${JSON.stringify(messages.map((m) => m.type))}`);
    assert.equal(errorMsg.errorCode, 'prompt_failure');
    assert.ok(errorMsg.error.includes('compaction'), `Error should explain compaction cancellation: ${errorMsg.error}`);

    const doneIdx = messages.findIndex((m) => m.type === 'done');
    const errorIdx = messages.indexOf(errorMsg);
    assert.ok(doneIdx > errorIdx, 'done should be emitted only after the compaction error');
  });

  it('F149: liveness_signal warning appears before stream_idle_stall error', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'idle-order-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        // Normal event
        yield {
          sessionId: 'idle-order-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'start' } },
        };
        // Warning at ~20s
        yield {
          sessionId: 'idle-order-sess',
          update: {
            sessionUpdate: 'stream_idle_warning',
            idleSinceMs: 20000,
            eventCount: 1,
            timestamp: Date.now(),
          },
        };
        // Stall at ~45s — terminates
        const err = new Error('Stream idle: no events for 45000ms after 1 events received');
        err.code = 'STREAM_IDLE_STALL';
        throw err;
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const warningIdx = messages.findIndex((m) => m.type === 'liveness_signal');
    const errorIdx = messages.findIndex((m) => m.type === 'error');
    assert.ok(
      warningIdx >= 0,
      `Should have liveness_signal, got types: ${JSON.stringify(messages.map((m) => m.type))}`,
    );
    assert.ok(errorIdx >= 0, 'Should have error');
    assert.ok(warningIdx < errorIdx, `Warning (idx ${warningIdx}) should come before error (idx ${errorIdx})`);
    assert.equal(messages[errorIdx].errorCode, 'stream_idle_stall');
  });

  it('F149: stream idle warning is deduped (only one liveness_signal per invoke)', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'idle-dedup-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        yield {
          sessionId: 'idle-dedup-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk1' } },
        };
        // First idle warning
        yield {
          sessionId: 'idle-dedup-sess',
          update: { sessionUpdate: 'stream_idle_warning', idleSinceMs: 20000, eventCount: 1, timestamp: Date.now() },
        };
        // More content
        yield {
          sessionId: 'idle-dedup-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk2' } },
        };
        // Second idle warning (should be deduped)
        yield {
          sessionId: 'idle-dedup-sess',
          update: { sessionUpdate: 'stream_idle_warning', idleSinceMs: 20000, eventCount: 2, timestamp: Date.now() },
        };
        yield {
          sessionId: 'idle-dedup-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk3' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const warnings = messages.filter((m) => m.type === 'liveness_signal');
    assert.equal(warnings.length, 1, `Expected exactly 1 liveness_signal (deduped), got ${warnings.length}`);

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 3, `Expected 3 text messages, got ${texts.length}`);
  });

  it('stream_tool_wait_warning yields info liveness_signal (not error)', async () => {
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: () => {},
      offCapacity: () => {},
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => ({ sessionId: 'tool-wait-sess' }),
      cancelSession: () => {},
      async *promptStream() {
        yield {
          sessionId: 'tool-wait-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking...' } },
        };
        // Gemini calls a tool — idle watchdog fires tool_wait instead of idle_warning
        yield {
          sessionId: 'tool-wait-sess',
          update: {
            sessionUpdate: 'stream_tool_wait_warning',
            idleSinceMs: 20000,
            eventCount: 2,
            timestamp: Date.now(),
          },
        };
        // Tool returns, Gemini resumes
        yield {
          sessionId: 'tool-wait-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'result' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const liveness = messages.filter((m) => m.type === 'liveness_signal');
    assert.equal(liveness.length, 1, `Expected 1 tool wait liveness_signal, got ${liveness.length}`);
    const parsed = JSON.parse(liveness[0].content);
    assert.equal(parsed.type, 'info', 'Tool wait should be info, not warning');
    assert.ok(parsed.message.includes('等待工具'), `Message should mention tool wait: ${parsed.message}`);

    // No error — tool wait doesn't kill the stream
    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(errors.length, 0, 'Tool wait should not produce an error');
  });

  it('F149-cloud-P1: pre-stream capacity signal surfaces on first real event', async () => {
    // Codex cloud P1: capacity signal fired during newSession (before promptStream),
    // then prompt succeeds with normal events. Warning must still appear.
    const listeners = new Set();
    const fakeClient = {
      isAlive: true,
      initialize: async () => ({}),
      close: async () => {},
      onCapacity: (fn) => listeners.add(fn),
      offCapacity: (fn) => listeners.delete(fn),
      recentCapacitySignal: null,
      clearRecentCapacitySignal: () => {},
      newSession: async () => {
        // Capacity signal fires during session creation (before promptStream)
        for (const fn of listeners) fn({ message: 'No capacity available (during newSession)', timestamp: Date.now() });
        return { sessionId: 'pre-stream-sess' };
      },
      cancelSession: () => {},
      async *promptStream() {
        // Normal events only — no synthetic capacity event
        yield {
          sessionId: 'pre-stream-sess',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } },
        };
        return 'end_turn';
      },
    };

    const mockPool = {
      acquire: async () => ({ client: fakeClient, release: () => {} }),
      closeAll: async () => {},
    };

    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool: mockPool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
    });

    const messages = [];
    for await (const msg of adapter.invoke('hello')) {
      messages.push(msg);
    }

    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.equal(warnings.length, 1, 'Pre-stream capacity signal should yield 1 warning');

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 1, 'Normal text should still appear');

    // Warning should come before text
    const warnIdx = messages.indexOf(warnings[0]);
    const textIdx = messages.indexOf(texts[0]);
    assert.ok(warnIdx < textIdx, `Warning (idx ${warnIdx}) should come before text (idx ${textIdx})`);
  });
});

describe('GeminiAcpAdapter callbackEnv passthrough', () => {
  let pool = null;

  afterEach(async () => {
    if (pool) {
      await pool.closeAll();
      pool = null;
    }
  });

  it('merges callbackEnv into cat-cafe servers in session/new', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;

    const mcpServers = [
      { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], env: [] },
      { name: 'cat-cafe-memory', command: 'node', args: ['memory.js'], env: [] },
    ];
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      mcpServers,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-123',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-abc',
      CAT_CAFE_THREAD_ID: 'thread-acp-123',
      CAT_CAFE_USER_ID: 'user-1',
      CAT_CAFE_CAT_ID: 'gemini',
      CAT_CAFE_SIGNAL_USER: 'gemini',
    };

    for await (const _ of adapter.invoke('hello', { callbackEnv })) {
      /* drain */
    }

    const sessionNew = captured.find((m) => m.method === 'session/new');
    assert.ok(sessionNew, 'Expected session/new');
    const servers = sessionNew.params.mcpServers;

    // cat-cafe-collab should have callback env merged
    const collab = servers.find((s) => s.name === 'cat-cafe-collab');
    assert.ok(collab, 'cat-cafe-collab should be present');
    const collabEnvMap = Object.fromEntries(collab.env.map((e) => [e.name, e.value]));
    assert.equal(collabEnvMap.CAT_CAFE_API_URL, 'http://localhost:3004');
    assert.equal(collabEnvMap.CAT_CAFE_INVOCATION_ID, 'inv-123');
    assert.equal(collabEnvMap.CAT_CAFE_CALLBACK_TOKEN, 'tok-abc');
    assert.equal(collabEnvMap.CAT_CAFE_THREAD_ID, 'thread-acp-123');

    // cat-cafe-memory should also get callback env
    const memory = servers.find((s) => s.name === 'cat-cafe-memory');
    assert.ok(memory, 'cat-cafe-memory should be present');
    const memoryEnvMap = Object.fromEntries(memory.env.map((e) => [e.name, e.value]));
    assert.equal(memoryEnvMap.CAT_CAFE_API_URL, 'http://localhost:3004');
    assert.equal(memoryEnvMap.CAT_CAFE_THREAD_ID, 'thread-acp-123');
  });

  it('passes servers unchanged when no callbackEnv', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;

    const mcpServers = [{ name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], env: [] }];
    const adapter = new GeminiAcpAdapter({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      mcpServers,
    });

    for await (const _ of adapter.invoke('test')) {
      /* drain */
    }

    const sessionNew = captured.find((m) => m.method === 'session/new');
    assert.ok(sessionNew, 'Expected session/new');
    // Should have resolved servers from whitelist but without callbackEnv injection
    const collab = sessionNew.params.mcpServers.find((s) => s.name === 'cat-cafe-collab');
    assert.ok(collab, 'cat-cafe-collab should be present');
    assert.deepStrictEqual(collab.env, [], 'No callbackEnv = empty env on builtin servers');
  });

  // F161 architecture change: capabilities.json-aware filtering (disabled capabilities,
  // legacy cat-cafe expansion, expandManagedMcpNamesForUserMerge) moved from adapter
  // invoke-time to factory-level resolveAcpMcpServers(). AcpAgentService.invoke() only
  // does simple name-based user project exclusion via resolveUserProjectMcpServers().
  // Factory/resolver-level tests: acp-mcp-resolver.test.js (37 tests covering disabled
  // capabilities, whitelist expansion, user project merge with managed name exclusion).

  it('user project servers with names not in base servers pass through', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const projectRoot = mkdtempSync(join(tmpdir(), 'gemini-acp-user-passthrough-root-'));
    const userRoot = mkdtempSync(join(tmpdir(), 'gemini-acp-user-passthrough-user-'));
    try {
      writeFileSync(
        join(userRoot, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
            'my-tool': { command: 'node', args: ['tool.js'] },
          },
        }),
        'utf8',
      );

      // No base mcpServers — simulates factory excluding disabled capabilities
      const adapter = new GeminiAcpAdapter({
        catId: 'gemini',
        pool,
        poolKey: TEST_POOL_KEY,
        projectRoot,
      });

      for await (const _ of adapter.invoke('test', { workingDirectory: userRoot })) {
        /* drain */
      }

      const sessionNew = captured.find((m) => m.method === 'session/new');
      assert.ok(sessionNew, 'Expected session/new');
      const names = sessionNew.params.mcpServers.map((s) => s.name);
      // Without base servers, all user servers pass through (no name exclusion)
      assert.deepStrictEqual(names, ['filesystem', 'my-tool']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(userRoot, { recursive: true, force: true });
    }
  });

  it('user project servers with names matching base servers are excluded', async () => {
    const { pool: p, captured } = createPoolWithAutoRespond();
    pool = p;
    const projectRoot = mkdtempSync(join(tmpdir(), 'gemini-acp-user-exclude-root-'));
    const userRoot = mkdtempSync(join(tmpdir(), 'gemini-acp-user-exclude-user-'));
    try {
      writeFileSync(
        join(userRoot, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'cat-cafe-collab': { command: 'python', args: ['override.py'] },
            'my-tool': { command: 'node', args: ['tool.js'] },
          },
        }),
        'utf8',
      );

      const adapter = new GeminiAcpAdapter({
        catId: 'gemini',
        pool,
        poolKey: TEST_POOL_KEY,
        projectRoot,
        mcpServers: [{ name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], env: [] }],
      });

      for await (const _ of adapter.invoke('test', { workingDirectory: userRoot })) {
        /* drain */
      }

      const sessionNew = captured.find((m) => m.method === 'session/new');
      assert.ok(sessionNew, 'Expected session/new');
      const names = sessionNew.params.mcpServers.map((s) => s.name);
      assert.ok(names.includes('cat-cafe-collab'), 'base server retained');
      assert.ok(!names.some((n, i) => n === 'cat-cafe-collab' && i > 0), 'user duplicate excluded');
      assert.ok(names.includes('my-tool'), 'non-conflicting user server included');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
});
