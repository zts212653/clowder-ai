/**
 * GeminiAgentService Tests (CLI dual adapter mode)
 * 测试暹罗猫 CLI 子进程调用 (gemini-cli + antigravity-desktop)
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

const { GeminiAgentService } = await import('../dist/domains/cats/services/agents/providers/GeminiAgentService.js');

ensureFakeCliOnPath('gemini');
ensureFakeCliOnPath('agy');

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
        emitter.emit('close', null, 'SIGTERM');
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
    proc._emitter.emit('close', code, signal);
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

function emitPlainText(proc, text, code = 0, stderr = '') {
  if (stderr) proc.stderr.write(stderr);
  proc.stdout.write(text);
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, code, null);
  });
  proc.stdout.end();
}

function emitExitThenLatePlainTextBeforeClose(proc, text, code = 0) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, null);
  });
  setImmediate(() => {
    proc.stdout.write(text);
    proc.stdout.once('finish', () => {
      proc._emitter.emit('close', code, null);
    });
    proc.stdout.end();
  });
}

function assertFileRemoved(path, message) {
  try {
    assert.equal(existsSync(path), false, message);
  } finally {
    rmSync(path, { force: true });
  }
}

function writeGeminiJsonlSession(home, projectDir, sessionId, messages) {
  const sessionDir = join(home, '.gemini', 'tmp', projectDir, 'chats');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, `session-${sessionId.slice(0, 8)}.jsonl`);
  const lines = [{ sessionId }, ...messages].map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
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

  test('raw-concats consecutive assistant streaming deltas without synthetic separators', async () => {
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
    assert.equal(textMsgs[0].content, 'First turn');
    assert.equal(textMsgs[1].content, 'Second turn', 'no synthetic \\n\\n prefix');
    assert.equal(textMsgs[2].content, 'Third turn', 'no synthetic \\n\\n prefix');

    const combined = textMsgs.map((m) => m.content).join('');
    assert.equal(combined, 'First turnSecond turnThird turn');
  });
});

// ===== antigravity-cli adapter tests =====

describe('GeminiAgentService (antigravity-cli adapter)', () => {
  test('spawns agy print mode with repo access and maps plain stdout to text', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));

    const promise = collect(
      service.invoke('Say hi', {
        workingDirectory: workDir,
        systemPrompt: 'System identity',
      }),
    );
    emitPlainText(proc, 'AGY_OK\n');

    const msgs = await promise;
    const text = msgs.find((m) => m.type === 'text');
    const done = msgs.find((m) => m.type === 'done');
    assert.equal(text?.content, 'AGY_OK');
    assert.equal(done?.metadata?.provider, 'google');
    assert.match(done?.metadata?.model ?? '', /antigravity-cli/);

    const call = spawnFn.mock.calls[0];
    assert.ok(call.arguments[0] === 'agy' || call.arguments[0].endsWith('/agy'));
    const args = call.arguments[1];
    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--print-timeout'));
    assert.equal(
      args.includes('--dangerously-skip-permissions'),
      false,
      'unprofiled global-HOME AGY path must not use unattended yolo',
    );
    assert.ok(args.includes('--add-dir'));
    assert.equal(args[args.indexOf('--add-dir') + 1], workDir);
    assert.equal(args[args.indexOf('--print') + 1], 'System identity\n\nSay hi');
    assert.equal(args.includes('--model'), false, 'agy 1.0.1 has no verified --model flag');
  });

  test('F212: AGY empty plain-text completion yields user-visible silent_completion diagnostics', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-empty-diagnostics-'));

    try {
      const promise = collect(
        service.invoke('Say hi', {
          workingDirectory: workDir,
          agyLogPathOverride: join(workDir, 'missing-agy.log'),
          auditContext: { invocationId: 'inv-agy-empty' },
        }),
      );
      emitPlainText(proc, '', 0);

      const msgs = await promise;
      assert.equal(
        msgs.some((m) => m.type === 'text'),
        false,
        'empty AGY output must not create text',
      );
      assert.equal(
        msgs.some((m) => m.type === 'error'),
        false,
        'empty AGY output is diagnostic, not provider error',
      );
      const diagnostic = msgs.find(
        (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
      );
      assert.ok(diagnostic, 'empty AGY output must surface a user-visible cliDiagnostics panel');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-empty');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.homeMode, 'process_home');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.spawnCwdMode, 'cat_cafe_agy_cwd');
      assert.match(String(diagnostic.metadata?.cliDiagnostics?.debugRef.spawnCwdKey), /^[a-f0-9]{16}$/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F212: AGY empty stdout classifies actionable stderr before silent_completion', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-empty-stderr-diagnostics-'));
    const childHomePath = '/srv/agy/home';

    try {
      const promise = collect(
        service.invoke('Say hi', {
          workingDirectory: workDir,
          agyLogPathOverride: join(workDir, 'missing-agy.log'),
          auditContext: { invocationId: 'inv-agy-empty-stderr' },
          accountEnv: { HOME: childHomePath },
        }),
      );
      emitPlainText(
        proc,
        '',
        0,
        [
          `401 Unauthorized while reading ${childHomePath}: permission denied`,
          'Open https://accounts.google.com/o/oauth2/auth#state=very-secret-state&access_token=ya29.AGYAccessToken',
        ].join('\n'),
      );

      const msgs = await promise;
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err, 'empty stdout with actionable AGY stderr must surface as an error');
      assert.equal(err.metadata?.cliDiagnostics?.reasonCode, 'auth_failed');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-empty-stderr');
      assert.equal(
        msgs.some((m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
        false,
        'classified stderr must not be downgraded to silent_completion',
      );
      assert.ok(!JSON.stringify(err.metadata?.cliDiagnostics).includes(childHomePath), 'child HOME path must not leak');
      assert.match(
        JSON.stringify(err.metadata?.cliDiagnostics),
        /FRAGMENT_REDACTED/,
        'OAuth fragment must be explicitly redacted in the public diagnostics payload',
      );
      assert.ok(
        !JSON.stringify(err.metadata?.cliDiagnostics).includes('very-secret-state'),
        'OAuth fragment state must not leak',
      );
      assert.ok(
        !JSON.stringify(err.metadata?.cliDiagnostics).includes('ya29.AGYAccessToken'),
        'OAuth fragment access token must not leak',
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F212: AGY empty stdout with unclassified stderr stays silent_completion', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-empty-unclassified-stderr-'));
    const childHomePath = '/srv/agy/silent-home';

    try {
      const promise = collect(
        service.invoke('Say hi', {
          workingDirectory: workDir,
          agyLogPathOverride: join(workDir, 'missing-agy.log'),
          auditContext: { invocationId: 'inv-agy-empty-unclassified-stderr' },
          accountEnv: { HOME: childHomePath },
        }),
      );
      emitPlainText(proc, '', 0, `debug: AGY completed without a text segment for ${childHomePath}\n`);

      const msgs = await promise;
      assert.equal(
        msgs.some((m) => m.type === 'error'),
        false,
        'unclassified stderr should not be promoted to an AGY error',
      );
      const diagnostic = msgs.find(
        (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
      );
      assert.ok(diagnostic, 'unclassified empty AGY output must keep silent_completion diagnostics');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-empty-unclassified-stderr');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.homeMode, 'child_env_home');
      assert.equal(diagnostic.metadata?.cliDiagnostics?.debugRef.spawnCwdMode, 'cat_cafe_agy_cwd');
      assert.match(String(diagnostic.metadata?.cliDiagnostics?.debugRef.spawnCwdKey), /^[a-f0-9]{16}$/);
      assert.ok(
        !JSON.stringify(diagnostic.metadata?.cliDiagnostics).includes(childHomePath),
        'child HOME path must not leak',
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F212: AGY auth-required output carries auth_failed cliDiagnostics without leaking OAuth URL', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-auth-diagnostics-'));

    try {
      const promise = collect(
        service.invoke('Say hi', {
          workingDirectory: workDir,
          agyLogPathOverride: join(workDir, 'missing-agy.log'),
          auditContext: { invocationId: 'inv-agy-auth' },
        }),
      );
      emitPlainText(
        proc,
        [
          'Authentication required. Please visit the URL to log in:',
          'https://accounts.google.com/o/oauth2/auth?client_id=abc&state=very-secret-state',
          'Waiting for authentication (timeout 600s)...',
          'Error: authentication interrupted.',
        ].join('\n'),
        0,
      );

      const msgs = await promise;
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err, 'auth-required AGY output must surface as an error');
      assert.equal(err.metadata?.cliDiagnostics?.reasonCode, 'auth_failed');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-auth');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.homeMode, 'process_home');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.spawnCwdMode, 'cat_cafe_agy_cwd');
      assert.match(String(err.metadata?.cliDiagnostics?.debugRef.spawnCwdKey), /^[a-f0-9]{16}$/);
      assert.ok(
        !JSON.stringify(err.metadata?.cliDiagnostics).includes('accounts.google.com'),
        'OAuth URL must not leak into cliDiagnostics payload',
      );
      assert.ok(!JSON.stringify(err.metadata?.cliDiagnostics).includes(workDir), 'worktree path must not leak');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F212: AGY nonzero cliError path rebuilds diagnostics from sanitized stderr', async () => {
    const service = new GeminiAgentService({
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-exit-diagnostics-'));
    const serverHomePath = process.env.HOME ?? '/tmp/cat-cafe-test-home';
    const childHomePath = '/srv/agy/home';
    const stderrText = [
      `401 Unauthorized while reading ${childHomePath}/.config/agy/auth.json`,
      'Open https://accounts.google.com/o/oauth2/auth#access_token=ya29.AGYAccessToken&state=very-secret-state',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('\n');
    const stdoutText = 'stdout token=stdout-secret-should-redact\n';
    const spawnCliOverride = async function* () {
      yield {
        __cliPlainText: true,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode: 1,
        signal: null,
        command: 'agy',
      };
      yield {
        __cliError: true,
        exitCode: 1,
        signal: null,
        message: 'CLI 异常退出 (code: 1, signal: none)',
        command: '/usr/local/bin/agy',
        cliDiagnostics: {
          publicSummary: 'spawnCli generic diagnostics',
          publicHint: 'spawnCli generic diagnostics',
          reasonCode: 'auth_failed',
          safeExcerpt: `${childHomePath}/.config/agy/auth.json stdout-secret-should-redact`,
          excerptSource: 'classifier',
          debugRef: {
            command: '/usr/local/bin/agy',
            exitCode: 1,
            signal: null,
          },
        },
      };
    };

    try {
      const msgs = await collect(
        service.invoke('Say hi', {
          workingDirectory: workDir,
          agyLogPathOverride: join(workDir, 'missing-agy.log'),
          auditContext: { invocationId: 'inv-agy-exit' },
          accountEnv: { HOME: childHomePath },
          spawnCliOverride,
        }),
      );
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err, 'nonzero AGY exit must surface as an error');
      assert.equal(err.metadata?.cliDiagnostics?.reasonCode, 'auth_failed');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-exit');
      assert.ok(err.metadata?.cliDiagnostics?.safeExcerpt, 'known fallback diagnostics must include safeExcerpt');

      const diagnosticsPayload = JSON.stringify(err.metadata?.cliDiagnostics);
      assert.doesNotMatch(diagnosticsPayload, /ya29\.AGYAccessToken/);
      assert.doesNotMatch(diagnosticsPayload, /very-secret-state/);
      assert.doesNotMatch(diagnosticsPayload, /eyJhbGciOiJIUzI1NiJ9/);
      assert.ok(!diagnosticsPayload.includes(serverHomePath), 'server HOME path must not leak');
      assert.ok(!diagnosticsPayload.includes(childHomePath), 'AGY child HOME path must not leak');
      assert.doesNotMatch(diagnosticsPayload, /stdout token/, 'private stdout content must not be exposed');
      assert.doesNotMatch(diagnosticsPayload, /stdout-secret-should-redact/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F212: AGY exit fallback does not classify from private stdout', async () => {
    const service = new GeminiAgentService({
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-exit-stdout-private-'));
    const stdoutText = '401 Unauthorized while streaming private model output stdout-secret-should-not-classify\n';
    const stderrText = 'debug: agy process exited after writing stdout';
    const spawnCliOverride = async function* () {
      yield {
        __cliPlainText: true,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode: 1,
        signal: null,
        command: 'agy',
      };
      yield {
        __cliError: true,
        exitCode: 1,
        signal: null,
        message: 'CLI 异常退出 (code: 1, signal: none)',
        command: '/usr/local/bin/agy',
        cliDiagnostics: {
          publicSummary: 'spawnCli generic diagnostics',
          publicHint: 'spawnCli generic diagnostics',
          reasonCode: 'auth_failed',
          safeExcerpt: stdoutText,
          excerptSource: 'classifier',
          debugRef: {
            command: '/usr/local/bin/agy',
            exitCode: 1,
            signal: null,
          },
        },
      };
    };

    try {
      const msgs = await collect(
        service.invoke('Say hi', {
          workingDirectory: workDir,
          agyLogPathOverride: join(workDir, 'missing-agy.log'),
          auditContext: { invocationId: 'inv-agy-private-stdout' },
          spawnCliOverride,
        }),
      );
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err, 'nonzero AGY exit must surface as an error');
      assert.notEqual(
        err.metadata?.cliDiagnostics?.reasonCode,
        'auth_failed',
        'private stdout must not drive public exit diagnostics classification',
      );
      assert.equal(err.metadata?.cliDiagnostics?.safeExcerpt, undefined);
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-private-stdout');

      const diagnosticsPayload = JSON.stringify(err.metadata?.cliDiagnostics);
      assert.doesNotMatch(diagnosticsPayload, /stdout-secret-should-not-classify/);
      assert.doesNotMatch(diagnosticsPayload, /private model output/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F210-H1b: yields trajectory progress side-channel while preserving final stdout text', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    // Seed an AGY appDataDir with a cascade trajectory SQLite store (3 steps already written).
    const appDataDir = mkdtempSync(join(tmpdir(), 'agy-traj-int-'));
    const uuid = 'abcdef12-3456-7890-abcd-ef1234567890';
    mkdirSync(join(appDataDir, 'conversations'));
    const tdb = new Database(join(appDataDir, 'conversations', `${uuid}.db`));
    tdb.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );
    const ins = tdb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
    ins.run(0, 14, 3);
    ins.run(1, 9, 3);
    ins.run(2, 15, 3);
    tdb.close();

    // Seed the AGY --log-file the observer reads (carries appDataDir + cascade uuid).
    const logPath = join(appDataDir, 'agy.log');
    writeFileSync(logPath, `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const promise = collect(service.invoke('Say hi', { workingDirectory: workDir, agyLogPathOverride: logPath }));
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await promise;

    const progress = msgs.filter(
      (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('agy_trajectory_progress'),
    );
    assert.ok(progress.length >= 1, 'should yield trajectory progress side-channel events');
    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text?.content, 'AGY_FINAL_REPLY', 'final text must equal agy stdout — semantics unchanged');

    rmSync(appDataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210: resumed AGY progress side-channel skips historical steps from the same conversation db', async () => {
    const proc = createMockProcess();
    const accountHome = mkdtempSync(join(tmpdir(), 'agy-resume-home-'));
    const appDataDir = join(accountHome, '.gemini', 'antigravity-cli');
    const uuid = '33333333-3456-7890-abcd-ef1234567890';
    const convDir = join(appDataDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = join(convDir, `${uuid}.db`);
    const tdb = new Database(dbPath);
    tdb.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );
    const ins = tdb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
    ins.run(0, 14, 3); // previous turn; must not be replayed on this invocation's progress bubble
    tdb.close();

    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      writeFileSync(args[logIndex + 1], `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);
      const db = new Database(dbPath);
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 3);
      db.close();
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const msgsPromise = collect(
      service.invoke('Resume and continue', {
        sessionId: uuid,
        workingDirectory: workDir,
        accountEnv: { HOME: accountHome },
      }),
    );
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await msgsPromise;

    const progressIdxs = msgs
      .filter((m) => m.type === 'system_info' && typeof m.content === 'string')
      .map((m) => JSON.parse(m.content))
      .filter((payload) => payload.type === 'agy_trajectory_progress')
      .map((payload) => payload.idx);

    assert.deepEqual(progressIdxs, [1], 'resumed progress must be per-invocation delta, not 0..N cumulative');

    rmSync(accountHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210: same-path recreated AGY db does not apply stale resume baseline', async () => {
    const proc = createMockProcess();
    const accountHome = mkdtempSync(join(tmpdir(), 'agy-recreated-home-'));
    const appDataDir = join(accountHome, '.gemini', 'antigravity-cli');
    const uuid = '44444444-3456-7890-abcd-ef1234567890';
    const convDir = join(appDataDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = join(convDir, `${uuid}.db`);
    let db = new Database(dbPath);
    db.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(7, 14, 3);
    db.close();

    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      writeFileSync(args[logIndex + 1], `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);
      db.exec(
        'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
      );
      db.close();
      setTimeout(() => {
        const nextDb = new Database(dbPath);
        nextDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(0, 15, 3);
        nextDb.close();
      }, 50);
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const msgsPromise = collect(
      service.invoke('Resume after recreated DB', {
        sessionId: uuid,
        workingDirectory: workDir,
        accountEnv: { HOME: accountHome },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await msgsPromise;

    const progressIdxs = msgs
      .filter((m) => m.type === 'system_info' && typeof m.content === 'string')
      .map((m) => JSON.parse(m.content))
      .filter((payload) => payload.type === 'agy_trajectory_progress')
      .map((payload) => payload.idx);

    assert.deepEqual(progressIdxs, [0], 'recreated same-path DB must read current low idx instead of stale baseline');

    rmSync(accountHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210: same-path recreated AGY db reads current steps even after idx reaches old baseline', async () => {
    const proc = createMockProcess();
    const accountHome = mkdtempSync(join(tmpdir(), 'agy-recreated-caught-up-home-'));
    const appDataDir = join(accountHome, '.gemini', 'antigravity-cli');
    const uuid = '55555555-3456-7890-abcd-ef1234567890';
    const convDir = join(appDataDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = join(convDir, `${uuid}.db`);
    let db = new Database(dbPath);
    db.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );
    const previousInsert = db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
    for (let idx = 0; idx <= 7; idx += 1) previousInsert.run(idx, 14, 3);
    db.close();

    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      writeFileSync(args[logIndex + 1], `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);
      rmSync(dbPath, { force: true });
      db = new Database(dbPath);
      db.exec(
        'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
      );
      const currentInsert = db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
      for (let idx = 0; idx <= 8; idx += 1) currentInsert.run(idx, 15, 3);
      db.close();
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const msgsPromise = collect(
      service.invoke('Resume after recreated DB catches old max', {
        sessionId: uuid,
        workingDirectory: workDir,
        accountEnv: { HOME: accountHome },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await msgsPromise;

    const progressIdxs = msgs
      .filter((m) => m.type === 'system_info' && typeof m.content === 'string')
      .map((m) => JSON.parse(m.content))
      .filter((payload) => payload.type === 'agy_trajectory_progress')
      .map((payload) => payload.idx);

    assert.deepEqual(
      progressIdxs,
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      'recreated same-path DB must not skip current low idx even when current max has caught the old baseline',
    );

    rmSync(accountHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210: same-identity rewritten AGY db reads current steps even after idx reaches old baseline', async () => {
    const proc = createMockProcess();
    const accountHome = mkdtempSync(join(tmpdir(), 'agy-rewritten-same-identity-home-'));
    const appDataDir = join(accountHome, '.gemini', 'antigravity-cli');
    const uuid = '66666666-3456-7890-abcd-ef1234567890';
    const convDir = join(appDataDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = join(convDir, `${uuid}.db`);
    const db = new Database(dbPath);
    db.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );
    const previousInsert = db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
    for (let idx = 0; idx <= 7; idx += 1) previousInsert.run(idx, 14, 3);
    db.close();

    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      writeFileSync(args[logIndex + 1], `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);
      const currentDb = new Database(dbPath);
      currentDb.exec('DELETE FROM steps;');
      const currentInsert = currentDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
      for (let idx = 0; idx <= 8; idx += 1) currentInsert.run(idx, 15, 3);
      currentDb.close();
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const msgsPromise = collect(
      service.invoke('Resume after same-identity rewritten DB catches old max', {
        sessionId: uuid,
        workingDirectory: workDir,
        accountEnv: { HOME: accountHome },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await msgsPromise;

    const progressIdxs = msgs
      .filter((m) => m.type === 'system_info' && typeof m.content === 'string')
      .map((m) => JSON.parse(m.content))
      .filter((payload) => payload.type === 'agy_trajectory_progress')
      .map((payload) => payload.idx);

    assert.deepEqual(
      progressIdxs,
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      'same-identity rewritten DB must not skip current low idx when current max has caught the old baseline',
    );

    rmSync(accountHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210: baseline-row collision does not prove rewritten AGY db continuity', async () => {
    const proc = createMockProcess();
    const accountHome = mkdtempSync(join(tmpdir(), 'agy-row-collision-home-'));
    const appDataDir = join(accountHome, '.gemini', 'antigravity-cli');
    const uuid = '77777777-3456-7890-abcd-ef1234567890';
    const convDir = join(appDataDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = join(convDir, `${uuid}.db`);
    const db = new Database(dbPath);
    db.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );
    const previousInsert = db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
    for (let idx = 0; idx <= 7; idx += 1) previousInsert.run(idx, 14, 3);
    db.close();

    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      writeFileSync(args[logIndex + 1], `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);
      const currentDb = new Database(dbPath);
      currentDb.exec('DELETE FROM steps;');
      const currentInsert = currentDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
      for (let idx = 0; idx <= 6; idx += 1) currentInsert.run(idx, 15, 3);
      currentInsert.run(7, 14, 3); // Collides with the old baseline row, but the DB prefix changed.
      currentInsert.run(8, 15, 3);
      currentDb.close();
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const msgsPromise = collect(
      service.invoke('Resume after rewritten DB baseline-row collision', {
        sessionId: uuid,
        workingDirectory: workDir,
        accountEnv: { HOME: accountHome },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await msgsPromise;

    const progressIdxs = msgs
      .filter((m) => m.type === 'system_info' && typeof m.content === 'string')
      .map((m) => JSON.parse(m.content))
      .filter((payload) => payload.type === 'agy_trajectory_progress')
      .map((payload) => payload.idx);

    assert.deepEqual(
      progressIdxs,
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      'single baseline-row collision must not skip current low idx from a rewritten DB',
    );

    rmSync(accountHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210-H4: yields tool_use and tool_result messages extracted from trajectory payload', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });

    const appDataDir = mkdtempSync(join(tmpdir(), 'agy-traj-tool-'));
    const uuid = 'abcdef12-3456-7890-abcd-ef1234567890';
    mkdirSync(join(appDataDir, 'conversations'));
    const tdb = new Database(join(appDataDir, 'conversations', `${uuid}.db`));
    tdb.exec(
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer, PRIMARY KEY(idx));',
    );

    // 辅助编码
    const encodeVarint = (val) => {
      const buf = [];
      let temp = val;
      while (temp >= 0x80) {
        buf.push((temp & 0x7f) | 0x80);
        temp = temp >>> 7;
      }
      buf.push(temp & 0x7f);
      return Buffer.from(buf);
    };
    const encodeLengthDelimited = (fieldNum, content) => {
      const tag = (fieldNum << 3) | 2;
      const tagBuf = encodeVarint(tag);
      const contentBuf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      const lenBuf = encodeVarint(contentBuf.length);
      return Buffer.concat([tagBuf, lenBuf, contentBuf]);
    };

    // 拼装一个包含 list_dir 调用的 payload 并嵌套于 field 5 中
    const innerBytes = Buffer.concat([
      encodeLengthDelimited(2, 'list_dir'),
      encodeLengthDelimited(12, '99999999-9999-9999-9999-999999999999'),
      encodeLengthDelimited(3, '{"DirectoryPath":"/tmp"}'),
    ]);
    const payloadBytes = encodeLengthDelimited(5, innerBytes);

    const ins = tdb.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)');
    ins.run(0, 9, 3, payloadBytes); // idx 0: completed tool step
    tdb.close();

    const logPath = join(appDataDir, 'agy.log');
    writeFileSync(logPath, `appDataDir=${appDataDir}\nCreated conversation ${uuid}\n`);

    const workDir = mkdtempSync(join(tmpdir(), 'agy-workdir-'));
    const promise = collect(service.invoke('Say hi', { workingDirectory: workDir, agyLogPathOverride: logPath }));
    emitPlainText(proc, 'AGY_FINAL_REPLY\n');
    const msgs = await promise;

    const toolUse = msgs.find((m) => m.type === 'tool_use');
    const toolResult = msgs.find((m) => m.type === 'tool_result');

    assert.ok(toolUse, 'should yield tool_use message');
    assert.equal(toolUse.toolName, 'list_dir');
    assert.equal(toolUse.toolUseId, '99999999-9999-9999-9999-999999999999');
    assert.deepEqual(toolUse.toolInput, { DirectoryPath: '/tmp' });

    assert.ok(toolResult, 'should yield tool_result message');
    assert.equal(toolResult.toolName, 'list_dir');
    assert.equal(toolResult.toolUseId, '99999999-9999-9999-9999-999999999999');

    rmSync(appDataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210-H1b P1-2: liveness warning flushes in real time even when progress is fail-open', async () => {
    const service = new GeminiAgentService({ adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });
    const start = Date.now();
    let plainTextEmittedAt = 0;
    // Emit a liveness warning immediately, keep "running" 400ms, then finish.
    const spawnCliOverride = () =>
      (async function* () {
        yield { __livenessWarning: true, level: 'suspected_stall', state: 'idle-silent', silenceDurationMs: 1000 };
        await new Promise((r) => setTimeout(r, 400));
        plainTextEmittedAt = Date.now() - start;
        yield { __cliPlainText: true, stdout: 'FINAL_AFTER_STALL', stderr: '', exitCode: 0, signal: null };
      })();

    const workDir = mkdtempSync(join(tmpdir(), 'agy-live-'));
    let livenessYieldedAt = -1;
    const msgs = [];
    // no resolvable DB → observeAgyProgress is fail-open (zero progress). Liveness must NOT be
    // buffered until agy completion (that would be worse than the pre-H1b real-time behavior).
    for await (const m of service.invoke('hi', {
      workingDirectory: workDir,
      spawnCliOverride,
      agyLogPathOverride: join(workDir, 'nonexistent-agy.log'),
    })) {
      msgs.push(m);
      if (livenessYieldedAt < 0 && m.type === 'system_info' && String(m.content).includes('liveness_warning')) {
        livenessYieldedAt = Date.now() - start;
      }
    }
    assert.ok(livenessYieldedAt >= 0, 'liveness warning must be yielded');
    assert.ok(
      livenessYieldedAt < plainTextEmittedAt,
      `liveness must flush mid-run (@${livenessYieldedAt}ms), not buffered to agy completion (@${plainTextEmittedAt}ms)`,
    );
    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text?.content, 'FINAL_AFTER_STALL', 'final text unchanged');
    rmSync(workDir, { recursive: true, force: true });
  });

  test('F210-H1b cloud-P1: consumer spawn rejection handled without unhandled rejection', async () => {
    const rejections = [];
    const onRej = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRej);
    try {
      const service = new GeminiAgentService({ adapter: 'antigravity-cli', model: 'gemini-3.5-flash' });
      const workDir = mkdtempSync(join(tmpdir(), 'agy-boom-'));
      // Consumer throws mid-stream (after a non-terminal event) while progress is still polling
      // a non-existent DB (fail-open sleep window) — the unhandled-rejection window from the old code.
      const spawnCliOverride = () =>
        (async function* () {
          yield { __livenessWarning: true, level: 'suspected_stall', state: 'idle-silent' };
          await new Promise((r) => setTimeout(r, 30));
          throw new Error('AGY_SPAWN_BOOM');
        })();
      const msgs = await collect(
        service.invoke('hi', {
          workingDirectory: workDir,
          spawnCliOverride,
          agyLogPathOverride: join(workDir, 'none.log'),
        }),
      );
      assert.ok(
        msgs.find((m) => m.type === 'done'),
        'invoke must yield done even when the spawn consumer throws',
      );
      assert.ok(
        msgs.find((m) => m.type === 'error' && String(m.error).includes('AGY_SPAWN_BOOM')),
        'consumer error must surface as a normal error message',
      );
      await new Promise((r) => setTimeout(r, 60)); // let any stray unhandled rejection surface
      assert.equal(rejections.length, 0, 'consumer rejection must be handled — no unhandledRejection');
      rmSync(workDir, { recursive: true, force: true });
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });

  test('filters user-provided AGY yolo flags without sandbox proof', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });

    const promise = collect(
      service.invoke('Say hi', {
        cliConfigArgs: [
          '--dangerously-skip-permissions --dangerously-skip-permissions=true --add-dir /tmp/extra-agy-dir',
        ],
      }),
    );
    emitPlainText(proc, 'AGY_OK\n');
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(
      args.some((arg) => arg === '--dangerously-skip-permissions' || arg.startsWith('--dangerously-skip-permissions=')),
      false,
      'unprofiled user cliConfigArgs must not bypass the yolo sandbox gate',
    );
    assert.ok(args.includes('/tmp/extra-agy-dir'), 'unrelated user --add-dir should remain');
  });

  test('uses isolated AGY profile HOME and gates yolo on sandbox proof', async () => {
    const proc = createMockProcess();
    const profileRoot = mkdtempSync(join(tmpdir(), 'agy-service-profile-root-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agy-service-workdir-'));
    const spawnFn = mock.fn((_command, args, opts) => {
      const logPath = args[args.indexOf('--log-file') + 1];
      writeFileSync(
        logPath,
        'I0531 01:14:59.518377 model.go:42] Propagating selected model override to backend: label="Gemini 3.5 Flash (High)"\n',
      );
      // F210 cache-leak regression: 模拟 AGY 写 cwd-relative cache/projects.json 到 spawn cwd
      // （实证 2026-06-03 真跑行为）。spawn cwd 必须是 profile sandbox，不能是 workDir/repo root。
      if (opts?.cwd) {
        mkdirSync(join(opts.cwd, 'cache'), { recursive: true });
        writeFileSync(join(opts.cwd, 'cache', 'projects.json'), '{}');
      }
      return proc;
    });
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'Gemini 3.5 Flash (High)',
      agyProfile: { enabled: true, homeRoot: profileRoot, model: 'Gemini 3.5 Flash (High)' },
    });

    try {
      const promise = collect(service.invoke('profile prompt', { workingDirectory: workDir }));
      emitPlainText(proc, 'AGY_PROFILE_OK\n');

      const msgs = await promise;
      const done = msgs.find((m) => m.type === 'done');
      assert.equal(done?.metadata?.model, 'Gemini 3.5 Flash (High) (antigravity-cli profile)');
      assert.equal(done?.metadata?.modelVerified, true);

      const call = spawnFn.mock.calls[0];
      const args = call.arguments[1];
      assert.ok(args.includes('--dangerously-skip-permissions'), 'sandboxed profile should enable yolo');
      assert.equal(call.arguments[2].env.HOME, join(profileRoot, 'gemini'));

      // F210 cache-leak fix: spawn cwd = profile cwd sandbox 下 per-worktree 子目录（cloud P1：AGY 按 cwd
      // scope conversation 命名空间，每 worktree 唯一）。cwd-relative cache 落 profile 不 repo；
      // workspace 仍由 --add-dir workDir 授权。
      const cwdBase = join(profileRoot, 'gemini', 'cwd');
      const spawnCwd = call.arguments[2].cwd;
      assert.ok(
        spawnCwd.startsWith(`${cwdBase}/`) && spawnCwd !== cwdBase,
        `spawn cwd 应是 profile cwd base 下 per-worktree 子目录，实际 ${spawnCwd}`,
      );
      assert.equal(
        done?.metadata?.diagnostics?.antigravityCli?.spawnCwd,
        spawnCwd,
        'diagnostics.antigravityCli.spawnCwd 应暴露隔离后的 spawn cwd',
      );
      assert.ok(
        args.includes('--add-dir') && args.includes(workDir),
        'workspace 仍由 --add-dir workingDirectory 显式授权',
      );
      assert.ok(existsSync(join(spawnCwd, 'cache', 'projects.json')), 'cwd-relative cache 落 profile sandbox');
      assert.ok(!existsSync(join(workDir, 'cache', 'projects.json')), 'workDir(repo) 不得生成 cache/projects.json');

      const settingsPath = join(profileRoot, 'gemini', '.gemini', 'antigravity-cli', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      assert.equal(settings.model, 'Gemini 3.5 Flash (High)');
      assert.deepEqual(settings.trustedWorkspaces, [workDir]);
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('no AGY profile: spawn cwd is deterministic sandbox, cwd-relative cache never leaks into repo (F210 cache-leak)', async () => {
    // production gemini/gemini25 当前就是 no-agyProfile 路径——cwd-relative cache 必须落默认 sandbox 而非 repo root。
    const proc = createMockProcess();
    const cwdRoot = mkdtempSync(join(tmpdir(), 'agy-cwd-root-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agy-noprofile-workdir-'));
    const prevEnv = process.env.CAT_CAFE_AGY_CWD_ROOT;
    process.env.CAT_CAFE_AGY_CWD_ROOT = cwdRoot;
    const spawnFn = mock.fn((_command, _args, opts) => {
      // 模拟 AGY 写 cwd-relative cache/projects.json 到 spawn cwd（实证 2026-06-03 真跑行为）
      if (opts?.cwd) {
        mkdirSync(join(opts.cwd, 'cache'), { recursive: true });
        writeFileSync(join(opts.cwd, 'cache', 'projects.json'), '{}');
      }
      return proc;
    });
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'Gemini 3.5 Flash (High)',
      // 无 agyProfile：复现 production gemini 默认路径
    });

    try {
      const promise = collect(service.invoke('noprofile prompt', { workingDirectory: workDir }));
      emitPlainText(proc, 'AGY_NOPROFILE_OK\n');
      const collected = await promise;

      const call = spawnFn.mock.calls[0];
      const args = call.arguments[1];
      // service catId 默认 'gemini' → base = <root>/gemini，spawn cwd = base 下 per-worktree 子目录（cloud P1）
      const base = join(cwdRoot, 'gemini');
      const spawnCwd = call.arguments[2].cwd;
      assert.ok(
        spawnCwd.startsWith(`${base}/`) && spawnCwd !== base,
        `no-profile spawn cwd 应是 base 下 per-worktree 子目录，实际 ${spawnCwd}`,
      );
      const done = collected.find((m) => m.type === 'done');
      assert.equal(
        done?.metadata?.diagnostics?.antigravityCli?.spawnCwd,
        spawnCwd,
        'diagnostics.antigravityCli.spawnCwd 应暴露隔离后的 spawn cwd',
      );
      assert.ok(
        args.includes('--add-dir') && args.includes(workDir),
        'workspace 仍由 --add-dir workingDirectory 显式授权',
      );
      assert.ok(existsSync(join(spawnCwd, 'cache', 'projects.json')), 'cwd-relative cache 落默认 sandbox');
      assert.ok(!existsSync(join(workDir, 'cache', 'projects.json')), 'workDir(repo) 不得生成 cache/projects.json');
    } finally {
      if (prevEnv === undefined) delete process.env.CAT_CAFE_AGY_CWD_ROOT;
      else process.env.CAT_CAFE_AGY_CWD_ROOT = prevEnv;
      rmSync(cwdRoot, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('normalizes relative workingDirectory to absolute for --add-dir (cloud P2: relative path vs sandbox cwd)', async () => {
    // cloud P2：spawn cwd 现在是独立 sandbox，若 workingDirectory 是相对路径（如 "."），
    // 透传给 --add-dir 会相对 sandbox cwd 解析 → AGY 授权错目录。必须 normalize 成绝对路径。
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'Gemini 3.5 Flash (High)',
    });

    const promise = collect(service.invoke('relative cwd', { workingDirectory: '.' }));
    emitPlainText(proc, 'AGY_REL_OK\n');
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const addDirIdx = args.indexOf('--add-dir');
    assert.ok(addDirIdx >= 0, 'must pass --add-dir');
    const addDirVal = args[addDirIdx + 1];
    assert.notEqual(addDirVal, '.', '不能透传相对路径（会相对 sandbox cwd 解析 → 授权错目录）');
    assert.equal(addDirVal, resolve('.'), '--add-dir 必须是绝对路径（resolve(".") = process.cwd()）');
    assert.ok(addDirVal.startsWith('/'), 'normalize 后必须是绝对路径');
  });

  test('fails closed when AGY observed model differs from the configured profile model', async () => {
    const proc = createMockProcess();
    const profileRoot = mkdtempSync(join(tmpdir(), 'agy-service-profile-root-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agy-service-workdir-'));
    const wrongModelConversationId = 'e40c0f44-8e00-4b21-8ea4-7b17f182a134';
    const spawnFn = mock.fn((_command, args) => {
      const logPath = args[args.indexOf('--log-file') + 1];
      writeFileSync(
        logPath,
        'I0531 01:14:59.518377 model.go:42] Propagating selected model override to backend: label="Gemini 3.1 Pro (High)"\n' +
          `I0531 01:14:59.518377 server.go:755] Created conversation ${wrongModelConversationId}\n`,
      );
      return proc;
    });
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'Gemini 3.5 Flash (High)',
      agyProfile: { enabled: true, homeRoot: profileRoot, model: 'Gemini 3.5 Flash (High)' },
    });

    try {
      const promise = collect(service.invoke('profile prompt', { workingDirectory: workDir }));
      emitPlainText(proc, 'WRONG_MODEL_TEXT\n');

      const msgs = await promise;
      assert.equal(
        msgs.some((m) => m.type === 'text'),
        false,
        'wrong-model AGY output must not be surfaced as successful profile text',
      );
      assert.equal(
        msgs.some((m) => m.type === 'session_init'),
        false,
        'wrong-model AGY output must not record a resumable conversation',
      );
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err);
      assert.match(err.error, /selected model mismatch/);
      assert.equal(err.metadata?.modelVerified, false);
      assert.equal(err.metadata?.diagnostics?.antigravityCli?.observedModel, 'Gemini 3.1 Pro (High)');
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('fails closed when profiled AGY output lacks an observed selected model label', async () => {
    const proc = createMockProcess();
    const profileRoot = mkdtempSync(join(tmpdir(), 'agy-service-profile-root-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agy-service-workdir-'));
    const spawnFn = mock.fn((_command, args) => {
      const logPath = args[args.indexOf('--log-file') + 1];
      writeFileSync(logPath, 'I0531 01:14:59.518377 server.go:755] Created conversation missing-model-label\n');
      return proc;
    });
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'Gemini 3.5 Flash (High)',
      agyProfile: { enabled: true, homeRoot: profileRoot, model: 'Gemini 3.5 Flash (High)' },
    });

    try {
      const promise = collect(service.invoke('profile prompt', { workingDirectory: workDir }));
      emitPlainText(proc, 'UNVERIFIED_MODEL_TEXT\n');

      const msgs = await promise;
      assert.equal(
        msgs.some((m) => m.type === 'text'),
        false,
        'profiled AGY output without a selected-model log label must not be surfaced',
      );
      assert.equal(
        msgs.some((m) => m.type === 'session_init'),
        false,
        'unverified profile output must not record a resumable conversation',
      );
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err);
      assert.match(err.error, /selected model.*not verified/i);
      assert.equal(err.metadata?.modelVerified, false);
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('F212: AGY profiled empty stdout prioritizes classified stderr before missing-model fallback', async () => {
    const proc = createMockProcess();
    const profileRoot = mkdtempSync(join(tmpdir(), 'agy-service-profile-root-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agy-service-workdir-'));
    const profileHomePath = join(profileRoot, 'gemini');
    const spawnFn = mock.fn((_command, args) => {
      const logPath = args[args.indexOf('--log-file') + 1];
      writeFileSync(logPath, 'I0531 01:14:59.518377 server.go:755] Created conversation auth-before-model\n');
      return proc;
    });
    const service = new GeminiAgentService({
      spawnFn,
      adapter: 'antigravity-cli',
      model: 'Gemini 3.5 Flash (High)',
      agyProfile: { enabled: true, homeRoot: profileRoot, model: 'Gemini 3.5 Flash (High)' },
    });

    try {
      const promise = collect(
        service.invoke('profile prompt', {
          workingDirectory: workDir,
          auditContext: { invocationId: 'inv-agy-profile-auth-stderr' },
        }),
      );
      emitPlainText(
        proc,
        '',
        0,
        [
          `401 Unauthorized while reading ${profileHomePath}/.config/agy/auth.json`,
          'https://accounts.google.com/o/oauth2/auth#state=very-secret-state&access_token=ya29.AGYAccessToken',
        ].join('\n'),
      );

      const msgs = await promise;
      const err = msgs.find((m) => m.type === 'error');
      assert.ok(err, 'profiled empty stdout with actionable AGY stderr must surface as an error');
      assert.doesNotMatch(err.error, /selected model.*not verified/i);
      assert.equal(err.metadata?.cliDiagnostics?.reasonCode, 'auth_failed');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.command, 'agy');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-agy-profile-auth-stderr');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.homeMode, 'agy_profile_home');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.spawnCwdMode, 'agy_profile_cwd');
      assert.equal(err.metadata?.cliDiagnostics?.debugRef.profileId, 'gemini');
      assert.match(String(err.metadata?.cliDiagnostics?.debugRef.spawnCwdKey), /^[a-f0-9]{16}$/);
      assert.equal(
        msgs.some((m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
        false,
        'classified stderr must not be downgraded to silent_completion',
      );

      const diagnosticsPayload = JSON.stringify(err.metadata?.cliDiagnostics);
      assert.match(diagnosticsPayload, /FRAGMENT_REDACTED/);
      assert.doesNotMatch(diagnosticsPayload, new RegExp(profileHomePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(diagnosticsPayload, new RegExp(workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(diagnosticsPayload, /very-secret-state/);
      assert.doesNotMatch(diagnosticsPayload, /ya29\.AGYAccessToken/);
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('records the AGY-created conversation id on first turn', async () => {
    const proc = createMockProcess();
    const actualConversationId = 'e40c0f44-8e00-4b21-8ea4-7b17f182a134';
    let capturedLogPath;
    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file to capture the real conversation id');
      const logPath = args[logIndex + 1];
      capturedLogPath = logPath;
      writeFileSync(
        logPath,
        `I0531 01:14:59.518377 server.go:755] Created conversation ${actualConversationId}\n` +
          `I0531 01:14:59.518698 printmode.go:130] Print mode: conversation=${actualConversationId}, sending message\n`,
      );
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('new agy thread'));
    emitPlainText(proc, 'AGY_SESSION_OK\n');

    const msgs = await promise;
    assert.equal(msgs[0].type, 'session_init');
    assert.equal(msgs[0].sessionId, actualConversationId);
    assert.equal(msgs[1].type, 'text');
    assert.equal(msgs[1].content, 'AGY_SESSION_OK');

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--log-file'));
    assert.equal(args.includes('--conversation'), false, 'fresh AGY turns must not pass a made-up conversation id');
    assertFileRemoved(capturedLogPath, 'runtime-owned AGY log file must be removed after capturing conversation id');
  });

  test('removes the AGY log file on provider error paths', async () => {
    const proc = createMockProcess();
    let capturedLogPath;
    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      capturedLogPath = args[logIndex + 1];
      writeFileSync(capturedLogPath, 'I0531 01:14:59.518377 server.go:755] provider error path\n');
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('slow prompt'));
    emitPlainText(proc, 'Error: timed out waiting for response\n', 0);

    const msgs = await promise;
    assert.ok(
      msgs.some((m) => m.type === 'error'),
      'provider error path should still report the error',
    );
    assertFileRemoved(capturedLogPath, 'runtime-owned AGY log file must be removed on provider error');
  });

  test('marks resumed agy stdout as replace because print mode can replay prior text', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('resume agy thread', { sessionId: 'agy-existing-session' }));
    emitPlainText(proc, 'OLD_ASSISTANT_TEXT\nNEW_ASSISTANT_TEXT\n');

    const msgs = await promise;
    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text?.content, 'OLD_ASSISTANT_TEXT\nNEW_ASSISTANT_TEXT');
    assert.equal(text?.textMode, 'replace');

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args[args.indexOf('--conversation') + 1], 'agy-existing-session');
  });

  test('treats log-only stale agy conversation warnings as missing session on resume', async () => {
    const proc = createMockProcess();
    let capturedLogPath;
    const spawnFn = mock.fn((_command, args) => {
      const logIndex = args.indexOf('--log-file');
      assert.ok(logIndex >= 0, 'antigravity-cli adapter must pass --log-file');
      capturedLogPath = args[logIndex + 1];
      writeFileSync(
        capturedLogPath,
        [
          'W0531 01:14:56.217832 common.go:246] Conversation stale-agy-session not found, ignoring --conversation flag',
          'I0531 01:14:59.518377 server.go:755] Created conversation e40c0f44-8e00-4b21-8ea4-7b17f182a134',
        ].join('\n'),
      );
      return proc;
    });
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('resume agy thread', { sessionId: 'stale-agy-session' }));
    emitPlainText(proc, 'NEW_TEXT_WITHOUT_CONTEXT\n');

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'text'),
      false,
      'stale resume must not surface fresh-context stdout as a successful continuation',
    );
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'log-only stale resume warning must produce an error');
    assert.match(err.error, /No conversation found with session ID: stale-agy-session/);

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args[args.indexOf('--conversation') + 1], 'stale-agy-session');
    assertFileRemoved(capturedLogPath, 'runtime-owned AGY log file must be removed after stale resume handling');
  });

  test('reports per-call model override as unsupported without passing --model to agy', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(
      service.invoke('model override check', {
        callbackEnv: { CAT_CAFE_GEMINI_MODEL_OVERRIDE: 'gemini-override-should-not-be-used' },
      }),
    );
    emitPlainText(proc, 'AGY_MODEL_BOUNDARY_OK\n');

    const msgs = await promise;
    const info = msgs.find((m) => {
      if (m.type !== 'system_info' || typeof m.content !== 'string') return false;
      return JSON.parse(m.content).type === 'antigravity_cli_model_override_unsupported';
    });
    assert.ok(info, 'unsupported model override should be explicit system_info');
    const payload = JSON.parse(info.content);
    assert.equal(payload.requestedModel, 'gemini-override-should-not-be-used');
    assert.match(payload.reason, /account-side selected model/);

    const done = msgs.find((m) => m.type === 'done');
    assert.equal(done?.metadata?.modelVerified, false);

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args.includes('--model'), false);
  });

  test('passes image inputs as local path hints and add-dir access, not native image flags', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });
    const workDir = mkdtempSync(join(tmpdir(), 'agy-image-workdir-'));
    const uploadDir = join(workDir, 'uploads');
    mkdirSync(uploadDir, { recursive: true });

    const promise = collect(
      service.invoke('describe this image', {
        workingDirectory: workDir,
        uploadDir,
        contentBlocks: [{ type: 'image', url: '/uploads/example.png' }],
      }),
    );
    emitPlainText(proc, 'AGY_IMAGE_HINT_OK\n');
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const addDirs = args.flatMap((arg, index) => (arg === '--add-dir' ? [args[index + 1]] : []));
    assert.ok(addDirs.includes(workDir), 'repo workdir should remain accessible');
    assert.ok(addDirs.includes(uploadDir), 'image upload dir should be accessible');
    assert.equal(args.includes('--image'), false);
    assert.equal(args.includes('-i'), false);
    assert.match(args[args.indexOf('--print') + 1], /\[Local image path: .*example\.png\]/);
  });

  test('uses spawnCliOverride for agy plain stdout execution', async () => {
    const spawnFn = mock.fn(() => {
      throw new Error('direct spawn should not be used when spawnCliOverride is present');
    });
    let capturedOpts;
    const spawnCliOverride = async function* (opts) {
      capturedOpts = opts;
      yield {
        __cliPlainText: true,
        stdout: 'AGY_OVERRIDE_OK\n',
        stderr: '',
        exitCode: 0,
        signal: null,
        command: opts.command,
      };
    };
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const msgs = await collect(
      service.invoke('override agy', {
        workingDirectory: '/tmp/agy-override',
        spawnCliOverride,
        invocationId: 'inv-agy-override',
        cliSessionId: 'cli-agy-override',
      }),
    );

    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text?.content, 'AGY_OVERRIDE_OK');
    assert.equal(spawnFn.mock.callCount(), 0);
    assert.equal(capturedOpts?.outputMode, 'plainText');
    assert.ok(capturedOpts?.command === 'agy' || capturedOpts?.command.endsWith('/agy'));
    // F210 cache-leak fix: spawn cwd 不再是 workingDirectory（AGY 写 cwd-relative cache/projects.json
    // 会泄漏到 repo），而是默认 sandbox 下 per-worktree 子目录（无 agyProfile，catId='gemini'，cloud P1）。
    assert.notEqual(capturedOpts?.cwd, '/tmp/agy-override', 'spawn cwd 不应是 workingDirectory（cache leak）');
    assert.ok(
      capturedOpts?.cwd?.includes('/.cat-cafe/agy-cwd/gemini/'),
      `spawn cwd 应是默认 cwd sandbox 下 per-worktree 子目录，实际 ${capturedOpts?.cwd}`,
    );
    assert.equal(capturedOpts?.invocationId, 'inv-agy-override');
    assert.equal(capturedOpts?.cliSessionId, 'cli-agy-override');
  });

  test('filters equals-form user overrides for runtime-owned AGY conversation and log flags', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(
      service.invoke('resume agy thread', {
        sessionId: 'agy-real-session',
        cliConfigArgs: ['--conversation=stale-session --log-file=/tmp/user-owned-agy.log --add-dir /tmp/extra-agy-dir'],
      }),
    );
    emitPlainText(proc, 'AGY_EQUALS_OVERRIDE_OK\n');

    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(
      args.some((arg) => arg.startsWith('--conversation=')),
      false,
      'equals-form user --conversation must be removed',
    );
    assert.equal(
      args.some((arg) => arg.startsWith('--log-file=')),
      false,
      'equals-form user --log-file must be removed',
    );
    assert.equal(args[args.indexOf('--conversation') + 1], 'agy-real-session');
    assert.ok(args.includes('--log-file'), 'internal runtime-owned --log-file should remain');
    assert.ok(args.includes('/tmp/extra-agy-dir'), 'unrelated user --add-dir should remain');
  });

  test('waits for process close before classifying final agy stdout', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('stdout after exit'));
    emitExitThenLatePlainTextBeforeClose(proc, 'AGY_LATE_OK\n');

    const msgs = await promise;
    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text?.content, 'AGY_LATE_OK');
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('classifies agy stdout timeout as an error even when process exits 0', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('slow prompt'));
    emitPlainText(proc, 'Error: timed out waiting for response\n', 0);

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'text'),
      false,
    );
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'timeout stdout must produce an error');
    assert.match(err.error, /超时|timeout/i);
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('does not classify normal agy text mentioning timeout phrase as provider timeout', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('explain timeout wording'));
    emitPlainText(proc, 'The CLI phrase `timed out waiting for response` is only an example.\n', 0);

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'error'),
      false,
    );
    const text = msgs.find((m) => m.type === 'text');
    assert.match(text?.content ?? '', /timed out waiting for response/);
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('does not classify normal agy text starting with Error as provider error', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('quote an error-prefixed answer'));
    emitPlainText(proc, 'Error: this is quoted model output, not a CLI failure.\n', 0);

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'error'),
      false,
    );
    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text?.content, 'Error: this is quoted model output, not a CLI failure.');
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('classifies missing selected model as actionable onboarding error', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('hello'));
    emitPlainText(proc, 'Error: neither PlanModel nor RequestedModel specified. You must specify a valid model.\n', 0);

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'text'),
      false,
    );
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'missing model stdout must produce an error');
    assert.match(err.error, /\/model/);
    assert.match(err.error, /Antigravity CLI|AGY/);
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('classifies auth-required agy stdout as provider error instead of model text', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('hello from isolated profile'));
    emitPlainText(
      proc,
      [
        'Authentication required. Please visit the URL to log in:',
        '  https://accounts.google.com/o/oauth2/auth?[REDACTED]',
        '',
        'Waiting for authentication (timeout 30s)...',
        'Or, paste the authorization code here and press Enter:',
        '',
        'Error: authentication interrupted.',
      ].join('\n'),
      0,
    );

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'text'),
      false,
    );
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'auth-required stdout must produce an error');
    assert.match(err.error, /Antigravity CLI|AGY/);
    assert.match(err.error, /login|auth/i);
    assert.doesNotMatch(err.error, /accounts\.google\.com/);
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('does not classify normal agy text mentioning model onboarding as missing model', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });

    const promise = collect(service.invoke('explain model onboarding'));
    emitPlainText(proc, 'The setup guide may say: Please use the /model command before continuing.\n', 0);

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'error'),
      false,
    );
    const text = msgs.find((m) => m.type === 'text');
    assert.match(text?.content ?? '', /Please use the \/model command/);
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('does not surface user cancellation as provider error', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });
    const controller = new AbortController();

    const promise = collect(service.invoke('cancel me', { signal: controller.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'error'),
      false,
    );
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  test('user cancellation wins over agy stdout timeout text', async () => {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new GeminiAgentService({ spawnFn, adapter: 'antigravity-cli' });
    const controller = new AbortController();

    const promise = collect(service.invoke('cancel after stdout', { signal: controller.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    proc.stdout.write('Error: timed out waiting for response\n');
    controller.abort();

    const msgs = await promise;
    assert.equal(
      msgs.some((m) => m.type === 'error'),
      false,
    );
    assert.equal(msgs[msgs.length - 1].type, 'done');
  });

  // F212 Phase A (砚砚 2nd P2 — Antigravity CLI timeout collector path)
  test('F212: forwards cliDiagnostics on metadata for antigravity-cli timeout collector path', async () => {
    const service = new GeminiAgentService({
      adapter: 'antigravity-cli',
      model: 'gemini-3.5-flash',
    });

    // Inject spawnCliOverride that yields __cliTimeout with cliDiagnostics.
    // This exercises the timeoutEvent collector branch in GeminiAgentService antigravity-cli adapter,
    // not the early-return isCliTimeout branch (which 6-provider loop handles).
    const mockSpawnCli = async function* () {
      yield {
        __cliTimeout: true,
        timeoutMs: 30000,
        message: 'CLI 响应超时 (30s)',
        command: 'agy',
        silenceDurationMs: 30000,
        processAlive: true,
        cliDiagnostics: {
          reasonCode: 'network_error',
          publicSummary: '网络连接失败',
          publicHint: '检查代理 / VPN / 防火墙；provider 上游也可能短暂不可用。',
          safeExcerpt: 'ETIMEDOUT after 30s',
          debugRef: { command: 'agy', exitCode: null, signal: null, invocationId: 'agy-test-inv' },
        },
      };
    };

    const promise = collect(service.invoke('test agy timeout', { spawnCliOverride: () => mockSpawnCli() }));
    const msgs = await promise;

    const errorMsg = msgs.find((m) => m.type === 'error' && /响应超时/.test(m.error ?? ''));
    assert.ok(errorMsg, 'expected timeout error from antigravity-cli collector path');
    assert.ok(errorMsg.metadata, 'metadata must be present on timeout error');
    assert.ok(
      errorMsg.metadata.cliDiagnostics,
      `cliDiagnostics must be forwarded on metadata; got ${JSON.stringify(errorMsg.metadata)}`,
    );
    assert.equal(errorMsg.metadata.cliDiagnostics.reasonCode, 'network_error');
    assert.equal(errorMsg.metadata.cliDiagnostics.safeExcerpt, 'ETIMEDOUT after 30s');
    assert.match(errorMsg.metadata.cliDiagnostics.publicSummary, /网络/);
    assert.equal(errorMsg.metadata.cliDiagnostics.debugRef.homeMode, 'process_home');
    assert.equal(errorMsg.metadata.cliDiagnostics.debugRef.spawnCwdMode, 'cat_cafe_agy_cwd');
    assert.match(String(errorMsg.metadata.cliDiagnostics.debugRef.spawnCwdKey), /^[a-f0-9]{16}$/);
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
  test('defaults to antigravity-cli adapter', async () => {
    const previousAdapter = process.env.GEMINI_ADAPTER;
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);

    try {
      delete process.env.GEMINI_ADAPTER;
      // No adapter option and no env override -> default to antigravity-cli.
      const service = new GeminiAgentService({ spawnFn });

      const promise = collect(service.invoke('test'));
      emitPlainText(proc, 'DEFAULT_AGY_OK\n');
      const msgs = await promise;

      assert.ok(msgs.some((m) => m.type === 'text' && m.content === 'DEFAULT_AGY_OK'));

      // Verify agy CLI was spawned (not legacy gemini).
      assert.equal(spawnFn.mock.callCount(), 1);
      const call = spawnFn.mock.calls[0];
      const spawnedCommand = call.arguments[0];
      assert.ok(
        spawnedCommand === 'agy' || spawnedCommand.endsWith('/agy'),
        `Expected agy command, got: ${spawnedCommand}`,
      );
      assert.ok(call.arguments[1].includes('--print'));
      assert.equal(call.arguments[1].includes('--model'), false, 'default antigravity-cli must not pass --model');
    } finally {
      if (previousAdapter === undefined) delete process.env.GEMINI_ADAPTER;
      else process.env.GEMINI_ADAPTER = previousAdapter;
    }
  });

  test('selects gemini-cli via GEMINI_ADAPTER env override', async () => {
    const previousAdapter = process.env.GEMINI_ADAPTER;
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);

    try {
      process.env.GEMINI_ADAPTER = 'gemini-cli';
      const service = new GeminiAgentService({ spawnFn });

      const promise = collect(service.invoke('test'));
      emitGeminiEvents(proc, [{ type: 'init', session_id: 's1', model: 'auto' }]);
      await promise;

      assert.equal(spawnFn.mock.callCount(), 1);
      const call = spawnFn.mock.calls[0];
      const spawnedCommand = call.arguments[0];
      assert.ok(
        spawnedCommand === 'gemini' || spawnedCommand.endsWith('/gemini'),
        `Expected gemini command, got: ${spawnedCommand}`,
      );
      assert.ok(call.arguments[1].includes('stream-json'), 'gemini-cli fallback should keep NDJSON output');
      assert.equal(call.arguments[1].includes('--print'), false);
    } finally {
      if (previousAdapter === undefined) delete process.env.GEMINI_ADAPTER;
      else process.env.GEMINI_ADAPTER = previousAdapter;
    }
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
  // #679: Gemini stats are cumulative — flag must be set
  assert.equal(done.metadata.usage.isCumulativeUsage, true, 'Gemini stats must be flagged as cumulative');
});

test('F690 intake: injects per-turn input tokens from local Gemini jsonl', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli', model: 'gemini-2.5-pro' });
  const fakeHome = mkdtempSync(join(tmpdir(), 'gemini-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    writeGeminiJsonlSession(fakeHome, 'cat-cafe', 'gem-turn-1', [
      { type: 'user', content: 'prompt' },
      { type: 'gemini', content: 'Final answer', tokens: { input: 12345, total: 15000, output: 1000 } },
    ]);

    const promise = collect(service.invoke('stats test', { workingDirectory: '/tmp/cat-cafe' }));
    emitGeminiEvents(proc, [
      { type: 'init', session_id: 'gem-turn-1', model: 'gemini-2.5-pro' },
      { type: 'message', role: 'assistant', content: 'Final answer', delta: true },
      {
        type: 'result',
        status: 'success',
        stats: {
          total_tokens: 450000,
          input_tokens: 400000,
          output_tokens: 50000,
          context_window: 1000000,
        },
      },
    ]);

    const msgs = await promise;
    const done = msgs.find((m) => m.type === 'done');
    assert.equal(done?.metadata?.usage?.isCumulativeUsage, true);
    assert.equal(done?.metadata?.usage?.inputTokens, 400000);
    assert.equal(done?.metadata?.usage?.lastTurnInputTokens, 12345);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('F690 intake: strips whitespace added between split assistant events for jsonl token match', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli', model: 'gemini-2.5-pro' });
  const fakeHome = mkdtempSync(join(tmpdir(), 'gemini-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    writeGeminiJsonlSession(fakeHome, 'cat-cafe', 'gem-turn-2', [
      { type: 'gemini', content: '调用完成', tokens: { input: 33333, total: 35000 } },
    ]);

    const promise = collect(service.invoke('chunk test', { workingDirectory: '/tmp/cat-cafe' }));
    emitGeminiEvents(proc, [
      { type: 'init', session_id: 'gem-turn-2', model: 'gemini-2.5-pro' },
      { type: 'message', role: 'assistant', content: '调', delta: true },
      { type: 'message', role: 'assistant', content: '用完成', delta: true },
      { type: 'result', status: 'success', stats: { input_tokens: 100000, context_window: 1000000 } },
    ]);

    const msgs = await promise;
    const done = msgs.find((m) => m.type === 'done');
    assert.equal(done?.metadata?.usage?.lastTurnInputTokens, 33333);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('F690 intake: injects per-turn input tokens for tool-only Gemini turns', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli', model: 'gemini-2.5-pro' });
  const fakeHome = mkdtempSync(join(tmpdir(), 'gemini-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    writeGeminiJsonlSession(fakeHome, 'cat-cafe', 'gem-tool-1', [
      { type: 'gemini', content: '', tokens: { input: 22222, total: 24000 } },
    ]);

    const promise = collect(service.invoke('tool only', { workingDirectory: '/tmp/cat-cafe' }));
    emitGeminiEvents(proc, [
      { type: 'init', session_id: 'gem-tool-1', model: 'gemini-2.5-pro' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 'tool-1', parameters: { path: '/tmp/a' } },
      { type: 'result', status: 'success', stats: { input_tokens: 900000, context_window: 1000000 } },
    ]);

    const msgs = await promise;
    const done = msgs.find((m) => m.type === 'done');
    assert.equal(done?.metadata?.usage?.lastTurnInputTokens, 22222);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
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
    const promise = collect(service.invoke('test thinking', { workingDirectory: '/home/user/clowder-ai' }));

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
    const promise = collect(service.invoke('test mismatch', { workingDirectory: '/home/user/clowder-ai' }));

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
