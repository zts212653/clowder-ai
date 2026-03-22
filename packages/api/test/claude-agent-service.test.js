/**
 * ClaudeAgentService Tests (CLI mode)
 * 测试布偶猫 CLI 子进程调用
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

const { ClaudeAgentService, pickGitBashPathFromWhere, resolveDefaultClaudeMcpServerPath } = await import(
  '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
);

ensureFakeCliOnPath('claude');

/** Helper: collect all items from async iterable */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Create a mock child process for testing.
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

/** Create a mock SpawnFn */
function createMockSpawnFn(proc) {
  return mock.fn(() => proc);
}

function emitProcessExit(proc, code, signal = null) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, signal);
  });
}

/** Write NDJSON events to mock process stdout, then end with exit 0 */
function emitClaudeEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, 0, null);
  });
  proc.stdout.end();
}

// --- Test cases ---

test('F166: non-JSON CLI output is yielded as text instead of being silently discarded', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Hello'));

  // Write a mix of valid NDJSON and plain text (non-JSON) lines
  proc.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-166' })}\n`);
  proc.stdout.write('This is plain text output from the CLI\n');
  proc.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-166' })}\n`);
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, 0, null);
  });
  proc.stdout.end();

  const msgs = await promise;

  // Should contain: session_init, text (from non-JSON line), done
  const textMsgs = msgs.filter((m) => m.type === 'text');
  assert.equal(textMsgs.length, 1, 'non-JSON line should be yielded as a text message');
  assert.equal(textMsgs[0].content, 'This is plain text output from the CLI');
  assert.ok(textMsgs[0].catId, 'text message should have catId');
  assert.ok(textMsgs[0].timestamp, 'text message should have timestamp');

  // done should still be yielded
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'done message should still be yielded');
});

test('yields session_init, text, and done on basic success', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Hello'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sess-abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-abc' },
  ]);

  const msgs = await promise;

  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[0].sessionId, 'sess-abc');
  assert.equal(msgs[1].type, 'text');
  assert.equal(msgs[1].content, 'Hi!');
  assert.equal(msgs[2].type, 'done');
});

test('handles tool_use content blocks', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('read file'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/foo.ts' },
          },
        ],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;

  const toolMsg = msgs.find((m) => m.type === 'tool_use');
  assert.ok(toolMsg);
  assert.equal(toolMsg.toolName, 'Read');
  assert.deepEqual(toolMsg.toolInput, { file_path: '/foo.ts' });
});

test('handles mixed text and tool_use in single assistant message', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('do stuff'));

  emitClaudeEvents(proc, [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'text', text: 'Done reading.' },
        ],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  // 3 content messages + 1 done
  const contentMsgs = msgs.filter((m) => m.type !== 'done');
  assert.equal(contentMsgs.length, 3);
  assert.equal(contentMsgs[0].type, 'text');
  assert.equal(contentMsgs[0].content, 'Let me read that.');
  assert.equal(contentMsgs[1].type, 'tool_use');
  assert.equal(contentMsgs[1].toolName, 'Read');
  assert.equal(contentMsgs[2].type, 'text');
  assert.equal(contentMsgs[2].content, 'Done reading.');
});

test('passes --resume flag when sessionId is provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('continue', { sessionId: 'resume-123' }));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('resume-123'));
});

test('does not include --resume when no sessionId', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hello'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--resume'));
});

test('passes cwd from workingDirectory option', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hi', { workingDirectory: '/my/project' }));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const spawnOpts = spawnFn.mock.calls[0].arguments[2];
  assert.equal(spawnOpts.cwd, '/my/project');
});

test('preserves inherited Anthropic credentials when no profile mode override is supplied', async () => {
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-inherited';
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-keep',
          CAT_CAFE_CALLBACK_TOKEN: 'token-keep',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, 'sk-inherited');
    assert.equal(spawnOpts.env.ANTHROPIC_BASE_URL, 'https://inherited.example.com');
  } finally {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  }
});

test('F062: subscription profile clears inherited ANTHROPIC env vars', async () => {
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-inherited';
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-1',
          CAT_CAFE_CALLBACK_TOKEN: 'token-1',
          CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spawnOpts.env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  }
});

test('F062: api_key profile injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL', async () => {
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-inherited';
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-2',
          CAT_CAFE_CALLBACK_TOKEN: 'token-2',
          CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
          CAT_CAFE_ANTHROPIC_API_KEY: 'sk-sponsor',
          CAT_CAFE_ANTHROPIC_BASE_URL: 'https://sponsor.example.com',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, 'sk-sponsor');
    assert.equal(spawnOpts.env.ANTHROPIC_BASE_URL, 'https://sponsor.example.com');
  } finally {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  }
});

test('pickGitBashPathFromWhere accepts nonstandard bash.exe locations returned by where', () => {
  const whereOutput = [
    'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].join('\r\n');

  const resolved = pickGitBashPathFromWhere(
    whereOutput,
    (candidate) => candidate === 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  );

  assert.equal(resolved, 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe');
});

test('pickGitBashPathFromWhere skips System32 bash.exe when a Git Bash candidate exists later in PATH', () => {
  const whereOutput = [
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  ].join('\r\n');

  const resolved = pickGitBashPathFromWhere(
    whereOutput,
    (candidate) =>
      candidate === 'C:\\Windows\\System32\\bash.exe' ||
      candidate === 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  );

  assert.equal(resolved, 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe');
});

test('yields error on result/error event', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('bad'));

  emitClaudeEvents(proc, [{ type: 'result', subtype: 'error', errors: ['rate limited', 'try again'] }]);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.equal(errMsg.error, 'rate limited; try again');
});

test('yields error on CLI non-zero exit', async () => {
  const proc = createMockProcess();
  // Override kill to not auto-exit (we control exit manually)
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('crash'));

  proc.stderr.write('Error: authentication failed\n');
  proc.stdout.end();
  emitProcessExit(proc, 1, null);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  // Error message is sanitized — contains exit code but not raw stderr
  assert.ok(errMsg.error.includes('code: 1'));
  // Raw stderr should NOT be exposed to users (no more 'authentication failed')
  assert.ok(!errMsg.error.includes('authentication failed'), 'stderr should be sanitized');
});

test('yields actionable rescue hint on invalid thinking signature resume failure', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('resume me', { sessionId: 'sess-bad-thinking' }));

  proc.stderr.write(
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}\n',
  );
  proc.stdout.end();
  emitProcessExit(proc, 1, null);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.ok(errMsg.error.includes('thinking signature'));
  assert.ok(errMsg.error.includes('pnpm rescue:claude:thinking'));
  assert.ok(errMsg.error.includes('sess-bad-thinking'));
  assert.ok(!errMsg.error.includes('messages.1.content.0'));
});

test('does not duplicate error when result/error is followed by non-zero exit', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('bad'));

  proc.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['rate limited'],
    })}\n`,
  );
  proc.stderr.write('rate limited\n');
  proc.stdout.end();
  emitProcessExit(proc, 1, null);

  const msgs = await promise;
  const errors = msgs.filter((m) => m.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'rate limited');
});

test('includes exit signal in CLI error message when no exit code (stderr sanitized)', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('crash'));

  proc.stderr.write('killed by supervisor\n');
  proc.stdout.end();
  emitProcessExit(proc, null, 'SIGKILL');

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  // Sanitized message includes signal info
  assert.ok(errMsg.error.includes('SIGKILL'));
  // Raw stderr should NOT be exposed to users
  assert.ok(!errMsg.error.includes('killed by supervisor'), 'stderr should be sanitized');
});

test('yields error on spawn ENOENT', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hi'));

  process.nextTick(() => {
    const err = new Error('spawn claude ENOENT');
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

test('ignores system/hook and unknown event types', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('test'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'hook', hookId: 'h1' },
    { type: 'system', subtype: 'init', session_id: 'sid' },
    { type: 'unknown_type', data: 'something' },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  // Only session_init + done (hook and unknown skipped)
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[1].type, 'done');
});

test('all messages have catId opus', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('check'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  for (const msg of msgs) {
    assert.equal(msg.catId, 'opus', `expected catId opus, got ${msg.catId}`);
  }
});

test('passes correct model flag (default and custom)', async () => {
  // Default model
  const proc1 = createMockProcess();
  const spawnFn1 = createMockSpawnFn(proc1);
  const service1 = new ClaudeAgentService({ spawnFn: spawnFn1 });

  const p1 = collect(service1.invoke('hi'));
  emitClaudeEvents(proc1, [{ type: 'result', subtype: 'success' }]);
  await p1;

  const args1 = spawnFn1.mock.calls[0].arguments[1];
  const modelIdx1 = args1.indexOf('--model');
  assert.ok(modelIdx1 >= 0);
  // F32-b: getCatModel('opus') resolves via catRegistry > CAT_CONFIGS fallback.
  // In test context catRegistry is empty, so this is CAT_CONFIGS['opus'].defaultModel.
  assert.equal(args1[modelIdx1 + 1], 'claude-sonnet-4-5-20250929');

  // Custom model (explicit constructor param)
  const proc2 = createMockProcess();
  const spawnFn2 = createMockSpawnFn(proc2);
  const service2 = new ClaudeAgentService({ spawnFn: spawnFn2, model: 'haiku' });

  const p2 = collect(service2.invoke('hi'));
  emitClaudeEvents(proc2, [{ type: 'result', subtype: 'success' }]);
  await p2;

  const args2 = spawnFn2.mock.calls[0].arguments[1];
  const modelIdx2 = args2.indexOf('--model');
  assert.equal(args2[modelIdx2 + 1], 'haiku');
});

test('F32-b P1 regression: env var CAT_*_MODEL overrides default when model not passed', async () => {
  // Simulate index.ts pattern: pass catId but NOT model → constructor resolves via getCatModel()
  // getCatModel() should respect env var > catRegistry > CAT_CONFIGS fallback
  const saved = process.env.CAT_OPUS_MODEL;
  process.env.CAT_OPUS_MODEL = 'env-override-model';
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    // NOTE: explicit catId, no `model` param — matches the fixed index.ts pattern
    const service = new ClaudeAgentService({ catId: 'opus', spawnFn });

    const p = collect(service.invoke('hi'));
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await p;

    const args = spawnFn.mock.calls[0].arguments[1];
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0, '--model flag should be present');
    assert.equal(
      args[modelIdx + 1],
      'env-override-model',
      'CAT_OPUS_MODEL env var should take priority over config default',
    );
  } finally {
    if (saved === undefined) delete process.env.CAT_OPUS_MODEL;
    else process.env.CAT_OPUS_MODEL = saved;
  }
});

test('passes --include-partial-messages flag for incremental stream-json output', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('stream please'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(args.includes('--include-partial-messages'));
});

test('streams text deltas from stream_event without duplicating final assistant payload', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('delta test'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sid' },
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg-1' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world' },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  const texts = msgs.filter((m) => m.type === 'text').map((m) => m.content);
  assert.deepEqual(texts, ['Hello ', 'world']);
});

test('does not pass --allowedTools — all tools available by default', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hi'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--allowedTools'), 'must NOT pass --allowedTools so all tools are available');
});

test('resolves default MCP server path from API cwd (../mcp-server/dist/index.js)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-'));
  const apiCwd = join(root, 'packages', 'api');
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(apiCwd, { recursive: true });
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(apiCwd);
    assert.equal(resolved, join(mcpDistDir, 'index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves default MCP server path from repo root (packages/mcp-server/dist/index.js)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-root-'));
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(root);
    assert.equal(resolved, join(mcpDistDir, 'index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves default MCP server path from deep tooling cwd (../../packages/mcp-server/dist/index.js)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-deep-'));
  const deepCwd = join(root, 'tools', 'runner');
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(deepCwd, { recursive: true });
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(deepCwd);
    assert.equal(resolved, join(mcpDistDir, 'index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns undefined when no default MCP server candidate exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-missing-'));
  const apiCwd = join(root, 'packages', 'api');
  mkdirSync(apiCwd, { recursive: true });

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(apiCwd);
    assert.equal(resolved, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to default MCP path when CAT_CAFE_MCP_SERVER_PATH is empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-empty-env-'));
  const apiCwd = join(root, 'packages', 'api');
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(apiCwd, { recursive: true });
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  const previousCwd = process.cwd();
  const previousEnv = process.env.CAT_CAFE_MCP_SERVER_PATH;
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  try {
    process.chdir(apiCwd);
    process.env.CAT_CAFE_MCP_SERVER_PATH = '';

    const service = new ClaudeAgentService({ spawnFn });
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-1',
          CAT_CAFE_CALLBACK_TOKEN: 'token-1',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpConfigIdx = args.indexOf('--mcp-config');
    assert.ok(mcpConfigIdx >= 0, '--mcp-config should be present when fallback resolves');
    const parsed = JSON.parse(args[mcpConfigIdx + 1]);
    assert.equal(realpathSync(parsed.mcpServers['cat-cafe'].args[0]), realpathSync(join(mcpDistDir, 'index.js')));
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) {
      delete process.env.CAT_CAFE_MCP_SERVER_PATH;
    } else {
      process.env.CAT_CAFE_MCP_SERVER_PATH = previousEnv;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('F8: result/success extracts usage into done metadata', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Hello'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sess-usage' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-usage',
      usage: { input_tokens: 1234, output_tokens: 567 },
      total_cost_usd: 0.05,
      duration_ms: 3000,
      duration_api_ms: 2500,
      num_turns: 3,
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'should have done message');
  assert.ok(done.metadata?.usage, 'done should have usage in metadata');
  assert.equal(done.metadata.usage.inputTokens, 1234);
  assert.equal(done.metadata.usage.outputTokens, 567);
  assert.equal(done.metadata.usage.costUsd, 0.05);
  assert.equal(done.metadata.usage.durationMs, 3000);
  assert.equal(done.metadata.usage.numTurns, 3);
});

test('F24: extracts contextWindowSize from result.modelUsage (camelCase)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Context window test'));

  emitClaudeEvents(proc, [
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 2000, output_tokens: 300 },
      modelUsage: {
        'claude-opus-4-6': {
          contextWindow: 200000,
        },
      },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  assert.equal(
    done.metadata.usage.contextWindowSize,
    200000,
    'should read contextWindow from modelUsage camelCase payload',
  );
});

test('F24: extracts contextWindowSize from result.model_usage (snake_case)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('snake case test'));

  emitClaudeEvents(proc, [
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1000, output_tokens: 100 },
      model_usage: {
        'claude-opus-4-6': {
          context_window: 200000,
        },
      },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  assert.equal(done.metadata.usage.contextWindowSize, 200000);
});

test('F8: normalises inputTokens to include cache tokens (Claude API → total)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('cache test'));

  emitClaudeEvents(proc, [
    {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 4,
        output_tokens: 263,
        cache_read_input_tokens: 95000,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.17,
      num_turns: 2,
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // inputTokens = 4 (new) + 95000 (cache read) + 0 (cache create) = 95004
  assert.equal(done.metadata.usage.inputTokens, 95004);
  assert.equal(done.metadata.usage.outputTokens, 263);
  assert.equal(done.metadata.usage.cacheReadTokens, 95000);
  assert.equal(done.metadata.usage.costUsd, 0.17);
  assert.equal(done.metadata.usage.numTurns, 2);
  // cacheCreationTokens should be absent (was 0)
  assert.equal(done.metadata.usage.cacheCreationTokens, undefined);
});

test('F24-fix: lastTurnInputTokens extracted from last message_start usage', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('multi-turn'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sid-ctx' },
    // Turn 1: message_start with usage
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-1',
          usage: { input_tokens: 10000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Turn 1' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Turn 2: message_start with larger context (last turn — this is the one we want)
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-2',
          usage: { input_tokens: 5000, cache_read_input_tokens: 35000, cache_creation_input_tokens: 4000 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Turn 2' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Assistant final + result
    { type: 'assistant', message: { id: 'msg-2', content: [{ type: 'text', text: 'Turn 2' }] } },
    {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 15000, // aggregated across turns (raw new tokens)
        output_tokens: 500,
        cache_read_input_tokens: 55000, // aggregated
        cache_creation_input_tokens: 4000,
      },
      num_turns: 2,
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // lastTurnInputTokens = last message_start: 5000 + 35000 + 4000 = 44000
  assert.equal(
    done.metadata.usage.lastTurnInputTokens,
    44000,
    'lastTurnInputTokens should be sum of last message_start usage (raw + cache_read + cache_create)',
  );
  // inputTokens is still the aggregated value: 15000 + 55000 + 4000 = 74000
  assert.equal(done.metadata.usage.inputTokens, 74000, 'inputTokens should still be the aggregated total');
});

test('F24-fix: lastTurnInputTokens is undefined when no message_start has usage', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('no-stream'));

  emitClaudeEvents(proc, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // No stream events → no lastTurnInputTokens
  assert.equal(
    done.metadata.usage.lastTurnInputTokens,
    undefined,
    'lastTurnInputTokens should be undefined when no message_start has usage',
  );
  // Aggregated inputTokens still works
  assert.equal(done.metadata.usage.inputTokens, 1000);
});

test('F24-fix: lastTurnInputTokens resets when final message_start has no usage (no stale carryover)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new ClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('stale-test'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sid-stale' },
    // Turn 1: message_start WITH usage (sets lastTurnInputTokens = 3000)
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-stale-1',
          usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'T1' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Turn 2: message_start WITHOUT usage (should clear, not carry over 3000)
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg-stale-2' },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'T2' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Final
    { type: 'assistant', message: { id: 'msg-stale-2', content: [{ type: 'text', text: 'T2' }] } },
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 2000, output_tokens: 300 },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // The final message_start had no usage → lastTurnInputTokens must be undefined, NOT 3000
  assert.equal(
    done.metadata.usage.lastTurnInputTokens,
    undefined,
    'lastTurnInputTokens must not carry over from a previous turn when the final turn lacks usage',
  );
});
