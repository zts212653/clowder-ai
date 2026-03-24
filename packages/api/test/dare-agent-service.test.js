import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import {
  DareAgentService,
  resolveVendorDarePath,
  resolveVenvPython,
} from '../dist/domains/cats/services/agents/providers/DareAgentService.js';

// ── Mock helpers (same pattern as codex-agent-service.test.js) ──

function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 54321,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
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

function emitDareEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', 0, null));
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

// ── DARE headless envelope fixtures ──

const SESSION_STARTED = {
  schema_version: 'client-headless-event-envelope.v1',
  ts: 1709500000.0,
  session_id: 'dare-sess-1',
  run_id: 'run-1',
  seq: 1,
  event: 'session.started',
  data: { mode: 'chat', entrypoint: 'run' },
};
const TOOL_INVOKE = {
  schema_version: 'client-headless-event-envelope.v1',
  ts: 1709500001.0,
  session_id: 'dare-sess-1',
  run_id: 'run-1',
  seq: 2,
  event: 'tool.invoke',
  data: { tool_name: 'read_file', tool_call_id: 'tc-1' },
};
const TOOL_RESULT = {
  schema_version: 'client-headless-event-envelope.v1',
  ts: 1709500002.0,
  session_id: 'dare-sess-1',
  run_id: 'run-1',
  seq: 3,
  event: 'tool.result',
  data: { tool_name: 'read_file', tool_call_id: 'tc-1', success: true },
};
const TASK_COMPLETED = {
  schema_version: 'client-headless-event-envelope.v1',
  ts: 1709500003.0,
  session_id: 'dare-sess-1',
  run_id: 'run-1',
  seq: 4,
  event: 'task.completed',
  data: { task: 'say hello', rendered_output: 'Hello from DARE!' },
};
const TASK_FAILED = {
  schema_version: 'client-headless-event-envelope.v1',
  ts: 1709500003.0,
  session_id: 'dare-sess-1',
  run_id: 'run-1',
  seq: 4,
  event: 'task.failed',
  data: { task: 'do thing', error: 'Approval timed out' },
};

describe('DareAgentService', () => {
  test('yields session_init, text, done from headless events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Say hello'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('session_init'), `expected session_init, got: ${types}`);
    assert.ok(types.includes('text'), `expected text, got: ${types}`);
    assert.ok(types.includes('done'), `expected done, got: ${types}`);

    const textMsg = messages.find((m) => m.type === 'text');
    assert.strictEqual(textMsg.content, 'Hello from DARE!');
    assert.strictEqual(textMsg.catId, 'dare');
  });

  test('yields tool_use and tool_result for tool events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Use tools'));
    emitDareEvents(proc, [SESSION_STARTED, TOOL_INVOKE, TOOL_RESULT, TASK_COMPLETED]);
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('tool_use'));
    assert.ok(types.includes('tool_result'));
  });

  test('passes --headless and --full-auto in CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test prompt'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const call = spawnFn.mock.calls[0];
    const args = call.arguments[1];
    assert.ok(args.includes('--headless'), `expected --headless in args: ${args}`);
    assert.ok(args.includes('--full-auto'), `expected --full-auto in args: ${args}`);
    assert.ok(!args.includes('--auto-approve'), `--auto-approve should be replaced by --full-auto: ${args}`);
    assert.ok(!args.includes('--auto-approve-tool'), `--auto-approve-tool no longer needed with --full-auto: ${args}`);
    assert.ok(args.includes('-m') && args.includes('client'), `expected -m client in args: ${args}`);
  });

  test('passes --adapter and --model', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      adapter: 'openrouter',
      model: 'zhipu/glm-4.7',
    });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const adapterIdx = args.indexOf('--adapter');
    assert.ok(adapterIdx >= 0);
    assert.strictEqual(args[adapterIdx + 1], 'openrouter');
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0);
    assert.strictEqual(args[modelIdx + 1], 'zhipu/glm-4.7');
  });

  // P1-1: cwd must ALWAYS be darePath, workingDirectory goes to --workspace
  test('cwd is always darePath, not workingDirectory (P1-1)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      darePath: '/opt/dare',
      model: 'test/model',
    });
    const promise = collect(service.invoke('Test', { workingDirectory: '/tmp/project' }));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    // cwd must be darePath (where python -m client can find the module)
    assert.strictEqual(opts.cwd, '/opt/dare');
    // workingDirectory passed as --workspace arg instead
    const args = spawnFn.mock.calls[0].arguments[1];
    const wsIdx = args.indexOf('--workspace');
    assert.ok(wsIdx >= 0, `expected --workspace in args: ${args}`);
    assert.strictEqual(args[wsIdx + 1], '/tmp/project');
  });

  test('no --workspace when workingDirectory is absent (P1-1)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      darePath: '/opt/dare',
      model: 'test/model',
    });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--workspace'), `should not have --workspace: ${args}`);
    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.cwd, '/opt/dare');
  });

  test('metadata includes provider=dare and model', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      model: 'zhipu/glm-4.7',
    });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    const messages = await promise;

    const textMsg = messages.find((m) => m.type === 'text');
    assert.ok(textMsg.metadata);
    assert.strictEqual(textMsg.metadata.provider, 'dare');
    assert.strictEqual(textMsg.metadata.model, 'zhipu/glm-4.7');
  });

  test('metadata.sessionId set after session_init', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    const messages = await promise;

    const doneMsg = messages.find((m) => m.type === 'done');
    assert.strictEqual(doneMsg.metadata.sessionId, 'dare-sess-1');
  });

  test('yields error on task.failed', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_FAILED]);
    const messages = await promise;

    const errorMsg = messages.find((m) => m.type === 'error' && m.error?.includes('Approval'));
    assert.ok(errorMsg, 'expected error with approval message');
  });

  test('yields error + done on CLI exit failure', async () => {
    const proc = createMockProcess(1);
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test'));
    // No DARE events — process just exits with code 1
    proc.stdout.end();
    process.nextTick(() => proc._emitter.emit('exit', 1, null));
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('error'), `expected error in types: ${types}`);
    assert.ok(types.includes('done'), `expected done in types: ${types}`);
  });

  // P1-3: API key must NOT appear in CLI args (security risk via ps/audit)
  test('API key is passed via env, not CLI args (P1-3)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    // Temporarily set env for test
    const originalKey = process.env.OPENROUTER_API_KEY;
    const originalDareKey = process.env.DARE_API_KEY;
    delete process.env.DARE_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-secret-key';
    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        adapter: 'openrouter',
        model: 'test/model',
      });
      const promise = collect(service.invoke('Test'));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const args = spawnFn.mock.calls[0].arguments[1];
      assert.ok(!args.includes('--api-key'), `API key must not be in CLI args: ${args}`);
      assert.ok(!args.includes('sk-test-secret-key'), `secret must not appear in args`);

      // Key should be in child process env instead
      const opts = spawnFn.mock.calls[0].arguments[2];
      assert.strictEqual(opts.env.OPENROUTER_API_KEY, 'sk-test-secret-key');
    } finally {
      if (originalKey !== undefined) process.env.OPENROUTER_API_KEY = originalKey;
      else delete process.env.OPENROUTER_API_KEY;
      if (originalDareKey !== undefined) process.env.DARE_API_KEY = originalDareKey;
      else delete process.env.DARE_API_KEY;
    }
  });

  test('anthropic adapter: key via ANTHROPIC_API_KEY env and endpoint via --endpoint', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const oldDareEndpoint = process.env.DARE_ENDPOINT;
    const oldDareKey2 = process.env.DARE_API_KEY;
    delete process.env.DARE_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    process.env.DARE_ENDPOINT = 'https://anthropic-proxy.example/v1';

    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        adapter: 'anthropic',
        model: 'claude-3-7-sonnet-latest',
      });
      const promise = collect(service.invoke('Test anthropic'));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const args = spawnFn.mock.calls[0].arguments[1];
      assert.ok(!args.includes('--api-key'), `API key must not be in CLI args: ${args}`);
      assert.ok(!args.includes('sk-ant-secret'), `secret must not appear in args`);

      const endpointIdx = args.indexOf('--endpoint');
      assert.ok(endpointIdx >= 0, `expected --endpoint in args: ${args}`);
      assert.strictEqual(args[endpointIdx + 1], 'https://anthropic-proxy.example/v1');

      const opts = spawnFn.mock.calls[0].arguments[2];
      assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-ant-secret');
    } finally {
      if (oldAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (oldDareEndpoint !== undefined) process.env.DARE_ENDPOINT = oldDareEndpoint;
      else delete process.env.DARE_ENDPOINT;
      if (oldDareKey2 !== undefined) process.env.DARE_API_KEY = oldDareKey2;
      else delete process.env.DARE_API_KEY;
    }
  });

  test('DARE_API_KEY overrides adapter-specific key and maps to adapter env name', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldDareKey = process.env.DARE_API_KEY;
    const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.DARE_API_KEY = 'sk-dare-override';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-will-be-overridden';

    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        adapter: 'anthropic',
        model: 'claude-3-7-sonnet-latest',
      });
      const promise = collect(service.invoke('Test key override'));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const opts = spawnFn.mock.calls[0].arguments[2];
      assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-dare-override');
      assert.ok(!('DARE_API_KEY' in opts.env), 'generic key should not leak to child env');
    } finally {
      if (oldDareKey !== undefined) process.env.DARE_API_KEY = oldDareKey;
      else delete process.env.DARE_API_KEY;
      if (oldAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test('always yields exactly one final done', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    const messages = await promise;

    const doneMessages = messages.filter((m) => m.type === 'done');
    // task.completed yields a 'text', then service yields final 'done'
    // The transformer's task.completed → text, NOT done
    assert.strictEqual(doneMessages.length, 1, `expected exactly 1 done, got ${doneMessages.length}`);
  });

  test('sessionId passthrough uses --session-id (not --resume)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });

    const promise = collect(service.invoke('Continue task', { sessionId: 'sess-42' }));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const sidIdx = args.indexOf('--session-id');
    assert.ok(sidIdx >= 0, `expected --session-id in args: ${args}`);
    assert.strictEqual(args[sidIdx + 1], 'sess-42');
    assert.ok(!args.includes('--resume'), `did not expect --resume in args: ${args}`);
  });

  // F135: venv python — uses .venv/bin/python when available
  test('uses venv python as command when .venv/bin/python exists (F135)', async () => {
    const tmpDare = join(tmpdir(), `dare-test-venv-${Date.now()}`);
    mkdirSync(join(tmpDare, '.venv', 'bin'), { recursive: true });
    mkdirSync(join(tmpDare, 'client'), { recursive: true });
    writeFileSync(join(tmpDare, '.venv', 'bin', 'python'), '#!/bin/sh\n');
    writeFileSync(join(tmpDare, 'client', '__main__.py'), '');

    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      darePath: tmpDare,
      model: 'test/model',
    });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const command = spawnFn.mock.calls[0].arguments[0];
    assert.strictEqual(command, join(tmpDare, '.venv', 'bin', 'python'));
  });

  test('falls back to bare python when no .venv exists (F135)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      darePath: '/opt/dare',
      model: 'test/model',
    });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const command = spawnFn.mock.calls[0].arguments[0];
    assert.strictEqual(command, 'python');
  });
});

// F135: resolveVendorDarePath — project root resolution
describe('resolveVendorDarePath (F135)', () => {
  test('returns absolute path ending with vendor/dare-cli', () => {
    const result = resolveVendorDarePath();
    assert.ok(result.endsWith(join('vendor', 'dare-cli')), `expected vendor/dare-cli suffix, got: ${result}`);
    assert.ok(result.startsWith('/'), `expected absolute path, got: ${result}`);
  });

  test('does not depend on process.cwd()', () => {
    const originalCwd = process.cwd();
    const result1 = resolveVendorDarePath();
    // Change cwd and verify result is identical
    process.chdir('/tmp');
    try {
      const result2 = resolveVendorDarePath();
      assert.strictEqual(result1, result2, 'resolveVendorDarePath must not vary with cwd');
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('resolves to project root, not packages/ (P1 depth check)', () => {
    const result = resolveVendorDarePath();
    // Must NOT contain packages/ in the vendor path
    assert.ok(
      !result.includes(join('packages', 'vendor')),
      `path should be at project root, not inside packages/: ${result}`,
    );
  });
});

// F135: resolveVenvPython helper
describe('resolveVenvPython (F135)', () => {
  test('returns .venv/bin/python when it exists', () => {
    const tmpDare = join(tmpdir(), `dare-test-helper-${Date.now()}`);
    mkdirSync(join(tmpDare, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(tmpDare, '.venv', 'bin', 'python'), '#!/bin/sh\n');

    const result = resolveVenvPython(tmpDare);
    assert.strictEqual(result, join(tmpDare, '.venv', 'bin', 'python'));
  });

  test('returns bare python when .venv does not exist', () => {
    const result = resolveVenvPython('/nonexistent/path');
    assert.strictEqual(result, 'python');
  });
});
