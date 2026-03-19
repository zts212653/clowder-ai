/**
 * CodexAgentService Tests (CLI mode)
 * 测试缅因猫 CLI 子进程调用
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

const { CodexAgentService, isGitRepositoryPath } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
);

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

/** Write NDJSON events to mock process stdout, then end with exit 0 */
function emitCodexEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
}

// --- Test cases ---

test('yields session_init, text, and done on basic success', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('Hello'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-abc' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello from Codex!' },
    },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } },
  ]);

  const msgs = await promise;

  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[0].sessionId, 'thread-abc');
  assert.equal(msgs[0].catId, 'codex');
  assert.equal(msgs[1].type, 'text');
  assert.equal(msgs[1].content, 'Hello from Codex!');
  assert.equal(msgs[2].type, 'done');
});

test('uses exec resume when sessionId is provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn, model: 'gpt-5.3-codex' });

  const promise = collect(service.invoke('Continue', { sessionId: 'existing-thread-456' }));
  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'existing-thread-456' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Resumed' },
    },
  ]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.equal(args[0], 'exec');
  assert.equal(args[1], 'resume');
  assert.equal(args[2], 'existing-thread-456');
  assert.equal(args.at(-1), 'Continue');
  // resume 子命令不接受 --sandbox（sandbox 在创建时已锁定）
  assert.ok(!args.includes('--sandbox'), 'resume args must not include --sandbox');
  assert.ok(args.includes('--json'), 'resume args must include --json');
  const modelFlagIndex = args.indexOf('--model');
  assert.ok(modelFlagIndex >= 0, 'resume args must include --model');
  assert.equal(args[modelFlagIndex + 1], 'gpt-5.3-codex');
  assert.ok(args.includes('--config'), 'resume args must include approval policy override');
  assert.ok(args.includes('approval_policy="on-request"'), 'default approval policy should be on-request');
  assert.ok(!args.includes('approval_policy=\\"on-request\\"'), 'argv should not contain literal backslash escapes');
});

test('injects cat-cafe MCP config even when cwd is outside repo', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn, model: 'gpt-5.3-codex' });
  const cwdMock = mock.method(process, 'cwd', () => '/tmp/not-cat-cafe');

  try {
    const promise = collect(
      service.invoke('hello from outside cwd', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'your local Clowder API URL',
          CAT_CAFE_INVOCATION_ID: 'inv-test-1',
          CAT_CAFE_CALLBACK_TOKEN: 'tok-test-1',
          CAT_CAFE_USER_ID: 'user-test-1\nline2',
          CAT_CAFE_SIGNAL_USER: 'codex',
        },
      }),
    );
    emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 't-mcp-fallback' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('mcp_servers.cat-cafe.command="node"'));
    const mcpArgsConfig = args.find((arg) => arg.startsWith('mcp_servers.cat-cafe.args=['));
    assert.ok(mcpArgsConfig, 'must inject cat-cafe mcp args config');
    assert.match(mcpArgsConfig, /packages\/mcp-server\/dist\/index\.js/);
    assert.ok(args.includes('mcp_servers.cat-cafe.enabled=true'));
    assert.ok(args.includes('mcp_servers.cat-cafe.env.CAT_CAFE_API_URL="your local Clowder API URL"'));
    assert.ok(args.includes('mcp_servers.cat-cafe.env.CAT_CAFE_INVOCATION_ID="inv-test-1"'));
    assert.ok(args.includes('mcp_servers.cat-cafe.env.CAT_CAFE_CALLBACK_TOKEN="tok-test-1"'));
    assert.ok(args.includes('mcp_servers.cat-cafe.env.CAT_CAFE_USER_ID="user-test-1\\nline2"'));
    assert.ok(args.includes('mcp_servers.cat-cafe.env.CAT_CAFE_SIGNAL_USER="codex"'));
  } finally {
    cwdMock.mock.restore();
  }
});

test('does not include resume when no sessionId', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn, model: 'gpt-5.3-codex' });

  const promise = collect(service.invoke('hello'));
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 't1' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.equal(args[0], 'exec');
  assert.equal(args[1], '--json');
  assert.ok(!args.includes('resume'));
  const modelFlagIndex = args.indexOf('--model');
  assert.ok(modelFlagIndex >= 0, 'fresh exec args must include --model');
  assert.equal(args[modelFlagIndex + 1], 'gpt-5.3-codex');
  assert.ok(args.includes('--sandbox'), 'fresh exec should include sandbox mode');
  assert.ok(args.includes('danger-full-access'), 'default sandbox should allow git writes');
  assert.ok(args.includes('approval_policy="on-request"'), 'fresh exec should set default approval policy');
  assert.ok(!args.includes('approval_policy=\\"on-request\\"'), 'argv should not contain literal backslash escapes');
});

test('adds --skip-git-repo-check when workingDirectory is not a git repository', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn, model: 'gpt-5.3-codex' });
  const nonGitDir = mkdtempSync(join('/tmp', 'codex-non-git-'));

  try {
    const promise = collect(service.invoke('hello', { workingDirectory: nonGitDir }));
    emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 't-non-git' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--skip-git-repo-check'));
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test('does not add --skip-git-repo-check inside a git repository', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn, model: 'gpt-5.3-codex' });

  const promise = collect(service.invoke('hello', { workingDirectory: process.cwd() }));
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 't-git-root' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--skip-git-repo-check'));
});

test('isGitRepositoryPath walks parent directories instead of shelling out to git', () => {
  const root = mkdtempSync(join('/tmp', 'codex-git-marker-'));
  const nestedDir = join(root, 'packages', 'api');

  try {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /tmp/example\n', 'utf8');

    assert.equal(isGitRepositoryPath(nestedDir), true);
    assert.equal(isGitRepositoryPath(join('/tmp', 'codex-not-a-repo')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses env-configured sandbox and approval policy for fresh exec', async () => {
  const oldSandbox = process.env.CAT_CODEX_SANDBOX_MODE;
  const oldApproval = process.env.CAT_CODEX_APPROVAL_POLICY;
  process.env.CAT_CODEX_SANDBOX_MODE = 'read-only';
  process.env.CAT_CODEX_APPROVAL_POLICY = 'never';

  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new CodexAgentService({ spawnFn });

    const promise = collect(service.invoke('configurable'));
    emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'thread-config' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--sandbox'), 'sandbox flag should be present');
    assert.ok(args.includes('read-only'), 'sandbox should follow CAT_CODEX_SANDBOX_MODE');
    assert.ok(args.includes('--config'), 'approval policy should be set by config override');
    assert.ok(args.includes('approval_policy="never"'), 'approval policy should follow env');
  } finally {
    if (oldSandbox === undefined) {
      delete process.env.CAT_CODEX_SANDBOX_MODE;
    } else {
      process.env.CAT_CODEX_SANDBOX_MODE = oldSandbox;
    }
    if (oldApproval === undefined) {
      delete process.env.CAT_CODEX_APPROVAL_POLICY;
    } else {
      process.env.CAT_CODEX_APPROVAL_POLICY = oldApproval;
    }
  }
});

test('falls back to defaults for invalid sandbox/approval env values', async () => {
  const oldSandbox = process.env.CAT_CODEX_SANDBOX_MODE;
  const oldApproval = process.env.CAT_CODEX_APPROVAL_POLICY;
  process.env.CAT_CODEX_SANDBOX_MODE = 'not-a-mode';
  process.env.CAT_CODEX_APPROVAL_POLICY = 'not-a-policy';

  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new CodexAgentService({ spawnFn });

    const promise = collect(service.invoke('fallback'));
    emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'thread-fallback' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('danger-full-access'), 'invalid sandbox should fallback to default');
    assert.ok(args.includes('approval_policy="on-request"'), 'invalid policy should fallback to default');
  } finally {
    if (oldSandbox === undefined) {
      delete process.env.CAT_CODEX_SANDBOX_MODE;
    } else {
      process.env.CAT_CODEX_SANDBOX_MODE = oldSandbox;
    }
    if (oldApproval === undefined) {
      delete process.env.CAT_CODEX_APPROVAL_POLICY;
    } else {
      process.env.CAT_CODEX_APPROVAL_POLICY = oldApproval;
    }
  }
});

test('new session includes --add-dir .git for git write access', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('hello'));
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 't1' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const addDirIdx = args.indexOf('--add-dir');
  assert.ok(addDirIdx >= 0, 'new session args must include --add-dir');
  assert.equal(args[addDirIdx + 1], '.git', '--add-dir must be followed by .git');
  assert.ok(args.includes('--sandbox'), 'new session must still include --sandbox');
});

test('resume session does NOT include --add-dir (sandbox locked at creation)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('Continue', { sessionId: 'old-session-123' }));
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'old-session-123' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--add-dir'), 'resume args must not include --add-dir');
  assert.ok(!args.includes('--sandbox'), 'resume args must not include --sandbox');
});

test('handles multiple agent_message items', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('Multi'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-multi' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'First message' },
    },
    {
      type: 'item.completed',
      item: { id: 'msg-2', type: 'agent_message', text: 'Second message' },
    },
  ]);

  const msgs = await promise;
  const textMsgs = msgs.filter((m) => m.type === 'text');
  assert.equal(textMsgs.length, 2);
  assert.equal(textMsgs[0].content, 'First message');
  // Second turn gets \n\n prefix to preserve paragraph break between turns
  assert.equal(textMsgs[1].content, '\n\nSecond message');
});

test('separates multi-turn text with paragraph breaks (turn newline fix)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('Multi-turn'));

  // Simulate: text → tool use → text → text (3 text turns with tools in between)
  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-turns' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Checking implementation...' },
    },
    {
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'ls', status: 'in_progress' },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'file.ts',
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'msg-2', type: 'agent_message', text: 'Running verification...' },
    },
    {
      type: 'item.completed',
      item: { id: 'msg-3', type: 'agent_message', text: 'All checks passed.' },
    },
  ]);

  const msgs = await promise;
  const textMsgs = msgs.filter((m) => m.type === 'text');
  assert.equal(textMsgs.length, 3);
  assert.equal(textMsgs[0].content, 'Checking implementation...');
  assert.equal(textMsgs[1].content, '\n\nRunning verification...');
  assert.equal(textMsgs[2].content, '\n\nAll checks passed.');

  // When concatenated (as route-strategies does), should produce readable paragraphs
  const concatenated = textMsgs.map((m) => m.content).join('');
  assert.ok(concatenated.includes('Checking implementation...\n\nRunning verification...'));
  assert.ok(concatenated.includes('Running verification...\n\nAll checks passed.'));
});

test('maps command_execution and file_change items into tool events', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('With tools'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-tools' },
    {
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'ls', status: 'in_progress' },
    },
    {
      type: 'item.completed',
      item: { id: 'cmd-1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'completed' },
    },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Response' },
    },
    {
      type: 'item.completed',
      item: { id: 'file-1', type: 'file_change', changes: [], status: 'completed' },
    },
  ]);

  const msgs = await promise;
  const textMsgs = msgs.filter((m) => m.type === 'text');
  const toolUseMsgs = msgs.filter((m) => m.type === 'tool_use');
  const toolResultMsgs = msgs.filter((m) => m.type === 'tool_result');

  assert.equal(textMsgs.length, 1);
  assert.equal(textMsgs[0].content, 'Response');
  assert.equal(toolUseMsgs.length, 2);
  assert.equal(toolResultMsgs.length, 1);
  assert.equal(toolUseMsgs[0].toolName, 'command_execution');
  assert.equal(toolUseMsgs[1].toolName, 'file_change');
  assert.match(toolResultMsgs[0].content, /command: ls/);
});

test('yields error on CLI non-zero exit', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('crash'));

  proc.stderr.write('Error: authentication failed\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  // Error message is sanitized — contains exit code but not raw stderr
  assert.ok(errMsg.error.includes('code: 1'));
  // Raw stderr should NOT be exposed to users
  assert.ok(!errMsg.error.includes('authentication failed'), 'stderr should be sanitized');
});

test('includes reconnect diagnostics in CLI exit error when available', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('reconnect failure'));

  proc.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-reconnect' })}\n`);
  proc.stdout.write(
    `${JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 1/5 (stream disconnected before completion)',
    })}\n`,
  );
  proc.stdout.write(
    `${JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 2/5 (stream disconnected before completion)',
    })}\n`,
  );
  proc.stdout.write(
    `${JSON.stringify({
      type: 'error',
      message: 'stream disconnected before completion',
    })}\n`,
  );
  proc.stdout.end();
  // Exit code 2 = always a real failure (code 1 is suppressed only with substantive output)
  proc._emitter.emit('exit', 2, null);

  const msgs = await promise;
  const sysInfos = msgs.filter((m) => m.type === 'system_info');
  assert.equal(sysInfos.length, 2, 'should stream reconnect status to UI in real time');
  assert.ok(sysInfos[0].content.includes('Reconnecting... 1/5'));
  assert.ok(sysInfos[1].content.includes('Reconnecting... 2/5'));

  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.ok(errMsg.error.includes('code: 2'));
  assert.ok(errMsg.error.includes('Reconnecting... 1/5'), 'error should include reconnect diagnostics');
  assert.ok(errMsg.error.includes('Reconnecting... 2/5'), 'error should include multiple reconnect attempts');
});

test('suppresses exit code 1 when Codex produced substantive output (item.completed)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args.join(' '));

  const promise = collect(service.invoke('review this'));

  // Codex outputs thread.started + item.completed (agent_message) = substantive output
  proc.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'tx' })}\n`);
  proc.stdout.write(
    `${JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Looks good!' },
    })}\n`,
  );
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null); // Codex 0.98+ quirk

  const msgs = await promise;
  const errors = msgs.filter((m) => m.type === 'error');
  assert.equal(errors.length, 0, 'exit code 1 with substantive output should be suppressed');
  assert.ok(
    msgs.some((m) => m.type === 'text'),
    'text message should still be yielded',
  );
  assert.ok(
    msgs.some((m) => m.type === 'done'),
    'done should still be yielded',
  );
  assert.ok(
    warnCalls.some((w) => w.includes('Codex CLI exited with code 1')),
    'should warn',
  );

  console.warn = originalWarn;
});

test('does NOT suppress exit code 1 when only thread.started (no substantive output)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('review this'));

  // Only thread.started — no item.completed → NOT substantive
  proc.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'tx' })}\n`);
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const msgs = await promise;
  const errors = msgs.filter((m) => m.type === 'error');
  assert.equal(errors.length, 1, 'exit code 1 without substantive output should yield error');
  assert.ok(errors[0].error.includes('code: 1'));
});

test('yields error on spawn ENOENT', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('hi'));

  process.nextTick(() => {
    const err = new Error('spawn codex ENOENT');
    err.code = 'ENOENT';
    proc._emitter.emit('error', err);
    proc.stdout.end();
    proc._emitter.emit('exit', null, null);
  });

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.ok(errMsg.error.includes('ENOENT'));
});

test('passes cwd from workingDirectory option', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('hi', { workingDirectory: '/my/project' }));
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 't1' }]);
  await promise;

  const spawnOpts = spawnFn.mock.calls[0].arguments[2];
  assert.equal(spawnOpts.cwd, '/my/project');
});

test('oauth mode (default) does not forward OPENAI_API_KEY to codex child env', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalAuthMode = process.env.CODEX_AUTH_MODE;
  try {
    process.env.OPENAI_API_KEY = 'sk-test-forwarded-key';
    delete process.env.CODEX_AUTH_MODE; // default = oauth

    const promise = collect(service.invoke('oauth test'));
    emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'oauth-thread' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.OPENAI_API_KEY, undefined);
    assert.equal(Object.hasOwn(spawnOpts.env, 'OPENAI_API_KEY'), false);
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalAuthMode === undefined) delete process.env.CODEX_AUTH_MODE;
    else process.env.CODEX_AUTH_MODE = originalAuthMode;
  }
});

test('api_key mode keeps OPENAI_API_KEY for codex child env', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalAuthMode = process.env.CODEX_AUTH_MODE;
  try {
    process.env.OPENAI_API_KEY = 'sk-test-api-mode';
    process.env.CODEX_AUTH_MODE = 'api_key';

    const promise = collect(service.invoke('api-key test'));
    emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'api-key-thread' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.OPENAI_API_KEY, 'sk-test-api-mode');
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalAuthMode === undefined) delete process.env.CODEX_AUTH_MODE;
    else process.env.CODEX_AUTH_MODE = originalAuthMode;
  }
});

test('all messages have catId codex', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('check'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-catid' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Test' },
    },
  ]);

  const msgs = await promise;
  for (const msg of msgs) {
    assert.equal(msg.catId, 'codex', `expected catId codex for ${msg.type} message`);
  }
});

test('ignores turn.started and turn.completed control events', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('test'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-ctrl' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'msg-1', type: 'agent_message' } },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
    },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 10 } },
    { type: 'unknown_event', data: 'something' },
  ]);

  const msgs = await promise;
  // Only session_init, text, done — all control/unknown events skipped
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[1].type, 'text');
  assert.equal(msgs[1].content, 'Hello');
  assert.equal(msgs[2].type, 'done');
});

test('maps command execution lifecycle into tool_use and tool_result', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('run tool'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-tool-lifecycle' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/home/user/projects/cat-cafe\n',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'done' },
    },
  ]);

  const msgs = await promise;
  const toolUse = msgs.find((m) => m.type === 'tool_use');
  const toolResult = msgs.find((m) => m.type === 'tool_result');

  assert.ok(toolUse, 'should emit tool_use for command_execution start');
  assert.equal(toolUse.toolName, 'command_execution');
  assert.equal(toolUse.toolInput.command, '/bin/zsh -lc pwd');

  assert.ok(toolResult, 'should emit tool_result for command_execution completion');
  assert.match(toolResult.content, /\/home\/user\/projects\/cat-cafe/);
  assert.match(toolResult.content, /exit_code:\s*0/);
});

test('writes CLI tool lifecycle audit events when auditContext is provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const auditLog = { append: mock.fn(async () => ({ id: 'evt-1' })) };
  const rawArchive = { append: mock.fn(async () => {}) };
  const service = new CodexAgentService({ spawnFn, auditLog, rawArchive });

  const promise = collect(
    service.invoke('run tool', {
      auditContext: {
        invocationId: 'inv-1',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'codex',
      },
    }),
  );

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/tmp\n',
        exit_code: 0,
        status: 'completed',
      },
    },
  ]);

  await promise;

  assert.equal(auditLog.append.mock.callCount(), 2);
  const started = auditLog.append.mock.calls[0].arguments[0];
  const completed = auditLog.append.mock.calls[1].arguments[0];

  assert.equal(started.type, 'cli_tool_started');
  assert.equal(started.threadId, 'thread-1');
  assert.equal(started.data.invocationId, 'inv-1');
  assert.equal(started.data.command, '/bin/zsh -lc pwd');

  assert.equal(completed.type, 'cli_tool_completed');
  assert.equal(completed.threadId, 'thread-1');
  assert.equal(completed.data.status, 'completed');
  assert.equal(completed.data.exitCode, 0);
});

test('archives raw stream events when auditContext is provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const auditLog = { append: mock.fn(async () => ({ id: 'evt-1' })) };
  const rawArchive = { append: mock.fn(async () => {}) };
  const service = new CodexAgentService({ spawnFn, auditLog, rawArchive });

  const promise = collect(
    service.invoke('raw trace', {
      auditContext: {
        invocationId: 'inv-raw-1',
        threadId: 'thread-raw-1',
        userId: 'user-1',
        catId: 'codex',
      },
    }),
  );

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-raw-1' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'hello' },
    },
  ]);

  await promise;

  assert.equal(rawArchive.append.mock.callCount(), 2);
  assert.equal(rawArchive.append.mock.calls[0].arguments[0], 'inv-raw-1');
  assert.equal(rawArchive.append.mock.calls[1].arguments[0], 'inv-raw-1');
});

test('does not write lifecycle audit or raw archive when auditContext is absent', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const auditLog = { append: mock.fn(async () => ({ id: 'evt-1' })) };
  const rawArchive = { append: mock.fn(async () => {}) };
  const service = new CodexAgentService({ spawnFn, auditLog, rawArchive });

  const promise = collect(service.invoke('no audit context'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-no-audit' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/tmp\n',
        exit_code: 0,
        status: 'completed',
      },
    },
  ]);

  await promise;

  assert.equal(auditLog.append.mock.callCount(), 0);
  assert.equal(rawArchive.append.mock.callCount(), 0);
});

test('redacts nested callback tokens before archiving raw events', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const auditLog = { append: mock.fn(async () => ({ id: 'evt-1' })) };
  const rawArchive = { append: mock.fn(async () => {}) };
  const service = new CodexAgentService({ spawnFn, auditLog, rawArchive });

  const promise = collect(
    service.invoke('deep redact', {
      auditContext: {
        invocationId: 'inv-redact-1',
        threadId: 'thread-redact-1',
        userId: 'user-1',
        catId: 'codex',
      },
    }),
  );

  emitCodexEvents(proc, [
    {
      type: 'item.completed',
      callbackToken: 'root-secret',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'hello',
        callbackEnv: {
          CAT_CAFE_CALLBACK_TOKEN: 'nested-secret',
        },
        nested: {
          callbackToken: 'deep-secret',
        },
      },
    },
  ]);

  await promise;

  assert.equal(rawArchive.append.mock.callCount(), 1);
  const archived = rawArchive.append.mock.calls[0].arguments[1];
  assert.equal(archived.callbackToken, '[redacted]');
  assert.equal(archived.item.callbackEnv.CAT_CAFE_CALLBACK_TOKEN, '[redacted]');
  assert.equal(archived.item.nested.callbackToken, '[redacted]');
});

// --- P1 regression: systemPrompt + image coexistence ---

test('systemPrompt is preserved and codex --image is used when contentBlocks contain images', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(
    service.invoke('describe this image', {
      systemPrompt: '你是缅因猫，由 OpenAI 提供的 AI 猫猫。',
      contentBlocks: [{ type: 'image', url: '/uploads/cat.png' }],
      uploadDir: '/tmp',
    }),
  );
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'img-thread' }]);
  await promise;

  // The prompt passed to CLI must preserve systemPrompt.
  // Images should be passed via native --image flags.
  const args = spawnFn.mock.calls[0].arguments[1];
  const imageIdx = args.indexOf('--image');
  assert.ok(imageIdx >= 0, 'codex should receive image via --image');
  assert.ok(String(args[imageIdx + 1]).includes('cat.png'));
  const promptArg = args.at(-1); // last arg is the prompt
  assert.ok(
    promptArg.includes('缅因猫'),
    `systemPrompt should be preserved in prompt when images present, got: ${promptArg.slice(0, 120)}`,
  );
});

test('fresh exec with --image inserts "--" before prompt to avoid varargs swallowing prompt', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(
    service.invoke('please describe this image path handling', {
      contentBlocks: [{ type: 'image', url: '/uploads/cat.png' }],
      uploadDir: '/tmp',
    }),
  );
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'img-thread-arg-sep' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const imageIdx = args.indexOf('--image');
  assert.ok(imageIdx >= 0, 'codex should receive --image');
  const promptIdx = args.indexOf('please describe this image path handling');
  assert.ok(promptIdx >= 0, 'prompt should be present');
  assert.equal(args[promptIdx - 1], '--', 'prompt must be preceded by "--" separator');
});

test('resume exec with --image inserts "--" before prompt', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(
    service.invoke('resume image argument handling', {
      sessionId: 'existing-thread-456',
      contentBlocks: [{ type: 'image', url: '/uploads/cat.png' }],
      uploadDir: '/tmp',
    }),
  );
  emitCodexEvents(proc, [{ type: 'thread.started', thread_id: 'existing-thread-456' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.equal(args[0], 'exec');
  assert.equal(args[1], 'resume');
  assert.equal(args[2], 'existing-thread-456');
  const imageIdx = args.indexOf('--image');
  assert.ok(imageIdx >= 0, 'resume path should receive --image');
  const promptIdx = args.indexOf('resume image argument handling');
  assert.ok(promptIdx >= 0, 'prompt should be present');
  assert.equal(args[promptIdx - 1], '--', 'resume prompt must be preceded by "--" separator');
});

test('F8: turn.completed usage is captured into done metadata', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const promise = collect(service.invoke('test'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-usage' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 500, output_tokens: 200, cached_input_tokens: 100 },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'should have done message');
  assert.ok(done.metadata?.usage, 'done should have usage in metadata');
  assert.equal(done.metadata.usage.inputTokens, 500);
  assert.equal(done.metadata.usage.outputTokens, 200);
  assert.equal(done.metadata.usage.cacheReadTokens, 100);
});

test('F24: enriches Codex context snapshot from resolver into done metadata', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const contextSnapshotResolver = mock.fn(async () => ({
    contextUsedTokens: 186_749,
    contextWindowTokens: 258_400,
    contextResetsAtMs: Date.UTC(2026, 1, 18, 0, 0, 0),
  }));
  const service = new CodexAgentService({ spawnFn, contextSnapshotResolver });

  const promise = collect(service.invoke('test context telemetry'));

  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-context' },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 529593, output_tokens: 10298, cached_input_tokens: 405760 },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'should have done message');
  assert.ok(done.metadata?.usage, 'done should have usage metadata');
  assert.equal(contextSnapshotResolver.mock.callCount(), 1, 'resolver should be called once');
  assert.equal(contextSnapshotResolver.mock.calls[0].arguments[0], 'thread-context');
  assert.equal(done.metadata.usage.contextUsedTokens, 186_749);
  assert.equal(done.metadata.usage.contextWindowSize, 258_400);
  assert.equal(done.metadata.usage.contextResetsAtMs, Date.UTC(2026, 1, 18, 0, 0, 0));
  assert.equal(done.metadata.usage.lastTurnInputTokens, 186_749);
});

test('Issue #116: turn.completed unblocks done even when process exit is delayed', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 12345,
    exitCode: null,
    kill: mock.fn(() => true),
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
  const spawnFn = createMockSpawnFn(proc);
  const service = new CodexAgentService({ spawnFn });

  const startMs = Date.now();
  const promise = collect(service.invoke('test'));

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-116' }) + '\n');
  proc.stdout.write(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Done!' },
    }) + '\n',
  );
  proc.stdout.write(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50 },
    }) + '\n',
  );
  proc.stdout.end();

  // Process exits naturally during grace period (simulating delayed but normal exit)
  setTimeout(() => emitter.emit('exit', 0, null), 300);

  const msgs = await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(elapsedMs < 2000, `Should complete quickly once process exits during grace, took ${elapsedMs}ms`);

  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'should have done message');
  assert.equal(done.metadata?.usage?.inputTokens, 100);
  assert.equal(done.metadata?.usage?.outputTokens, 50);
});
