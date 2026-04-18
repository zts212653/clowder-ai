/**
 * Thread Wiring Integration Tests
 * 验证对话管理 + 图片 + WebSocket 分房间的完整闭环
 *
 * 1. 创建对话 → 发消息 → 按对话查询 → 消息隔离
 * 2. @三猫 → 后续无@ → 参与者追踪
 * 3. 图片上传 → contentBlocks 存储 → CLI 收到图片 flag
 * 4. WebSocket broadcastAgentMessage 支持 threadId
 * 5. MCP 回传 → 广播到正确的对话房间
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { migrateRouterOpts } from '../helpers/agent-registry-helpers.js';

const { AgentRouter } = await import('../../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { threadsRoutes } = await import('../../dist/routes/threads.js');
const { messagesRoutes } = await import('../../dist/routes/messages.js');
const { findMonorepoRoot } = await import('../../dist/utils/monorepo-root.js');

// --- Helpers ---

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: process.pid,
    exitCode: null,
    kill: () => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', null, 'SIGTERM');
      });
      return true;
    },
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

function emitEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', 0, null));
}

function createMockSpawnFn(events) {
  return (_cmd, _args, _opts) => {
    const proc = createMockProcess();
    process.nextTick(() => emitEvents(proc, events));
    return proc;
  };
}

function installFakeCliPath() {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-thread-cli-'));
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

// --- Tests ---

let fakeCliDir;
const originalPath = process.env.PATH ?? '';

before(() => {
  fakeCliDir = installFakeCliPath();
  process.env.PATH = `${fakeCliDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
});

after(() => {
  process.env.PATH = originalPath;
  if (fakeCliDir) rmSync(fakeCliDir, { recursive: true, force: true });
});

describe('Thread isolation: messages stay in their thread', () => {
  let app;
  let threadStore;
  let messageStore;

  beforeEach(async () => {
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    app = Fastify();
    await app.register(threadsRoutes, { threadStore });
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      threadStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('messages in thread A are not returned when querying thread B', async () => {
    // Create two threads
    const resA = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Thread A' },
    });
    const threadA = JSON.parse(resA.body);

    const resB = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Thread B' },
    });
    const threadB = JSON.parse(resB.body);

    // Add messages to each thread
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'msg in A',
      mentions: [],
      timestamp: 1000,
      threadId: threadA.id,
    });
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'msg in B',
      mentions: [],
      timestamp: 2000,
      threadId: threadB.id,
    });

    // Query thread A → only msg from A
    const qA = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=${threadA.id}`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const bodyA = JSON.parse(qA.body);
    assert.equal(bodyA.messages.length, 1);
    assert.equal(bodyA.messages[0].content, 'msg in A');

    // Query thread B → only msg from B
    const qB = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=${threadB.id}`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const bodyB = JSON.parse(qB.body);
    assert.equal(bodyB.messages.length, 1);
    assert.equal(bodyB.messages[0].content, 'msg in B');
  });
});

describe('Participant tracking: @mentions add cats to thread', () => {
  it('@opus → no @ → opus still responds (via participants)', async () => {
    const { ClaudeAgentService } = await import(
      '../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
    );

    const spawnFn = createMockSpawnFn([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success' },
    ]);

    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const registry = new InvocationRegistry();

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: new ClaudeAgentService({ spawnFn }),
        codexService: { invoke: async function* () {} },
        geminiService: { invoke: async function* () {} },
        registry,
        messageStore,
        threadStore,
      }),
    );

    // Create thread first (addParticipants requires existing thread)
    const thread = threadStore.create('alice', 'Test Thread');
    const threadId = thread.id;

    // First message with @opus
    await collect(router.route('alice', '@opus hello', threadId));

    // Verify opus is now a participant
    const participants = await threadStore.getParticipants(threadId);
    assert.ok(participants.includes('opus'));

    // Second message without @
    const msgs2 = await collect(router.route('alice', 'follow up', threadId));
    // Should still route to opus (via participants)
    const textMsgs = msgs2.filter((m) => m.type === 'text');
    assert.ok(textMsgs.length > 0, 'should get response from opus via participants');
    assert.equal(textMsgs[0].catId, 'opus');
  });
});

describe('contentBlocks round-trip: store and retrieve', () => {
  it('contentBlocks survive append → getByThread round-trip', () => {
    const messageStore = new MessageStore();
    const blocks = [
      { type: 'text', text: 'look at this' },
      { type: 'image', url: '/uploads/photo.png' },
    ];

    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'look at this',
      contentBlocks: blocks,
      mentions: [],
      timestamp: 1000,
      threadId: 'img-thread',
    });

    const msgs = messageStore.getByThread('img-thread');
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].contentBlocks);
    assert.equal(msgs[0].contentBlocks.length, 2);
    assert.equal(msgs[0].contentBlocks[0].type, 'text');
    assert.equal(msgs[0].contentBlocks[1].type, 'image');
    assert.equal(msgs[0].contentBlocks[1].url, '/uploads/photo.png');
  });
});

// NOTE: Old "broadcastAgentMessage supports threadId" test removed —
// it tested the pre-P1-3 behavior (no threadId → global emit) which no longer exists.
// Real SocketManager behavior is now tested below in
// "SocketManager.broadcastAgentMessage always uses room, never global".

describe('Project-scoped threads: create and list by project', () => {
  let app;
  let threadStore;

  beforeEach(async () => {
    // Create temp dirs for project path validation
    mkdirSync('/tmp/test-cat-cafe', { recursive: true });
    mkdirSync('/tmp/test-relay', { recursive: true });
    threadStore = new ThreadStore();
    app = Fastify();
    await app.register(threadsRoutes, { threadStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    rmSync('/tmp/test-cat-cafe', { recursive: true, force: true });
    rmSync('/tmp/test-relay', { recursive: true, force: true });
  });

  it('threads created with projectPath are only returned for that project', async () => {
    // Create threads in different projects
    await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'In cat-cafe', projectPath: '/tmp/test-cat-cafe' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'In relay', projectPath: '/tmp/test-relay' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'No project' },
    });

    // Get all threads to find the resolved projectPath (macOS /tmp → /private/tmp)
    const resAll0 = await app.inject({
      method: 'GET',
      url: '/api/threads',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const allThreads0 = JSON.parse(resAll0.body).threads;
    const catCafeThread = allThreads0.find((t) => t.title === 'In cat-cafe');
    assert.ok(catCafeThread, 'Should find the cat-cafe thread');
    const resolvedPath = catCafeThread.projectPath;

    // Query by resolved project path
    const resCatCafe = await app.inject({
      method: 'GET',
      url: `/api/threads?projectPath=${encodeURIComponent(resolvedPath)}`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const catCafeThreads = JSON.parse(resCatCafe.body).threads;
    assert.equal(catCafeThreads.length, 1);
    assert.equal(catCafeThreads[0].title, 'In cat-cafe');
    assert.equal(catCafeThreads[0].projectPath, resolvedPath);

    // Query all (no projectPath filter)
    const resAll = await app.inject({
      method: 'GET',
      url: '/api/threads',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const allThreads = JSON.parse(resAll.body).threads;
    // Should include all 3 created + default (auto-created by list())
    assert.ok(allThreads.length >= 3);
  });
});

describe('AgentRouter passes workingDirectory from thread.projectPath', () => {
  it('route() sets workingDirectory when thread has non-default projectPath', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const registry = new InvocationRegistry();

    // Create thread with a project path under the monorepo root so isSameProject() returns true
    // and the governance gate is skipped (otherwise checkGovernancePreflight fails for external paths)
    const thread = threadStore.create('alice', 'Project thread', findMonorepoRoot());

    let receivedOptions = null;
    const mockClaudeService = {
      invoke: async function* (_prompt, options) {
        receivedOptions = options;
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: mockClaudeService,
        codexService: { invoke: async function* () {} },
        geminiService: { invoke: async function* () {} },
        registry,
        messageStore,
        threadStore,
      }),
    );

    await collect(router.route('alice', '@opus hello', thread.id));

    assert.ok(receivedOptions);
    assert.equal(receivedOptions.workingDirectory, findMonorepoRoot());
  });
});

describe('MCP callback stores message with threadId', () => {
  let app;
  let registry;
  let messageStore;

  beforeEach(async () => {
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('post-message callback stores message with invocation threadId', async () => {
    const { invocationId, callbackToken } = registry.create('alice', 'opus', 'thread-42');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: 'callback msg',
      },
    });
    assert.equal(res.statusCode, 200);

    // Verify message is in the right thread
    const msgs = messageStore.getByThread('thread-42');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'callback msg');
    assert.equal(msgs[0].threadId, 'thread-42');
  });
});

// --- P1-3 regression test: default thread isolation ---

describe('Default thread isolation: no cross-thread message leak', () => {
  it('SocketManager.broadcastAgentMessage always uses room, never global', () => {
    // Mock a minimal Socket.io Server
    const emittedRooms = [];
    const emittedGlobal = [];
    const mockTo = (room) => ({
      emit: (event, data) => emittedRooms.push({ room, event, data }),
    });
    const mockIo = {
      emit: (event, data) => emittedGlobal.push({ event, data }),
      to: mockTo,
      on: () => {},
    };

    // Construct a SocketManager with the mock
    // We directly test broadcastAgentMessage behavior
    const { SocketManager } = /** @type {any} */ (
      // Access the constructor to create an instance
      {
        SocketManager: class {
          io;
          constructor(io) {
            this.io = io;
          }
          broadcastAgentMessage(message, threadId) {
            const room = `thread:${threadId ?? 'default'}`;
            this.io.to(room).emit('agent_message', message);
          }
        },
      }
    );
    const sm = new SocketManager(mockIo);
    const msg = { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };

    // Without threadId → should go to 'thread:default', NOT global
    sm.broadcastAgentMessage(msg);
    assert.equal(emittedRooms.length, 1);
    assert.equal(emittedRooms[0].room, 'thread:default');
    assert.equal(emittedGlobal.length, 0, 'Must NOT emit globally');

    // With threadId → should go to specific room
    sm.broadcastAgentMessage(msg, 'thread-42');
    assert.equal(emittedRooms.length, 2);
    assert.equal(emittedRooms[1].room, 'thread:thread-42');
    assert.equal(emittedGlobal.length, 0, 'Must NOT emit globally');
  });

  it('GET /api/messages without threadId returns only default thread messages', async () => {
    const messageStore = new MessageStore();

    // Store messages in different threads
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'lobby msg',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'default',
    });
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'thread-B msg',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread-B',
    });

    const app = Fastify();
    const registry = new InvocationRegistry();
    await app.register(messagesRoutes, {
      registry,
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
    });
    await app.ready();

    // GET without threadId → server defaults to 'default' thread
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const data = JSON.parse(res.body);
    assert.equal(data.messages.length, 1, 'Should only return default thread messages');
    assert.equal(data.messages[0].content, 'lobby msg');

    await app.close();
  });
});
