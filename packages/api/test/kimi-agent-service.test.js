import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');

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
    pid: 23456,
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

function createMockSpawnFn(proc) {
  return mock.fn(() => proc);
}

function emitKimiEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
}

test('yields text, tool_use, inferred session_init, and done on print-mode success', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    mkdirSync(shareDir, { recursive: true });
    writeFileSync(
      join(shareDir, 'kimi.json'),
      JSON.stringify(
        {
          work_dirs: [
            {
              path: process.cwd(),
              kaos: 'local',
              last_session_id: 'kimi-session-123',
            },
          ],
        },
        null,
        2,
      ),
    );

    const promise = collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
      }),
    );

    emitKimiEvents(proc, [
      {
        role: 'assistant',
        content: '先看一下目录。',
        tool_calls: [
          {
            type: 'function',
            id: 'tc_1',
            function: {
              name: 'Shell',
              arguments: '{"command":"ls"}',
            },
          },
        ],
      },
      { role: 'assistant', content: '已经完成。' },
    ]);

    const msgs = await promise;
    assert.equal(msgs[0].type, 'text');
    assert.equal(msgs[0].content, '先看一下目录。');
    assert.equal(msgs[1].type, 'tool_use');
    assert.equal(msgs[1].toolName, 'Shell');
    assert.deepEqual(msgs[1].toolInput, { command: 'ls' });
    assert.equal(msgs[2].type, 'text');
    assert.equal(msgs[2].content, '已经完成。');
    assert.equal(msgs[3].type, 'session_init');
    assert.equal(msgs[3].sessionId, 'kimi-session-123');
    assert.equal(msgs[4].type, 'done');

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--prompt'));
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('uses --session for resume and emits session_init immediately', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  const promise = collect(service.invoke('Continue', { sessionId: 'resume-kimi-456' }));
  await new Promise((resolve) => setImmediate(resolve));
  emitKimiEvents(proc, [{ role: 'assistant', content: 'Resumed Kimi.' }]);
  const msgs = await promise;

  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[0].sessionId, 'resume-kimi-456');
  assert.equal(msgs[1].type, 'text');
  assert.equal(msgs[1].content, 'Resumed Kimi.');

  const args = spawnFn.mock.calls[0].arguments[1];
  const sessionFlagIndex = args.indexOf('--session');
  assert.ok(sessionFlagIndex >= 0);
  assert.equal(args[sessionFlagIndex + 1], 'resume-kimi-456');
});
