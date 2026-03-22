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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import Fastify from 'fastify';
import { migrateRouterOpts } from '../helpers/agent-registry-helpers.js';

// --- Imports (from dist) ---

const { ClaudeAgentService } = await import('../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
const { CodexAgentService } = await import('../../dist/domains/cats/services/agents/providers/CodexAgentService.js');
const { GeminiAgentService } = await import('../../dist/domains/cats/services/agents/providers/GeminiAgentService.js');
const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

// --- Helpers ---

/** Collect all items from async iterable */
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
  const proc = {
    stdout,
    stderr,
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

/** Standard Gemini NDJSON: session_init + text */
function geminiEvents(sessionId, text) {
  return [
    { type: 'init', session_id: sessionId },
    { type: 'message', role: 'assistant', content: text },
    { type: 'result', status: 'success' },
  ];
}

/**
 * Create a SpawnFn that creates a fresh mock process per call,
 * emits pre-configured events, and records every call for assertions.
 */
function createTrackingSpawnFn(eventsFn) {
  const calls = [];
  const spawnFn = mock.fn((_cmd, _args, options) => {
    const proc = createMockProcess();
    calls.push({ args: _args, options, proc });
    // Schedule events on next tick so caller can start reading
    process.nextTick(() => emitEvents(proc, eventsFn(calls.length)));
    return proc;
  });
  spawnFn._calls = calls;
  return spawnFn;
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
  } else {
    const content = '#!/bin/sh\nexit 0\n';
    writeExecutable('claude', content);
    writeExecutable('codex', content);
    writeExecutable('gemini', content);
  }

  return dir;
}

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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', 'hello'));

    // Claude spawn should have been called with env containing callback vars
    assert.equal(claudeSpawn._calls.length, 1);
    const spawnOpts = claudeSpawn._calls[0].options;
    assert.ok(spawnOpts.env.CAT_CAFE_INVOCATION_ID, 'should have invocation ID');
    assert.ok(spawnOpts.env.CAT_CAFE_CALLBACK_TOKEN, 'should have callback token');
    assert.ok(spawnOpts.env.CAT_CAFE_API_URL, 'should have API URL');
  });

  test('passes callbackEnv to Codex service', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'hi'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', '@codex hello'));

    assert.equal(codexSpawn._calls.length, 1);
    const spawnOpts = codexSpawn._calls[0].options;
    assert.ok(spawnOpts.env.CAT_CAFE_INVOCATION_ID);
    assert.ok(spawnOpts.env.CAT_CAFE_CALLBACK_TOKEN);
  });

  test('passes callbackEnv to Gemini service', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'hi'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', '@gemini hello'));

    assert.equal(geminiSpawn._calls.length, 1);
    const spawnOpts = geminiSpawn._calls[0].options;
    assert.ok(spawnOpts.env.CAT_CAFE_INVOCATION_ID);
    assert.ok(spawnOpts.env.CAT_CAFE_CALLBACK_TOKEN);
  });

  // --- InvocationRegistry 接线验证 ---

  test('creates unique invocation per cat in multi-mention', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'opus reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'codex reply'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
      }),
    );

    await collect(router.route('user-1', 'hello'));

    const env = claudeSpawn._calls[0].options.env;
    const record = registry.verify(env.CAT_CAFE_INVOCATION_ID, env.CAT_CAFE_CALLBACK_TOKEN);
    assert.ok(record, 'credentials should be verifiable');
    assert.equal(record.userId, 'user-1');
    assert.equal(record.catId, 'opus');
  });

  // --- MessageStore 接线验证 ---

  test('stores user message in MessageStore', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'hi'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
        threadStore,
      }),
    );

    await collect(router.route('user-1', '#execute @opus @codex hello', thread.id));

    // Codex spawn should receive prompt containing opus's reply (serial chain)
    const codexArgs = codexSpawn._calls[0].args;
    // The prompt is the last positional arg for fresh codex calls
    const prompt = codexArgs[codexArgs.length - 1];
    assert.ok(prompt.includes('cat1 reply'), `codex prompt should contain opus reply, got: ${prompt}`);
  });

  test('yields isFinal=true only on last cat done (#execute serial)', async () => {
    const claudeSpawn = createTrackingSpawnFn(() => claudeEvents('s-1', 'opus reply'));
    const codexSpawn = createTrackingSpawnFn(() => codexEvents('t-1', 'codex reply'));
    const geminiSpawn = createTrackingSpawnFn(() => geminiEvents('g-1', 'hi'));

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn: claudeSpawn }),
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
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

  beforeEach(() => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    socketManager = createMockSocketManager();
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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
      }),
    );

    // 1. route() creates invocation and passes callbackEnv to spawn
    await collect(router.route('user-1', 'hello'));

    // 2. Extract callbackEnv from the spawn call
    const env = claudeSpawn._calls[0].options.env;

    // 3. POST to callback endpoint with credentials from route()
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId: env.CAT_CAFE_INVOCATION_ID,
        callbackToken: env.CAT_CAFE_CALLBACK_TOKEN,
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
        codexService: new CodexAgentService({ spawnFn: codexSpawn }),
        geminiService: new GeminiAgentService({ spawnFn: geminiSpawn, adapter: 'gemini-cli' }),
        registry,
        messageStore,
      }),
    );

    // 1. route('@opus help') stores user message with opus mention
    await collect(router.route('user-1', '@opus help'));

    // 2. Create a fresh invocation for opus (simulating a new CLI invocation)
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // 3. Query pending mentions
    const app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/pending-mentions?invocationId=${invocationId}&callbackToken=${callbackToken}`,
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
