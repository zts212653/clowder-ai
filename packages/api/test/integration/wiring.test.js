/**
 * Integration Wiring Tests
 * 验证 Phase 2.5 CLI 迁移后的组件接线
 *
 * 使用 **真实** service 实例 + mock SpawnFn，验证:
 * - AgentRouter → Service → spawnCli 的参数传递
 * - InvocationRegistry + callbackEnv 端到端
 * - MessageStore 读写一致性
 * - Session 管理跨调用
 * - 多猫串行链路 (isFinal, prompt chaining)
 * - MCP callback HTTP 端点与 route() 协作
 *
 * 不需要真实 CLI，总是运行。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import Fastify from 'fastify';
import { migrateRouterOpts as migrateRouterOptsBase } from '../helpers/agent-registry-helpers.js';
import { fakeL0Compiler } from '../helpers/fake-l0-compiler.js';

// --- Imports (from dist) ---

const { ClaudeAgentService } = await import('../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
const { CodexAgentService } = await import('../../dist/domains/cats/services/agents/providers/CodexAgentService.js');
const { AgyNativeAgentService } = await import(
  '../../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { spawnCli } = await import('../../dist/utils/cli-spawn.js');
const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { ContextEpochOwner } = await import('../../dist/domains/cats/services/session/context/ContextEpochOwner.js');
const { InMemoryContextEpochStore } = await import(
  '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js'
);
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

// --- Helpers ---

/** Collect all items from async iterable */
async function migrateRouterOpts(options) {
  return migrateRouterOptsBase({
    ...options,
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
  });
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/** Create a mock child process (same pattern as unit tests) */
function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  let stdinData = '';
  const proc = {
    stdout,
    stderr,
    // Incident 2026-05-29: prompt 走 stdin（不进 argv）。捕获写入供断言。
    stdin: {
      write: (chunk) => {
        stdinData += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        return true;
      },
      end: () => {},
      on: () => proc.stdin,
    },
    pid: process.pid,
    exitCode: null,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', null, 'SIGTERM');
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    get stdinData() {
      return stdinData;
    },
    _emitter: emitter,
  };
  return proc;
}

/** Write NDJSON events + close process */
function emitEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
}

/** Standard Claude NDJSON: session_init + text */
function claudeEvents(sessionId, text) {
  return [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success' },
  ];
}

/** Standard Codex NDJSON: session_init + text */
function codexEvents(threadId, text) {
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'item.completed', item: { type: 'agent_message', text } },
  ];
}

/** Native AGY stream-json fixture; init fields are filled from the actual launch below. */
function geminiEvents(sessionId, text) {
  return [
    {
      event: 'init',
      conversation_id: sessionId,
      init: { model: 'gemini-3.8-flash-high', permission_mode: 'request-review', tools: [] },
    },
    { event: 'result', result: { conversation_id: sessionId, status: 'SUCCESS', response: text } },
  ];
}

function createNativeFixtureService(spawnFn) {
  const workspace = join(testGlobalConfigRoot, 'native-workspace');
  mkdirSync(join(workspace, '.cat-cafe'), { recursive: true });
  // This test requires collab; an ambient skills-only config correctly enables no MCPs.
  writeFileSync(
    join(workspace, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          source: 'cat-cafe',
          enabled: true,
          mcpServer: { command: 'node', args: [] },
        },
      ],
    }),
  );
  const service = new AgyNativeAgentService({
    catId: 'gemini',
    l0CompilerFn: fakeL0Compiler,
    profile: {
      enabled: true,
      carrier: 'native',
      profileId: 'gemini',
      homeRoot: join(testGlobalConfigRoot, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
    },
  });
  const invoke = service.invokeWithContinuityPreflight.bind(service);
  service.invokeWithContinuityPreflight = (preflight, options) =>
    invoke(preflight, {
      ...options,
      workingDirectory: workspace,
      spawnCliOverride: (launch) => {
        // The router selects shared HTTP. Observe its private per-turn config before retirement.
        const geminiDirArg = launch.args.find((arg) => arg.startsWith('--gemini_dir='));
        assert.ok(geminiDirArg, 'Native launch must identify its per-run configuration');
        const geminiDir = geminiDirArg.slice('--gemini_dir='.length);
        spawnFn._nativeConfigPath = join(geminiDir, 'config/mcp_config.json');
        const config = JSON.parse(readFileSync(spawnFn._nativeConfigPath, 'utf8'));
        const collab = config.mcpServers['cat-cafe-collab'];
        assert.equal(collab.command, undefined);
        const url = new URL(collab.serverUrl);
        assert.equal(url.origin, new URL(options.callbackEnv.CAT_CAFE_API_URL).origin);
        assert.equal(url.searchParams.get('family'), 'collab');
        spawnFn._nativeCredential = {
          invocationId: collab.headers['x-invocation-id'],
          callbackToken: collab.headers['x-callback-token'],
        };
        assert.ok(spawnFn._nativeCredential.callbackToken);
        assert.equal(spawnFn._nativeCredential.callbackToken, options.callbackEnv.CAT_CAFE_CALLBACK_TOKEN);
        assert.equal(
          JSON.stringify({ args: launch.args, env: launch.env }).includes(spawnFn._nativeCredential.callbackToken),
          false,
          'native HTTP authorization stays in the private configuration',
        );
        return spawnCli(launch, { spawnFn });
      },
    });
  return service;
}

/**
 * Create a SpawnFn that creates a fresh mock process per call,
 * emits pre-configured events, and records every call for assertions.
 */
function createTrackingSpawnFn(eventsFn) {
  const calls = [];
  const spawnFn = mock.fn((_cmd, _args, options) => {
    const proc = createMockProcess();
    // Observe the original-turn file at launch, before its owner retires it.
    const credential = options.env?.CAT_CAFE_CREDENTIAL_FILE
      ? JSON.parse(readFileSync(options.env.CAT_CAFE_CREDENTIAL_FILE, 'utf8'))
      : undefined;
    calls.push({ cmd: _cmd, args: _args, options, proc, credential });
    // Schedule events on next tick so caller can start reading
    process.nextTick(() =>
      emitEvents(
        proc,
        eventsFn(calls.length).map((event) =>
          event.event === 'init'
            ? { ...event, init: { ...event.init, agent: _args[_args.indexOf('--agent') + 1], cwd: options.cwd } }
            : event,
        ),
      ),
    );
    return proc;
  });
  spawnFn._calls = calls;
  return spawnFn;
}

function assertCallbackLaunch(call) {
  const env = call.options.env;
  assert.ok(env.CAT_CAFE_INVOCATION_ID);
  assert.ok(env.CAT_CAFE_API_URL);
  assert.ok(env.CAT_CAFE_CREDENTIAL_FILE);
  assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  assert.equal(call.credential?.invocationId, env.CAT_CAFE_INVOCATION_ID);
  assert.ok(call.credential.callbackToken);
  assert.equal(JSON.stringify([call.args, env]).includes(call.credential.callbackToken), false);
  return call.credential;
}

function commandName(command) {
  const parts = command.split(/[\\/]/);
  return parts[parts.length - 1].replace(/\.cmd$/i, '');
}

/** Mock SocketManager */
function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    getMessages() {
      return messages;
    },
  };
}

function installFakeCliPath() {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-wiring-cli-'));
  const writeExecutable = (name, content) => {
    const file = join(dir, name);
    writeFileSync(file, content);
    chmodSync(file, 0o755);
  };

  if (process.platform === 'win32') {
    const content = '@echo off\r\nexit /b 0\r\n';
    writeExecutable('claude.cmd', content);
    writeExecutable('codex.cmd', content);
    writeExecutable('gemini.cmd', content);
    writeExecutable('agy.cmd', content);
  } else {
    const content = '#!/bin/sh\nexit 0\n';
    writeExecutable('claude', content);
    writeExecutable('codex', content);
    writeExecutable('gemini', content);
    writeExecutable('agy', content);
  }

  return dir;
}

let originalGlobalConfigRoot;
let originalHome;
let originalGeminiAdapter;
let originalOpusModel;
let originalCodexModel;
let originalGeminiModel;
let testGlobalConfigRoot;

before(() => {
  originalGlobalConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  originalHome = process.env.HOME;
  originalGeminiAdapter = process.env.GEMINI_ADAPTER;
  originalOpusModel = process.env.CAT_OPUS_MODEL;
  originalCodexModel = process.env.CAT_CODEX_MODEL;
  originalGeminiModel = process.env.CAT_GEMINI_MODEL;
});

beforeEach(async () => {
  // Isolate catalog/credential writes so invoke-single-cat never touches repo-root config.
  testGlobalConfigRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-wiring-global-'));
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = testGlobalConfigRoot;
  process.env.HOME = testGlobalConfigRoot;
  process.env.CAT_OPUS_MODEL = 'claude-opus-test';
  process.env.CAT_CODEX_MODEL = 'gpt-test';
  process.env.CAT_GEMINI_MODEL = 'Gemini 3.1 Pro (High)';

  const { resetMigrationState } = await import('../../dist/config/catalog-accounts.js');
  resetMigrationState();
});

afterEach(() => {
  if (testGlobalConfigRoot) {
    rmSync(testGlobalConfigRoot, { recursive: true, force: true });
    testGlobalConfigRoot = undefined;
  }
  if (originalGlobalConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = originalGlobalConfigRoot;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalGeminiAdapter === undefined) delete process.env.GEMINI_ADAPTER;
  else process.env.GEMINI_ADAPTER = originalGeminiAdapter;
  if (originalOpusModel === undefined) delete process.env.CAT_OPUS_MODEL;
  else process.env.CAT_OPUS_MODEL = originalOpusModel;
  if (originalCodexModel === undefined) delete process.env.CAT_CODEX_MODEL;
  else process.env.CAT_CODEX_MODEL = originalCodexModel;
  if (originalGeminiModel === undefined) delete process.env.CAT_GEMINI_MODEL;
  else process.env.CAT_GEMINI_MODEL = originalGeminiModel;
});

// ===================================================================
// Test Suite: AgentRouter + Services wiring
// ===================================================================

describe('AgentRouter + Services wiring', () => {
  let registry;
  let messageStore;
  let fakeCliDir;
  const originalPath = process.env.PATH ?? '';

  before(() => {
    fakeCliDir = installFakeCliPath();
    process.env.PATH = `${fakeCliDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
  });

  beforeEach(() => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
  });

  after(() => {
    process.env.PATH = originalPath;
    if (fakeCliDir) rmSync(fakeCliDir, { recursive: true, force: true });
  });

  // --- callbackEnv 传递验证 ---

  test('passes callbackEnv to Claude service', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('sess-1', 'hi'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', 'hello'));

    // Callback authority crosses the launch through the original-turn file.
    assert.equal(claudeSpawn._calls.length, 1);
    assertCallbackLaunch(claudeSpawn._calls[0]);
  });

  test('passes callbackEnv to Codex service', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'hi'));
    // F177-H: this wiring test only verifies callbackEnv. Give the real Codex service a legal
    // routing exit so the server-side remedial guard does not intentionally invoke it twice.
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi\n@co-creator'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', '@codex hello'));

    assert.equal(codexSpawn._calls.length, 1);
    assertCallbackLaunch(codexSpawn._calls[0]);
  });

  test('passes callbackEnv to Gemini service', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'hi'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    const events = await collect(router.route('user-1', '@gemini hello'));
    const error = events.find((event) => event.type === 'error');
    assert.equal(error, undefined, error?.error);

    assert.equal(geminiSpawn._calls.length, 1);
    const call = geminiSpawn._calls[0];
    assert.equal(commandName(call.cmd), 'agy');
    assert.ok(call.args.includes('--output-format'));
    assert.ok(call.args.includes('stream-json'));
    assert.ok(call.args.includes('--input-format'));
    const spawnOpts = geminiSpawn._calls[0].options;
    assert.ok(spawnOpts.env.CAT_CAFE_INVOCATION_ID);
    assert.equal(spawnOpts.env.CAT_CAFE_CALLBACK_TOKEN, undefined);
    assert.ok(geminiSpawn._nativeCredential?.callbackToken);
    assert.equal(geminiSpawn._nativeCredential.invocationId, spawnOpts.env.CAT_CAFE_INVOCATION_ID);
    assert.equal(existsSync(geminiSpawn._nativeConfigPath), false, 'terminal cleanup retires the private headers');
  });

  // --- InvocationRegistry 接线验证 ---

  test('creates unique invocation per cat in multi-mention', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'opus reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'codex reply'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', '@opus @codex hello'));

    // Collect invocation IDs from both spawns
    const opusId = claudeSpawn._calls[0].options.env.CAT_CAFE_INVOCATION_ID;
    const codexId = codexSpawn._calls[0].options.env.CAT_CAFE_INVOCATION_ID;

    assert.ok(opusId, 'opus should have invocation ID');
    assert.ok(codexId, 'codex should have invocation ID');
    assert.notEqual(opusId, codexId, 'invocation IDs should be unique per cat');
  });

  test('invocation tokens are verifiable after route()', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'hi'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', 'hello'));

    const credential = assertCallbackLaunch(claudeSpawn._calls[0]);
    // F174 Phase A/B: verify() returns Promise<VerifyResult>
    const result = await registry.verify(credential.invocationId, credential.callbackToken);
    assert.equal(result.ok, true, 'credentials should be verifiable');
    assert.equal(result.record.userId, 'user-1');
    assert.equal(result.record.catId, 'opus');
  });

  // --- MessageStore 接线验证 ---

  test('stores user message in MessageStore', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', 'hello world'));

    const recent = messageStore.getRecent(10);
    const userMsg = recent.find((m) => m.catId === null);
    assert.ok(userMsg, 'should store user message');
    assert.equal(userMsg.content, 'hello world');
    assert.equal(userMsg.userId, 'user-1');
  });

  test('stores cat response in MessageStore', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'opus says hi'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', 'hello'));

    const recent = messageStore.getRecent(10);
    const catMsg = recent.find((m) => m.catId === 'opus');
    assert.ok(catMsg, 'should store cat response');
    assert.equal(catMsg.content, 'opus says hi');
  });

  // --- Session 管理集成 ---

  test('stores and reuses session across calls', async () => {
    let callCount = 0;
    const claudeSpawn = createTrackingSpawnFn(() => {
      callCount++;
      return claudeEvents(`sess-${callCount}`, `reply ${callCount}`);
    });
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    // First call
    await collect(router.route('user-1', 'first'));

    // Second call — should pass sessionId from first call
    await collect(router.route('user-1', 'second'));

    // Verify second spawn received --resume sess-1
    assert.equal(claudeSpawn._calls.length, 2);
    const secondArgs = claudeSpawn._calls[1].args;
    const resumeIndex = secondArgs.indexOf('--resume');
    assert.ok(resumeIndex >= 0, 'second call should use --resume');
    assert.equal(secondArgs[resumeIndex + 1], 'sess-1', 'should resume session from first call');
  });

  // --- Multi-cat chaining ---

  test('passes previous cat response to next cat prompt', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'cat1 reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'codex ack'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const threadStore = new ThreadStore();
    const thread = threadStore.create('user-1', 'serial chain test');
    threadStore.updateThinkingMode(thread.id, 'debug');

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
        threadStore,
      }),
    );

    await collect(router.route('user-1', '#execute @opus @codex hello', thread.id));

    // Codex spawn should receive prompt containing opus's reply (serial chain)
    // Incident 2026-05-29: prompt 走 stdin（不进 argv）。argv 末尾是 '-'，prompt 内容在 stdin。
    const codexArgs = codexSpawn._calls[0].args;
    assert.equal(codexArgs[codexArgs.length - 1], '-', 'codex prompt 走 stdin，argv 末尾是 -');
    const prompt = codexSpawn._calls[0].proc.stdinData;
    assert.ok(prompt.includes('cat1 reply'), `codex stdin prompt should contain opus reply, got: ${prompt}`);
  });

  test('yields isFinal=true only on last cat done (#execute serial)', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'opus reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'codex reply'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    const msgs = await collect(router.route('user-1', '#execute @opus @codex hello'));

    const doneMessages = msgs.filter((m) => m.type === 'done');
    assert.equal(doneMessages.length, 2, 'should have 2 done messages');

    const opusDone = doneMessages.find((m) => m.catId === 'opus');
    const codexDone = doneMessages.find((m) => m.catId === 'codex');
    assert.equal(opusDone.isFinal, false, 'opus done should not be final');
    assert.equal(codexDone.isFinal, true, 'codex done should be final');
  });
});

// ===================================================================
// Test Suite: MCP callback end-to-end flow
// ===================================================================

describe('MCP callback end-to-end flow', () => {
  let registry;
  let messageStore;
  let socketManager;
  let fakeCliDir;
  const originalPath = process.env.PATH ?? '';

  before(() => {
    fakeCliDir = installFakeCliPath();
    process.env.PATH = `${fakeCliDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
  });

  beforeEach(() => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    socketManager = createMockSocketManager();
  });

  after(() => {
    process.env.PATH = originalPath;
    if (fakeCliDir) rmSync(fakeCliDir, { recursive: true, force: true });
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbacksRoutes, { registry, messageStore, socketManager });
    return app;
  }

  test('callback POST succeeds with invocation from route()', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    // 1. route() creates invocation and passes callbackEnv to spawn
    await collect(router.route('user-1', 'hello'));

    // 2. Use the credential observed while the original launch file existed.
    const credential = assertCallbackLaunch(claudeSpawn._calls[0]);

    // 3. POST to callback endpoint with credentials from route()
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': credential.invocationId, 'x-callback-token': credential.callbackToken },
      payload: {
        content: 'Callback message from cat!',
      },
    });

    assert.equal(response.statusCode, 200);

    // 4. Verify message was stored
    const recent = messageStore.getRecent(10);
    const callbackMsg = recent.find((m) => m.content === 'Callback message from cat!');
    assert.ok(callbackMsg, 'callback message should be in store');
    assert.equal(callbackMsg.catId, 'opus');
    assert.equal(callbackMsg.userId, 'user-1');

    // 5. Verify socket broadcast
    const broadcasted = socketManager.getMessages();
    assert.ok(
      broadcasted.some((m) => m.content === 'Callback message from cat!'),
      'should broadcast via socket',
    );
  });

  test('callback GET pending-mentions returns mentions from route()', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn: codexSpawn }),
        geminiService: createNativeFixtureService(geminiSpawn),
        registry,
        messageStore,
      }),
    );

    // 1. route('@opus help') stores user message with opus mention
    await collect(router.route('user-1', '@opus help'));

    // 2. Create a fresh invocation for opus (simulating a new CLI invocation)
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // 3. Query pending mentions
    const app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/pending-mentions',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.mentions.length >= 1, 'should find opus mention');
    assert.ok(
      body.mentions.some((m) => m.message.includes('@opus help')),
      'mention content should match',
    );
  });
});
