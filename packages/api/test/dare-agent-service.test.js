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

  test('omits --adapter and --model when no explicit override is provided', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    // Clear all model and adapter env vars so fallbacks don't inject flags
    const oldCatModel = process.env.CAT_DARE_MODEL;
    const oldOverride = process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
    const oldAdapter = process.env.DARE_ADAPTER;
    delete process.env.CAT_DARE_MODEL;
    delete process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
    delete process.env.DARE_ADAPTER;
    try {
      const service = new DareAgentService({ catId: 'dare', spawnFn, darePath: '/opt/dare' });
      const promise = collect(service.invoke('Test', { workingDirectory: '/tmp/project' }));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const args = spawnFn.mock.calls[0].arguments[1];
      assert.ok(!args.includes('--adapter'), `should not override adapter from workspace config: ${args}`);
      assert.ok(!args.includes('--model'), `should not override model from workspace config: ${args}`);
      const wsIdx = args.indexOf('--workspace');
      assert.ok(wsIdx >= 0, `expected --workspace in args: ${args}`);
      assert.strictEqual(args[wsIdx + 1], '/tmp/project');
    } finally {
      if (oldCatModel !== undefined) process.env.CAT_DARE_MODEL = oldCatModel;
      else delete process.env.CAT_DARE_MODEL;
      if (oldOverride !== undefined) process.env.CAT_CAFE_DARE_MODEL_OVERRIDE = oldOverride;
      else delete process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
      if (oldAdapter !== undefined) process.env.DARE_ADAPTER = oldAdapter;
      else delete process.env.DARE_ADAPTER;
    }
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

  test('metadata model includes workspace adapter/model when no explicit override is provided', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const root = join(tmpdir(), `dare-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(root, '.dare'), { recursive: true });
    writeFileSync(
      join(root, '.dare', 'config.json'),
      JSON.stringify({ llm: { adapter: 'huawei-modelarts', model: 'glm-5' } }),
      'utf8',
    );
    // Isolate from real env to avoid getCatModel() short-circuiting workspace display
    const oldOverride = process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
    const oldCatModel = process.env.CAT_DARE_MODEL;
    delete process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
    delete process.env.CAT_DARE_MODEL;
    try {
      const service = new DareAgentService({ catId: 'dare', spawnFn, darePath: '/opt/dare' });
      const promise = collect(service.invoke('Test', { workingDirectory: root }));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      const messages = await promise;

      const textMsg = messages.find((m) => m.type === 'text');
      assert.ok(textMsg.metadata);
      assert.strictEqual(textMsg.metadata.provider, 'dare');
      assert.strictEqual(textMsg.metadata.model, 'huawei-modelarts/glm-5');
    } finally {
      if (oldOverride !== undefined) process.env.CAT_CAFE_DARE_MODEL_OVERRIDE = oldOverride;
      else delete process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
      if (oldCatModel !== undefined) process.env.CAT_DARE_MODEL = oldCatModel;
      else delete process.env.CAT_DARE_MODEL;
    }
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

  test('apiKey option overrides adapter-specific key and maps to adapter env name', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);

    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      adapter: 'anthropic',
      model: 'claude-3-7-sonnet-latest',
      apiKey: 'sk-dare-override',
    });
    const promise = collect(service.invoke('Test key override'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-dare-override');
    assert.ok(!('DARE_API_KEY' in opts.env), 'generic key should not leak to child env');
  });

  test('huawei-modelarts adapter maps generic key override to HUAWEI_MODELARTS_API_KEY', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldDareKey = process.env.DARE_API_KEY;
    const oldModelArtsKey = process.env.HUAWEI_MODELARTS_API_KEY;
    process.env.DARE_API_KEY = 'modelarts-key';
    delete process.env.HUAWEI_MODELARTS_API_KEY;

    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        adapter: 'huawei-modelarts',
      });
      const promise = collect(service.invoke('Test key mapping'));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const opts = spawnFn.mock.calls[0].arguments[2];
      assert.strictEqual(opts.env.HUAWEI_MODELARTS_API_KEY, 'modelarts-key');
      assert.ok(!('DARE_API_KEY' in opts.env), 'generic key should not leak to child env');
    } finally {
      if (oldDareKey !== undefined) process.env.DARE_API_KEY = oldDareKey;
      else delete process.env.DARE_API_KEY;
      if (oldModelArtsKey !== undefined) process.env.HUAWEI_MODELARTS_API_KEY = oldModelArtsKey;
      else delete process.env.HUAWEI_MODELARTS_API_KEY;
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
    assert.ok(!args.includes('--resume'), `should not use legacy --resume flag: ${args}`);
  });

  // P2-1: Session init dedup — only first session.started is emitted
  test('deduplicates session_init: only first session.started is emitted (P2-1)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Multi-step'));

    const SESSION_STARTED_2 = {
      ...SESSION_STARTED,
      seq: 10,
      session_id: 'dare-sess-2',
    };
    emitDareEvents(proc, [SESSION_STARTED, TOOL_INVOKE, TOOL_RESULT, SESSION_STARTED_2, TASK_COMPLETED]);
    const messages = await promise;

    const sessionInits = messages.filter((m) => m.type === 'session_init');
    assert.strictEqual(sessionInits.length, 1, `expected 1 session_init, got ${sessionInits.length}`);
    assert.strictEqual(sessionInits[0].sessionId, 'dare-sess-1');
  });

  // systemPrompt: passed via --system-prompt-text
  test('systemPrompt is forwarded via --system-prompt-text and --system-prompt-mode append', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test', { systemPrompt: 'You are a helpful cat.' }));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const modeIdx = args.indexOf('--system-prompt-mode');
    assert.ok(modeIdx >= 0, `expected --system-prompt-mode in args: ${args}`);
    assert.strictEqual(args[modeIdx + 1], 'append');

    const textIdx = args.indexOf('--system-prompt-text');
    assert.ok(textIdx >= 0, `expected --system-prompt-text in args: ${args}`);
    assert.strictEqual(args[textIdx + 1], 'You are a helpful cat.');
  });

  test('no --system-prompt-text when systemPrompt is absent', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--system-prompt-text'), `should not have --system-prompt-text: ${args}`);
    assert.ok(!args.includes('--system-prompt-mode'), `should not have --system-prompt-mode: ${args}`);
  });

  // MCP path: passed via --mcp-path when callbackEnv is present
  test('mcpServerPath is forwarded via --mcp-path when callbackEnv is present', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      model: 'test/model',
      mcpServerPath: '/opt/mcp/dist/index.js',
    });
    const promise = collect(service.invoke('Test', { callbackEnv: { CAT_CAFE_API_URL: 'http://localhost:3004' } }));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpIdx = args.indexOf('--mcp-path');
    assert.ok(mcpIdx >= 0, `expected --mcp-path in args: ${args}`);
    assert.strictEqual(args[mcpIdx + 1], '/opt/mcp/dist/index.js');
  });

  test('no --mcp-path when callbackEnv is absent', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({
      catId: 'dare',
      spawnFn,
      model: 'test/model',
      mcpServerPath: '/opt/mcp/dist/index.js',
    });
    const promise = collect(service.invoke('Test'));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--mcp-path'), `should not have --mcp-path without callbackEnv: ${args}`);
  });

  // cliConfigArgs: user-defined CLI flags are forwarded
  test('cliConfigArgs are forwarded to CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
    const promise = collect(service.invoke('Test', { cliConfigArgs: ['--budget-tokens 5000', '--verbose'] }));
    emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--budget-tokens'), `expected --budget-tokens in args: ${args}`);
    assert.ok(args.includes('5000'), `expected 5000 in args: ${args}`);
    assert.ok(args.includes('--verbose'), `expected --verbose in args: ${args}`);
    const taskIdx = args.indexOf('--task');
    const budgetIdx = args.indexOf('--budget-tokens');
    assert.ok(budgetIdx < taskIdx, 'cliConfigArgs should appear before --task');
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

  // NOTE: This test only works when vendor/dare-cli is NOT present.
  // When vendor/dare-cli exists, resolveDefaultDarePath() always finds it,
  // and `darePath: undefined` in options falls through via ?? to the default.
  test('returns explicit error when darePath is missing in runtime mode', { skip: existsSync(join(resolveVendorDarePath(), 'client', '__main__.py')) }, async () => {
    const oldDarePath = process.env.DARE_PATH;
    delete process.env.DARE_PATH;
    try {
      const service = new DareAgentService({ catId: 'dare', darePath: undefined });
      const messages = await collect(service.invoke('Test missing path'));
      const errorMsg = messages.find((m) => m.type === 'error');
      assert.ok(errorMsg, 'expected error message');
      assert.match(errorMsg.error, /DARE CLI 未配置路径/);
    } finally {
      if (oldDarePath !== undefined) process.env.DARE_PATH = oldDarePath;
      else delete process.env.DARE_PATH;
    }
  });

  // Regression: CAT_DARE_MODEL env → getCatModel() fallback → --model CLI arg
  // Without this fallback, huawei-modelarts adapter fails with "model is required"
  test('passes --model from getCatModel() fallback when no explicit override (regression)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldOverride = process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
    const oldCatModel = process.env.CAT_DARE_MODEL;
    delete process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
    process.env.CAT_DARE_MODEL = 'glm-5';

    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        darePath: '/opt/dare',
        adapter: 'huawei-modelarts',
        // No explicit model — must fall through to getCatModel()
      });
      const promise = collect(service.invoke('Test model fallback'));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const args = spawnFn.mock.calls[0].arguments[1];
      const modelIdx = args.indexOf('--model');
      assert.ok(modelIdx >= 0, `expected --model in args: ${args}`);
      assert.strictEqual(args[modelIdx + 1], 'glm-5');
    } finally {
      if (oldOverride !== undefined) process.env.CAT_CAFE_DARE_MODEL_OVERRIDE = oldOverride;
      else delete process.env.CAT_CAFE_DARE_MODEL_OVERRIDE;
      if (oldCatModel !== undefined) process.env.CAT_DARE_MODEL = oldCatModel;
      else delete process.env.CAT_DARE_MODEL;
    }
  });

  // P3: whitespace-only model override must not short-circuit getCatModel fallback
  test('whitespace-only options.model does not short-circuit getCatModel fallback', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldCatModel = process.env.CAT_DARE_MODEL;
    process.env.CAT_DARE_MODEL = 'glm-5';

    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        darePath: '/opt/dare',
        model: '   ',  // whitespace-only — must not be treated as explicit model
      });
      const promise = collect(service.invoke('Test whitespace model'));
      emitDareEvents(proc, [SESSION_STARTED, TASK_COMPLETED]);
      await promise;

      const args = spawnFn.mock.calls[0].arguments[1];
      const modelIdx = args.indexOf('--model');
      assert.ok(modelIdx >= 0, `expected --model from getCatModel fallback: ${args}`);
      assert.strictEqual(args[modelIdx + 1], 'glm-5');
    } finally {
      if (oldCatModel !== undefined) process.env.CAT_DARE_MODEL = oldCatModel;
      else delete process.env.CAT_DARE_MODEL;
    }
  });

  test('returns explicit error when darePath is invalid in runtime mode', async () => {
    const service = new DareAgentService({ catId: 'dare', darePath: '/definitely/not/a/dare/repo' });
    const messages = await collect(service.invoke('Test invalid path'));
    const errorMsg = messages.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'expected error message');
    assert.match(errorMsg.error, /DARE_PATH 无效/);
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
    assert.ok(
      !result.includes(join('packages', 'vendor')),
      `path should be at project root, not inside packages/: ${result}`,
    );
  });
});

// F135: resolveVenvPython helper
describe('resolveVenvPython (F135)', () => {
  test('returns .venv/bin/python when it exists', () => {
    const tempRoot = join(tmpdir(), `dare-test-${Date.now()}`);
    const binDir = join(tempRoot, '.venv', 'bin');
    mkdirSync(binDir, { recursive: true });
    const py = join(binDir, 'python');
    writeFileSync(py, '#!/usr/bin/env python\n');

    const resolved = resolveVenvPython(tempRoot);
    assert.strictEqual(resolved, py);
    assert.ok(existsSync(resolved));
  });

  test('returns bare python when .venv does not exist', () => {
    const tempRoot = join(tmpdir(), `dare-test-no-venv-${Date.now()}`);
    const resolved = resolveVenvPython(tempRoot);
    assert.strictEqual(resolved, 'python');
  });
});
