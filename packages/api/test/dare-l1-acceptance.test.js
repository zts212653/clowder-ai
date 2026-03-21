import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { collect, createMockProcess, emitDareEvents, envelope } from './helpers/dare-test-utils.js';

const { DareAgentService } = await import('../dist/domains/cats/services/agents/providers/DareAgentService.js');

describe('DARE L1 acceptance contract', () => {
  test('session lifecycle: emits session_init and final done with session metadata', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });

    const pending = collect(service.invoke('hello'));
    emitDareEvents(proc, [
      envelope('session.started', { mode: 'chat', entrypoint: 'run' }, 1),
      envelope('task.completed', { rendered_output: 'hi' }, 2),
    ]);

    const messages = await pending;
    assert.equal(messages.at(-1)?.type, 'done');

    const sessionInit = messages.find((m) => m.type === 'session_init');
    assert.ok(sessionInit, 'must emit session_init');
    assert.equal(sessionInit.sessionId, 'sess-l1');

    const done = messages.at(-1);
    assert.equal(done?.metadata?.sessionId, 'sess-l1');
    assert.equal(done?.metadata?.provider, 'dare');
    assert.equal(done?.metadata?.model, 'test/model');

    const doneCount = messages.filter((m) => m.type === 'done').length;
    assert.equal(doneCount, 1, 'must emit exactly one final done');
  });

  test('event completeness: maps required headless events to AgentMessage semantics', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });

    const pending = collect(service.invoke('map events'));
    emitDareEvents(proc, [
      envelope('session.started', { mode: 'chat' }, 1),
      envelope('tool.invoke', { tool_name: 'read_file', tool_call_id: 't1' }, 2),
      envelope('tool.result', { tool_name: 'read_file', success: true }, 3),
      envelope('tool.error', { tool_name: 'write_file', error: 'denied' }, 4),
      envelope('approval.pending', { tool_name: 'shell' }, 5),
      envelope('task.completed', { rendered_output: 'done output' }, 6),
      envelope('task.failed', { error: 'approval timeout' }, 7),
    ]);

    const messages = await pending;
    const types = messages.map((m) => m.type);
    assert.ok(types.includes('session_init'));
    assert.ok(types.includes('tool_use'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('system_info'));
    assert.ok(types.includes('text'));
    assert.ok(types.includes('error'));

    const text = messages.find((m) => m.type === 'text');
    assert.equal(text?.content, 'done output');

    const toolUse = messages.find((m) => m.type === 'tool_use');
    assert.equal(toolUse?.toolName, 'read_file');

    const toolErr = messages.find((m) => m.type === 'tool_result' && m.toolName === 'write_file');
    assert.ok(toolErr?.content?.includes('denied'));
  });

  test('auth contract: no CLI key leakage, key+callback env forwarded to child process', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldOpenrouter = process.env.OPENROUTER_API_KEY;
    const oldDareKey = process.env.DARE_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-openrouter-test';
    delete process.env.DARE_API_KEY;

    try {
      const service = new DareAgentService({
        catId: 'dare',
        spawnFn,
        adapter: 'openrouter',
        model: 'test/model',
      });

      const pending = collect(
        service.invoke('auth test', {
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
            CAT_CAFE_INVOCATION_ID: 'inv-l1',
          },
        }),
      );

      emitDareEvents(proc, [
        envelope('session.started', {}, 1),
        envelope('task.completed', { rendered_output: 'ok' }, 2),
      ]);
      await pending;

      const args = spawnFn.mock.calls[0].arguments[1];
      assert.ok(!args.includes('--api-key'));
      assert.ok(!args.includes('sk-openrouter-test'));

      const spawnOpts = spawnFn.mock.calls[0].arguments[2];
      assert.equal(spawnOpts.env.OPENROUTER_API_KEY, 'sk-openrouter-test');
      assert.equal(spawnOpts.env.CAT_CAFE_API_URL, 'http://127.0.0.1:3004');
      assert.equal(spawnOpts.env.CAT_CAFE_INVOCATION_ID, 'inv-l1');
    } finally {
      if (oldOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldOpenrouter;
      if (oldDareKey === undefined) delete process.env.DARE_API_KEY;
      else process.env.DARE_API_KEY = oldDareKey;
    }
  });

  test('error recovery: abnormal CLI exit still yields sanitized error and final done', async () => {
    const proc = createMockProcess(9);
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });

    const pending = collect(service.invoke('crash test'));
    proc.stderr.write('raw secret error\n');
    proc.stdout.end();
    process.nextTick(() => proc._emitter.emit('exit', 9, null));

    const messages = await pending;
    const error = messages.find((m) => m.type === 'error');
    assert.ok(error, 'must emit error on non-zero CLI exit');
    assert.ok(error.error?.includes('code: 9'));
    assert.ok(!error.error?.includes('raw secret error'));

    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('error recovery: CLI silent timeout emits error and final done', { timeout: 2_000 }, async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const oldTimeout = process.env.CLI_TIMEOUT_MS;
    process.env.CLI_TIMEOUT_MS = '20';

    try {
      const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });
      const messages = await collect(service.invoke('timeout please'));

      const timeoutError = messages.find((m) => m.type === 'error' && m.error?.includes('超时'));
      assert.ok(timeoutError, 'must emit timeout error when CLI is silent');
      assert.equal(messages.at(-1)?.type, 'done');
    } finally {
      if (oldTimeout === undefined) delete process.env.CLI_TIMEOUT_MS;
      else process.env.CLI_TIMEOUT_MS = oldTimeout;
    }
  });

  test('resume contract: sessionId passthrough uses --session-id alias', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new DareAgentService({ catId: 'dare', spawnFn, model: 'test/model' });

    const pending = collect(service.invoke('resume me', { sessionId: 'sess-resume-1' }));
    emitDareEvents(proc, [
      envelope('session.started', {}, 1),
      envelope('task.completed', { rendered_output: 'ok' }, 2),
    ]);
    await pending;

    const args = spawnFn.mock.calls[0].arguments[1];
    const sidIdx = args.indexOf('--session-id');
    assert.ok(sidIdx >= 0, `expected --session-id in args: ${args}`);
    assert.equal(args[sidIdx + 1], 'sess-resume-1');
    assert.ok(!args.includes('--resume'), `did not expect --resume in args: ${args}`);
  });
});
