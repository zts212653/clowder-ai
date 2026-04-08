/**
 * GeminiAgentService Tests (CLI dual adapter mode)
 * 测试暹罗猫 CLI 子进程调用 (gemini-cli + antigravity-desktop)
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

const { GeminiAgentService } = await import('../dist/domains/cats/services/agents/providers/GeminiAgentService.js');

ensureFakeCliOnPath('gemini');

/** Helper: collect all items from async iterable */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Create a mock child process for testing spawnCli path.
 */
function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 12345,
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

/** Create a mock SpawnFn for gemini-cli adapter */
function createMockSpawnFn(proc) {
  return mock.fn(() => proc);
}

function emitProcessExit(proc, code, signal = null) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, signal);
  });
}

/** Write NDJSON events to mock process stdout, then end with exit 0 */
function emitGeminiEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, 0, null);
  });
  proc.stdout.end();
}

// ===== gemini-cli adapter tests =====

describe('GeminiAgentService (gemini-cli adapter)', () => {
  test('yields session_init, text, and done on basic success', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('Hello'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 'sess-abc', model: 'gemini-3-pro' },
      { type: 'message', role: 'user', content: 'Hello' },
      { type: 'message', role: 'assistant', content: 'Hello from Gemini!', delta: true },
      { type: 'result', status: 'success', stats: { total_tokens: 100 } },
    ]);

    const msgs = await promise;

    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].type, 'session_init');
    assert.equal(msgs[0].sessionId, 'sess-abc');
    assert.equal(msgs[0].catId, 'gemini');
    assert.equal(msgs[1].type, 'text');
    assert.equal(msgs[1].content, 'Hello from Gemini!');
    assert.equal(msgs[2].type, 'done');
  });

  test('passes correct CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'gemini-cli',
      model: 'gemini-test-model',
    });

    const promise = collect(service.invoke('test prompt'));
    emitGeminiEvents(proc, [{ type: 'init', session_id: 's1', model: 'auto' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0, 'fresh invoke should include --model');
    assert.equal(args[modelIdx + 1], 'gemini-test-model');
    const promptIdx = args.indexOf('-p');
    assert.ok(promptIdx >= 0, 'fresh invoke should include -p');
    assert.equal(args[promptIdx + 1], 'test prompt');
    const outputIdx = args.indexOf('-o');
    assert.ok(outputIdx >= 0, 'fresh invoke should include -o');
    assert.equal(args[outputIdx + 1], 'stream-json');
    assert.ok(args.includes('-y'));
  });

  test('passes --resume when sessionId is provided', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'gemini-cli',
      model: 'gemini-test-model',
    });

    const promise = collect(service.invoke('resume prompt', { sessionId: 'sid-uuid-1234' }));
    emitGeminiEvents(proc, [{ type: 'init', session_id: 'sid-uuid-1234', model: 'auto' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args[0], '--resume');
    assert.equal(args[1], 'sid-uuid-1234');
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0, 'resume invoke should include --model');
    assert.equal(args[modelIdx + 1], 'gemini-test-model');
    const promptIdx = args.indexOf('-p');
    assert.ok(promptIdx >= 0, 'resume invoke should include -p');
    assert.equal(args[promptIdx + 1], 'resume prompt');
  });

  test('keeps --resume when callback env is present', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-789',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-789',
    };

    const promise = collect(
      service.invoke('resume prompt', {
        sessionId: 'sid-uuid-5678',
        callbackEnv,
      }),
    );
    emitGeminiEvents(proc, [{ type: 'init', session_id: 'sid-uuid-5678', model: 'auto' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args[0], '--resume');
    assert.equal(args[1], 'sid-uuid-5678');
  });

  test('passes callbackEnv as env', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-123',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-456',
    };

    const promise = collect(service.invoke('test', { callbackEnv }));
    emitGeminiEvents(proc, [{ type: 'init', session_id: 's1', model: 'auto' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.CAT_CAFE_INVOCATION_ID, 'inv-123');
    assert.equal(spawnOpts.env.CAT_CAFE_CALLBACK_TOKEN, 'tok-456');
  });

  test('maps tool_use events', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('read a file'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's1', model: 'auto' },
      { type: 'message', role: 'user', content: 'read a file' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 'r1', parameters: { path: '/tmp/test' } },
      { type: 'tool_result', tool_id: 'r1', status: 'success', output: 'content' },
      { type: 'message', role: 'assistant', content: 'Done', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const toolMsg = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolMsg);
    assert.equal(toolMsg.toolName, 'read_file');
    assert.deepEqual(toolMsg.toolInput, { path: '/tmp/test' });

    // tool_result should be skipped
    const toolResults = msgs.filter((m) => m.toolName === undefined && m.type === 'tool_use');
    assert.equal(toolResults.length, 0);
  });

  test('yields error on CLI non-zero exit', async () => {
    const proc = createMockProcess();
    proc.kill = mock.fn(() => true);
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('crash'));

    proc.stderr.write('Error: authentication failed\n');
    proc.stdout.end();
    emitProcessExit(proc, 1, null);

    const msgs = await promise;
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    // Error message is sanitized — contains exit code but not raw stderr
    assert.ok(errMsg.error.includes('code: 1'));
    // Raw stderr should NOT be exposed to users
    assert.ok(!errMsg.error.includes('authentication failed'), 'stderr should be sanitized');
  });

  test('does not emit duplicate errors when result/error is followed by non-zero exit', async () => {
    const proc = createMockProcess();
    proc.kill = mock.fn(() => true);
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('fail'));

    // result/error without detailed error text, then process exits non-zero
    // Any non-zero exit code from spawnCli yields __cliError
    proc.stdout.write(`${JSON.stringify({ type: 'init', session_id: 's1', model: 'auto' })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: 'result', status: 'error' })}\n`);
    proc.stdout.end();
    emitProcessExit(proc, 2, null);

    const msgs = await promise;
    const errMsgs = msgs.filter((m) => m.type === 'error');
    assert.equal(errMsgs.length, 1, 'should emit only one error for one failed invocation');
    assert.match(errMsgs[0].error, /code:\s*2/);
  });

  test('yields error on spawn ENOENT', async () => {
    const proc = createMockProcess();
    proc.kill = mock.fn(() => true);
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('hi'));

    process.nextTick(() => {
      const err = new Error('spawn gemini ENOENT');
      err.code = 'ENOENT';
      proc._emitter.emit('error', err);
      proc.stdout.end();
      emitProcessExit(proc, null, null);
    });

    const msgs = await promise;
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.ok(errMsg.error.includes('ENOENT'));
  });

  test('skips user echo and result/success events', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's1', model: 'auto' },
      { type: 'message', role: 'user', content: 'test' },
      { type: 'message', role: 'assistant', content: 'Response', delta: true },
      { type: 'result', status: 'success', stats: { total_tokens: 50 } },
      { type: 'unknown_event', data: 'something' },
    ]);

    const msgs = await promise;
    // Only session_init, text, done — everything else skipped
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].type, 'session_init');
    assert.equal(msgs[1].type, 'text');
    assert.equal(msgs[1].content, 'Response');
    assert.equal(msgs[2].type, 'done');
  });

  test('all messages have catId gemini', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('check'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's-catid', model: 'auto' },
      { type: 'message', role: 'assistant', content: 'Test', delta: true },
    ]);

    const msgs = await promise;
    for (const msg of msgs) {
      assert.equal(msg.catId, 'gemini', `expected catId gemini for ${msg.type} message`);
    }
  });

  test('maps result with non-success status to error', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('fail'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's1', model: 'auto' },
      { type: 'result', status: 'error', error: 'Model overloaded' },
    ]);

    const msgs = await promise;
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.equal(errMsg.error, 'Model overloaded');
  });

  test('suppresses known post-response candidates crash after assistant text', async () => {
    const proc = createMockProcess();
    proc.kill = mock.fn(() => true);
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('Reply with exactly hi'));

    proc.stdout.write(`${JSON.stringify({ type: 'init', session_id: 's1', model: 'auto' })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' })}\n`);
    proc.stdout.write(
      `${JSON.stringify({
        type: 'result',
        status: 'error',
        error: {
          type: 'Error',
          message: "[API Error: Cannot read properties of undefined (reading 'candidates')]",
        },
      })}\n`,
    );
    proc.stdout.end();
    emitProcessExit(proc, 1, null);

    const msgs = await promise;
    const errMsgs = msgs.filter((m) => m.type === 'error');
    const textMsgs = msgs.filter((m) => m.type === 'text');

    assert.equal(textMsgs.length, 1);
    assert.equal(textMsgs[0].content, 'hi');
    assert.equal(errMsgs.length, 0, 'known post-response crash should be suppressed');
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('separates multi-turn assistant text with paragraph breaks (turn newline fix)', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

    const promise = collect(service.invoke('multi-turn'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's-mt', model: 'auto' },
      { type: 'message', role: 'assistant', content: 'First turn' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: '/tmp/a' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'data' },
      { type: 'message', role: 'assistant', content: 'Second turn' },
      { type: 'message', role: 'assistant', content: 'Third turn' },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const textMsgs = msgs.filter((m) => m.type === 'text');

    assert.equal(textMsgs.length, 3);
    assert.equal(textMsgs[0].content, 'First turn', 'first turn has no prefix');
    assert.equal(textMsgs[1].content, '\n\nSecond turn', 'second turn gets paragraph break');
    assert.equal(textMsgs[2].content, '\n\nThird turn', 'third turn gets paragraph break');

    // Verify concatenation produces proper markdown
    const combined = textMsgs.map((m) => m.content).join('');
    assert.equal(combined, 'First turn\n\nSecond turn\n\nThird turn');
  });
});

// ===== antigravity adapter tests =====

describe('GeminiAgentService (antigravity adapter)', () => {
  test('yields session_init, notification text, and done', async () => {
    const antigravitySpawnFn = mock.fn(() => ({
      on: mock.fn(),
      unref: mock.fn(),
      pid: 99999,
    }));

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-1',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-1',
    };

    const msgs = await collect(service.invoke('Design a logo', { callbackEnv }));

    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].type, 'session_init');
    assert.ok(msgs[0].sessionId.startsWith('antigravity-'));
    assert.equal(msgs[1].type, 'text');
    assert.ok(msgs[1].content.includes('Antigravity'));
    assert.equal(msgs[2].type, 'done');
  });

  test('spawns antigravity with correct args and env', async () => {
    const antigravitySpawnFn = mock.fn(() => ({
      on: mock.fn(),
      unref: mock.fn(),
      pid: 99999,
    }));

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-2',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-2',
    };

    await collect(service.invoke('Design a logo', { callbackEnv }));

    assert.equal(antigravitySpawnFn.mock.callCount(), 1);
    const call = antigravitySpawnFn.mock.calls[0];
    assert.equal(call.arguments[0], 'antigravity');
    assert.deepEqual(call.arguments[1], ['chat', '--mode', 'agent', 'Design a logo']);

    const spawnOpts = call.arguments[2];
    assert.equal(spawnOpts.detached, true);
    assert.equal(spawnOpts.stdio, 'ignore');
    assert.equal(spawnOpts.env.CAT_CAFE_INVOCATION_ID, 'inv-2');
    assert.equal(spawnOpts.env.CAT_CAFE_CALLBACK_TOKEN, 'tok-2');
  });

  test('preserves inherited env vars (not whitelist) — regression for v2 strip approach', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    const prevCustom = process.env.MY_CUSTOM_VAR;
    process.env.GEMINI_API_KEY = 'aiza-inherited-key';
    process.env.MY_CUSTOM_VAR = 'custom-value';

    const antigravitySpawnFn = mock.fn(() => ({
      on: mock.fn(),
      unref: mock.fn(),
      pid: 99999,
    }));

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-inherit',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-inherit',
    };

    try {
      await collect(service.invoke('test', { callbackEnv }));

      const spawnOpts = antigravitySpawnFn.mock.calls[0].arguments[2];
      // Inherited API key must be present (v1 whitelist dropped these)
      assert.equal(spawnOpts.env.GEMINI_API_KEY, 'aiza-inherited-key');
      assert.equal(spawnOpts.env.MY_CUSTOM_VAR, 'custom-value');
      // callbackEnv still merged
      assert.equal(spawnOpts.env.CAT_CAFE_INVOCATION_ID, 'inv-inherit');
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
      else delete process.env.GEMINI_API_KEY;
      if (prevCustom !== undefined) process.env.MY_CUSTOM_VAR = prevCustom;
      else delete process.env.MY_CUSTOM_VAR;
    }
  });

  test('errors when callbackEnv is missing', async () => {
    const antigravitySpawnFn = mock.fn();

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const msgs = await collect(service.invoke('test'));

    // error + done (done ensures frontend clears loading state)
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].type, 'error');
    assert.ok(msgs[0].error.includes('callbackEnv'));
    assert.equal(msgs[1].type, 'done');
    // Should not have spawned anything
    assert.equal(antigravitySpawnFn.mock.callCount(), 0);
  });

  test('yields error on async spawn failure (ENOENT on next tick)', async () => {
    const antigravitySpawnFn = mock.fn(() => ({
      on: mock.fn((event, handler) => {
        if (event === 'error') {
          // Fire ENOENT on next tick (simulates real spawn behavior)
          process.nextTick(() => handler(new Error('spawn antigravity ENOENT')));
        }
      }),
      unref: mock.fn(),
      pid: 99999,
    }));

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-async',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-async',
    };

    const msgs = await collect(service.invoke('test', { callbackEnv }));

    // Should yield session_init, then error, then done (done guarantees frontend clears loading)
    assert.equal(msgs[0].type, 'session_init');
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg, 'should yield error for async ENOENT');
    assert.ok(errMsg.error.includes('ENOENT'));
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done after error so frontend stops loading',
    );
  });

  test('handles synchronous spawn failure gracefully', async () => {
    const antigravitySpawnFn = mock.fn(() => {
      throw new Error('spawn antigravity ENOENT');
    });

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-3',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-3',
    };

    const msgs = await collect(service.invoke('test', { callbackEnv }));

    // Should have session_init, then error, then done (done guarantees frontend clears loading)
    assert.equal(msgs[0].type, 'session_init');
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.ok(errMsg.error.includes('ENOENT'));
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done after error so frontend stops loading',
    );
  });

  test('all messages have catId gemini', async () => {
    const antigravitySpawnFn = mock.fn(() => ({
      on: mock.fn(),
      unref: mock.fn(),
      pid: 99999,
    }));

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-4',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-4',
    };

    const msgs = await collect(service.invoke('test', { callbackEnv }));

    for (const msg of msgs) {
      assert.equal(msg.catId, 'gemini', `expected catId gemini for ${msg.type} message`);
    }
  });
});

// ===== facade / adapter selection tests =====

describe('GeminiAgentService (adapter selection)', () => {
  test('defaults to gemini-cli adapter', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    // No adapter option → should default to gemini-cli
    const service = new GeminiAgentService({ spawnFn });

    const promise = collect(service.invoke('test'));
    emitGeminiEvents(proc, [{ type: 'init', session_id: 's1', model: 'auto' }]);
    await promise;

    // Verify gemini CLI was spawned (not antigravity)
    assert.equal(spawnFn.mock.callCount(), 1);
    const spawnedCommand = spawnFn.mock.calls[0].arguments[0];
    assert.ok(
      spawnedCommand === 'gemini' || spawnedCommand.endsWith('/gemini'),
      `Expected gemini command, got: ${spawnedCommand}`,
    );
  });

  test('selects antigravity via constructor option', async () => {
    const antigravitySpawnFn = mock.fn(() => ({
      on: mock.fn(),
      unref: mock.fn(),
      pid: 99999,
    }));

    const service = new GeminiAgentService({
      adapter: 'antigravity',
      antigravitySpawnFn,
    });

    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-5',
      CAT_CAFE_CALLBACK_TOKEN: 'tok-5',
    };

    await collect(service.invoke('test', { callbackEnv }));

    assert.equal(antigravitySpawnFn.mock.callCount(), 1);
    assert.equal(antigravitySpawnFn.mock.calls[0].arguments[0], 'antigravity');
  });
});

test('F8: result/success stats captured into done metadata', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

  const promise = collect(service.invoke('test'));

  emitGeminiEvents(proc, [
    { type: 'init', session_id: 's1', model: 'gemini-pro' },
    { type: 'message', role: 'assistant', content: 'Hello', delta: true },
    { type: 'result', status: 'success', stats: { total_tokens: 150 } },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'should have done message');
  assert.ok(done.metadata?.usage, 'done should have usage in metadata');
  assert.equal(done.metadata.usage.totalTokens, 150);
});

test('F24: captures richer Gemini stats fields when provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

  const promise = collect(service.invoke('stats test'));

  emitGeminiEvents(proc, [
    { type: 'init', session_id: 's2', model: 'gemini-2.5-pro' },
    { type: 'message', role: 'assistant', content: 'ok', delta: true },
    {
      type: 'result',
      status: 'success',
      stats: {
        total_tokens: 4500,
        input_tokens: 3000,
        output_tokens: 700,
        cached_input_tokens: 1200,
        context_window: 1000000,
      },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage, 'done should have usage metadata');
  assert.equal(done.metadata.usage.totalTokens, 4500);
  assert.equal(done.metadata.usage.inputTokens, 3000);
  assert.equal(done.metadata.usage.outputTokens, 700);
  assert.equal(done.metadata.usage.cacheReadTokens, 1200);
  assert.equal(done.metadata.usage.contextWindowSize, 1000000);
});

test('F24: prefers stats.context_window over stats.contextWindow when both exist', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

  const promise = collect(service.invoke('stats precedence test'));

  emitGeminiEvents(proc, [
    { type: 'init', session_id: 's3', model: 'gemini-2.5-pro' },
    { type: 'message', role: 'assistant', content: 'ok', delta: true },
    {
      type: 'result',
      status: 'success',
      stats: {
        total_tokens: 1800,
        context_window: 900000,
        contextWindow: 1000000,
      },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage, 'done should have usage metadata');
  assert.equal(done.metadata.usage.contextWindowSize, 900000);
});

test('emits wrapped thinking from local Gemini session snapshots when available', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

  const fakeHome = mkdtempSync(join(tmpdir(), 'gemini-home-'));
  const sessionDir = join(fakeHome, '.gemini', 'tmp', 'clowder-ai', 'chats');
  mkdirSync(sessionDir, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const promise = collect(
      service.invoke('test thinking', { workingDirectory: '/Users/liuzifan/Projects/clowder-ai' }),
    );

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 'gem-s1', model: 'gemini-3.1-pro-preview' },
      { type: 'message', role: 'assistant', content: 'Final answer', delta: true },
      { type: 'result', status: 'success', stats: { total_tokens: 123 } },
    ]);

    writeFileSync(
      join(sessionDir, 'session-2026-04-06T12-00-test.json'),
      JSON.stringify(
        {
          sessionId: 'gem-s1',
          messages: [
            {
              id: 'm1',
              type: 'gemini',
              content: 'Final answer',
              thoughts: [
                { subject: 'Planning', description: 'First think.' },
                { subject: 'Checking', description: 'Second think.' },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    const msgs = await promise;
    const thinkingMsg = msgs.find((m) => m.type === 'system_info' && m.content.includes('"type":"thinking"'));
    assert.ok(thinkingMsg, 'should emit thinking system_info');
    const parsed = JSON.parse(thinkingMsg.content);
    assert.equal(parsed.type, 'thinking');
    assert.match(parsed.text, /\*\*Planning\*\*/);
    assert.match(parsed.text, /Second think\./);
  } finally {
    process.env.HOME = previousHome;
  }
});

test('skips Gemini local thinking hydration when the latest session content does not match this reply', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });

  const fakeHome = mkdtempSync(join(tmpdir(), 'gemini-home-'));
  const sessionDir = join(fakeHome, '.gemini', 'tmp', 'clowder-ai', 'chats');
  mkdirSync(sessionDir, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const promise = collect(
      service.invoke('test mismatch', { workingDirectory: '/Users/liuzifan/Projects/clowder-ai' }),
    );

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 'gem-s2', model: 'gemini-3.1-pro-preview' },
      { type: 'message', role: 'assistant', content: 'Actual reply', delta: true },
      { type: 'result', status: 'success', stats: { total_tokens: 123 } },
    ]);

    writeFileSync(
      join(sessionDir, 'session-2026-04-06T12-01-test.json'),
      JSON.stringify(
        {
          sessionId: 'gem-s2',
          messages: [
            {
              id: 'm1',
              type: 'gemini',
              content: 'Some older unrelated reply',
              thoughts: [{ subject: 'Old', description: 'Should not attach.' }],
            },
          ],
        },
        null,
        2,
      ),
    );

    const msgs = await promise;
    const thinkingMsg = msgs.find((m) => m.type === 'system_info' && m.content.includes('"type":"thinking"'));
    assert.equal(thinkingMsg, undefined);
  } finally {
    process.env.HOME = previousHome;
  }
});
