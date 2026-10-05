/**
 * F319: cli-spawn exposes child stderr line by line to an opt-in observer and
 * keeps its own diagnostic buffer bounded. Trace-level provider logging can
 * emit megabytes per turn; the observer consumes and drops, the buffer keeps
 * the tail that exit diagnostics (F212) actually read.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const { spawnCli, isCliError, STDERR_BUFFER_MAX_CHARS } = await import('../dist/utils/cli-spawn.js');
const { createStderrTail } = await import('../dist/utils/stderr-tail.js');

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') process.nextTick(() => originalEmit('close', ...args));
    return emitted;
  };
  return {
    stdout,
    stderr,
    stdin: { write() {}, end() {} },
    pid: 4242,
    killed: false,
    exitCode: null,
    kill() {
      this.killed = true;
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    _emitter: emitter,
  };
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test('createStderrTail keeps a bounded tail and delivers each complete line once', () => {
  const lines = [];
  const tail = createStderrTail({ maxChars: 32, onLine: (line) => lines.push(line) });
  tail.append('first li');
  tail.append('ne\r\nsecond line\n');
  tail.append('x'.repeat(100));
  tail.append('\nFINAL');
  assert.deepEqual(lines, ['first line', 'second line', 'x'.repeat(100)]);
  assert.ok(tail.value.length <= 32, `tail must be bounded, got ${tail.value.length}`);
  assert.ok(tail.value.endsWith('FINAL'), 'tail keeps the newest bytes');
  tail.flush();
  assert.deepEqual(lines.at(-1), 'FINAL', 'flush delivers the trailing partial line');
  tail.flush();
  assert.equal(lines.length, 4, 'flush is idempotent');
});

test('createStderrTail drops a newline-less run longer than maxLineChars instead of retaining it', () => {
  const lines = [];
  const tail = createStderrTail({ maxChars: 32, maxLineChars: 16, onLine: (line) => lines.push(line) });
  tail.append('y'.repeat(10));
  tail.append('y'.repeat(10)); // carry would reach 20 > 16 → dropped, now discarding until newline
  tail.append('yyy\nnext\n');
  assert.deepEqual(lines, ['next'], 'oversized partial line never reaches the observer; following line does');
  tail.append('z'.repeat(20));
  tail.flush();
  assert.deepEqual(lines, ['next'], 'flush of an oversized carry delivers nothing');
  tail.append('after\n');
  assert.deepEqual(lines, ['next', 'after'], 'observer resumes after the oversized run ends');
  assert.ok(tail.value.length <= 32, `tail stays bounded, got ${tail.value.length}`);
});

test('onStderrLine receives each complete line, including lines split across chunks', async () => {
  const proc = createMockProcess();
  const lines = [];
  const promise = collect(
    spawnCli({ command: 'codex', args: [], onStderrLine: (line) => lines.push(line) }, { spawnFn: () => proc }),
  );
  proc.stderr.write('first li');
  proc.stderr.write('ne\nsecond line\nthird (no newline yet)');
  proc.stdout.write('{"type":"turn.completed"}\n');
  setImmediate(() => {
    proc.stderr.end();
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
  });
  await promise;
  assert.deepEqual(lines, ['first line', 'second line', 'third (no newline yet)']);
});

test('stderr already written before semantic completion reaches the observer', async () => {
  const proc = createMockProcess();
  const lines = [];
  const controller = new AbortController();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        onStderrLine: (line) => lines.push(line),
        semanticCompletionSignal: controller.signal,
      },
      { spawnFn: () => proc },
    ),
  );
  proc.stderr.write('SSE event: {"type":"response.created"}\n');
  proc.stdout.write('{"type":"turn.completed"}\n');
  controller.abort();
  proc.stdout.end();
  setImmediate(() => proc._emitter.emit('exit', 0, null));
  await promise;
  assert.ok(
    lines.includes('SSE event: {"type":"response.created"}'),
    `observer must see buffered stderr, got ${JSON.stringify(lines)}`,
  );
});

test('exit diagnostics still see the newest stderr after the buffer overflowed', async () => {
  const proc = createMockProcess();
  const diagnostics = [];
  const originalFlag = process.env.LOG_CLI_STDERR;
  process.env.LOG_CLI_STDERR = '1';
  try {
    const promise = collect(
      spawnCli(
        {
          command: 'codex',
          args: [],
          diagnosticLogger: { error: (payload, msg) => diagnostics.push({ payload, msg }) },
        },
        { spawnFn: () => proc },
      ),
    );
    const filler = 'x'.repeat(1024);
    const chunks = Math.ceil((STDERR_BUFFER_MAX_CHARS * 3) / filler.length);
    for (let i = 0; i < chunks; i++) proc.stderr.write(`${filler}\n`);
    proc.stderr.write('FINAL_MARKER_LINE\n');
    setImmediate(() => {
      proc.stderr.end();
      proc.stdout.end();
      proc._emitter.emit('exit', 1, null);
    });
    const events = await promise;
    assert.ok(
      events.some((event) => isCliError(event)),
      'non-zero exit must still yield __cliError',
    );
    const stderrLog = diagnostics.find((entry) => entry.msg === 'CLI stderr (LOG_CLI_STDERR=1)');
    assert.ok(stderrLog, 'stderr diagnostic log must still be written');
    assert.match(stderrLog.payload.stderr, /FINAL_MARKER_LINE/);
  } finally {
    if (originalFlag === undefined) delete process.env.LOG_CLI_STDERR;
    else process.env.LOG_CLI_STDERR = originalFlag;
  }
});
