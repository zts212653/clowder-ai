import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';

// ── Mock helpers (same pattern as dare-agent-service.test.js) ──

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

function emitOpenCodeEvents(proc, events) {
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

// ── opencode JSON event fixtures ──

const STEP_START = {
  type: 'step_start',
  timestamp: 1773304958492,
  sessionID: 'ses_test123',
  part: { type: 'step-start', id: 'prt_1', sessionID: 'ses_test123', messageID: 'msg_1' },
};

const TEXT_RESPONSE = {
  type: 'text',
  timestamp: 1773304958494,
  sessionID: 'ses_test123',
  part: { type: 'text', text: 'Hello from opencode!', time: { start: 1773304958493, end: 1773304958493 } },
};

const TOOL_USE = {
  type: 'tool_use',
  timestamp: 1773304980356,
  sessionID: 'ses_test123',
  part: {
    type: 'tool',
    callID: 'toolu_test1',
    tool: 'bash',
    state: { status: 'completed', input: { command: 'ls', description: 'List files' }, output: 'file.txt' },
  },
};

const STEP_FINISH = {
  type: 'step_finish',
  timestamp: 1773304958508,
  sessionID: 'ses_test123',
  part: { type: 'step-finish', reason: 'stop', cost: 0.036, tokens: { total: 36937 } },
};

const _ERROR_EVENT = {
  type: 'error',
  timestamp: 1773298718314,
  sessionID: 'ses_test123',
  error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } },
};

describe('OpenCodeAgentService', () => {
  test('yields session_init, text, done from opencode events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Say hello'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('session_init'), `expected session_init, got: ${types}`);
    assert.ok(types.includes('text'), `expected text, got: ${types}`);
    assert.ok(types.includes('done'), `expected done, got: ${types}`);

    const textMsg = messages.find((m) => m.type === 'text');
    assert.strictEqual(textMsg.content, 'Hello from opencode!');
    assert.strictEqual(textMsg.catId, 'opencode');
  });

  test('yields tool_use for tool events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Use tools'));
    emitOpenCodeEvents(proc, [STEP_START, TOOL_USE, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const toolMsg = messages.find((m) => m.type === 'tool_use');
    assert.ok(toolMsg, 'expected tool_use message');
    assert.strictEqual(toolMsg.toolName, 'bash');
  });

  test('passes --format json and -m model in CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(service.invoke('Test prompt'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const call = spawnFn.mock.calls[0];
    const args = call.arguments[1];
    assert.ok(args.includes('run'), `expected 'run' in args: ${args}`);
    assert.ok(args.includes('--format') && args.includes('json'), `expected --format json in args: ${args}`);
    const mIdx = args.indexOf('-m');
    assert.ok(mIdx >= 0, `expected -m in args: ${args}`);
    assert.strictEqual(args[mIdx + 1], 'anthropic/claude-sonnet-4-6');
  });

  test('API key is passed via ANTHROPIC_API_KEY env, not CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test-secret',
    });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('sk-test-secret'), 'secret must not appear in CLI args');

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-test-secret');
  });

  test('subscription mode clears inherited anthropic credentials', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      apiKey: 'sk-should-not-leak',
      baseUrl: 'https://proxy.example/v1',
    });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: {
          CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
          ANTHROPIC_API_KEY: 'sk-inherited',
          ANTHROPIC_BASE_URL: 'https://inherited.example/v1',
        },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, null);
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, null);
  });

  test('baseUrl passed via ANTHROPIC_BASE_URL env', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      baseUrl: 'https://proxy.example/v1',
    });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, 'https://proxy.example/v1');
  });

  test('cwd is workingDirectory (unlike DARE which uses darePath)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test', { workingDirectory: '/tmp/project' }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.cwd, '/tmp/project');
  });

  test('yields error + done on CLI exit failure', async () => {
    const proc = createMockProcess(1);
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test'));
    proc.stdout.end();
    process.nextTick(() => proc._emitter.emit('exit', 1, null));
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('error'), `expected error in types: ${types}`);
    assert.ok(types.includes('done'), `expected done in types: ${types}`);
  });

  test('metadata includes provider=opencode and model', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const textMsg = messages.find((m) => m.type === 'text');
    assert.ok(textMsg.metadata);
    assert.strictEqual(textMsg.metadata.provider, 'opencode');
    assert.strictEqual(textMsg.metadata.model, 'claude-sonnet-4-6');
  });

  test('metadata.sessionId set after session_init', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const doneMsg = messages.find((m) => m.type === 'done');
    assert.strictEqual(doneMsg.metadata.sessionId, 'ses_test123');
  });

  test('session resume passes --session and --continue', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Continue', { sessionId: 'ses_prev' }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const sIdx = args.indexOf('--session');
    assert.ok(sIdx >= 0, `expected --session in args: ${args}`);
    assert.strictEqual(args[sIdx + 1], 'ses_prev');
  });

  test('always yields exactly one final done', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const doneMessages = messages.filter((m) => m.type === 'done');
    assert.strictEqual(doneMessages.length, 1, `expected exactly 1 done, got ${doneMessages.length}`);
  });

  // ── P1-2: CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE via callbackEnv ──

  test('callbackEnv MODEL_OVERRIDE overrides constructor model in -m arg', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'claude-haiku-4-5' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const mIdx = args.indexOf('-m');
    assert.strictEqual(
      args[mIdx + 1],
      'anthropic/claude-haiku-4-5',
      `expected model override to be used, got: ${args[mIdx + 1]}`,
    );
  });

  // ── P1-1: callbackEnv BASE_URL gets /v1 suffix for opencode ──

  test('callbackEnv CAT_CAFE_ANTHROPIC_BASE_URL appends /v1 for opencode', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9877/a247a834' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(
      opts.env.ANTHROPIC_BASE_URL,
      'http://127.0.0.1:9877/a247a834/v1',
      'opencode needs /v1 suffix because its SDK calls {baseURL}/messages not {baseURL}/v1/messages',
    );
  });

  test('callbackEnv BASE_URL with trailing /v1 is not double-suffixed', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9877/slug/v1' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9877/slug/v1', 'should not double-append /v1');
  });

  // ── P2-1: multiple step_start should NOT produce multiple session_init ──

  test('multiple step_start events yield only one session_init', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const STEP_START_2 = { ...STEP_START, timestamp: STEP_START.timestamp + 5000 };
    const promise = collect(service.invoke('Multi-step'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH, STEP_START_2, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const sessionInits = messages.filter((m) => m.type === 'session_init');
    assert.strictEqual(
      sessionInits.length,
      1,
      `expected exactly 1 session_init, got ${sessionInits.length} — multi-step runs must not produce duplicate session events`,
    );
  });
});
