/**
 * CLI Spawn Tests
 * 测试 CLI 子进程管理器
 */

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { clearTimeout as clearKeepAliveTimeout, setTimeout as setKeepAliveTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const {
  spawnCli,
  isCliError,
  isCliTimeout,
  isLivenessWarning,
  KILL_GRACE_MS,
  SEMANTIC_COMPLETION_GRACE_MS,
  resolveCliSupervisorNodeArgs,
} = await import('../dist/utils/cli-spawn.js');
const { DEFAULT_CLI_TIMEOUT_MS } = await import('../dist/utils/cli-timeout.js');
const { isParseError } = await import('../dist/utils/ndjson-parser.js');
const { ProcessLivenessProbe } = await import('../dist/utils/ProcessLivenessProbe.js');

/** Helper: collect all items from async iterable */
async function collect(iterable) {
  const keepAlive = setKeepAliveTimeout(() => {}, 15_000);
  const items = [];
  try {
    for await (const item of iterable) {
      items.push(item);
    }
    return items;
  } finally {
    clearKeepAliveTimeout(keepAlive);
  }
}

/**
 * Create a mock child process for testing.
 * @param {{ exitOnKill?: boolean, exitCode?: number, autoCloseOnExit?: boolean }} opts
 *   exitOnKill: if true (default), killing closes stdout and emits exit.
 *   exitCode: the code to emit on exit (default null for signal kills).
 *   autoCloseOnExit: if true (default), emitting exit schedules close like Node child_process.
 */
function createMockProcess(opts = {}) {
  const { exitOnKill = true, exitCode = null, pid = 12345, autoCloseOnExit = true } = opts;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit' && autoCloseOnExit) {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  const proc = {
    stdout,
    stderr,
    stdin: null,
    pid,
    exitCode: null,
    kill: mock.fn((signal) => {
      if (exitOnKill) {
        process.nextTick(() => {
          if (!stdout.destroyed) stdout.end();
          emitter.emit('exit', exitCode, signal || 'SIGTERM');
        });
      }
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
    // Expose emitter for manual event emission in tests
    _emitter: emitter,
  };
  return proc;
}

/** Create a mock SpawnFn that returns the given mock process */
function createMockSpawnFn(mockProcess) {
  return mock.fn(() => mockProcess);
}

test('spawnCli yields parsed JSON events from stdout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: ['--json'] }, { spawnFn }));

  proc.stdout.write('{"type":"start","id":"123"}\n');
  proc.stdout.write('{"type":"message","text":"hello"}\n');
  proc.stdout.end();
  // Emit clean exit
  proc._emitter.emit('exit', 0, null);

  const results = await promise;

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'start', id: '123' });
  assert.deepEqual(results[1], { type: 'message', text: 'hello' });

  // Verify spawn was called with correct args
  assert.equal(spawnFn.mock.callCount(), 1);
  assert.equal(spawnFn.mock.calls[0].arguments[0], 'test-cli');
  assert.deepEqual(spawnFn.mock.calls[0].arguments[1], ['--json']);
});

test('spawnCli: stdinInput 经 stdin 传入 (stdio[0]=pipe + 写入 child.stdin, 不进 argv)', async () => {
  // Incident 2026-05-29 (cross-thread-context-contamination): prompt 走 stdin 防 ps 泄露。
  let stdinData = '';
  const proc = createMockProcess();
  proc.stdin = {
    write: (c) => {
      stdinData += typeof c === 'string' ? c : c.toString('utf8');
      return true;
    },
    end: () => {},
    on: () => proc.stdin,
  };
  const spawnFn = createMockSpawnFn(proc);

  const SECRET = 'SECRET-prompt-body-披着专业外衣';
  const promise = collect(
    spawnCli({ command: 'test-cli', args: ['exec', '--', '-'], stdinInput: SECRET }, { spawnFn }),
  );
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  const spawnOpts = spawnFn.mock.calls[0].arguments[2];
  assert.equal(spawnOpts.stdio[0], 'pipe', 'stdinInput 设置时 stdio[0] 必须是 pipe');
  assert.equal(stdinData, SECRET, 'stdinInput 必须写入 child.stdin');
  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.some((a) => a.includes(SECRET)), 'stdinInput 内容不得出现在 argv');
});

test('spawnCli: 无 stdinInput 时 stdio[0]=ignore (向后兼容，不影响其它 carrier)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const promise = collect(spawnCli({ command: 'test-cli', args: ['--json'] }, { spawnFn }));
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;
  assert.equal(spawnFn.mock.calls[0].arguments[2].stdio[0], 'ignore');
});

test(
  'spawnCli default spawn supervisors Unix CLI children with parent pid',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const results = await collect(
      spawnCli({
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ type: "env", parentPid: process.env.CAT_CAFE_SUPERVISOR_PARENT_PID ?? null }))',
        ],
        timeoutMs: 5_000,
      }),
    );

    const event = results.find((item) => item?.type === 'env');
    assert.equal(event?.parentPid, String(process.pid));
  },
);

test(
  'spawnCli: stdinInput reaches the supervised child through cli-supervisor (P1 regression)',
  { skip: process.platform === 'win32' && 'cli-supervisor only wraps on Unix' },
  async () => {
    // Incident 2026-05-29 P1 (cloud codex review): production codex runs through
    // cli-supervisor, which MUST forward stdin to the supervised child. Mock-based
    // tests bypass the supervisor (fake spawnFn = child directly), so this real-path
    // test guards the production path — without forwarding, the child gets EOF.
    const SECRET = 'STDIN-VIA-SUPERVISOR-披着专业外衣-R8';
    const results = await collect(
      spawnCli({
        command: process.execPath,
        args: [
          '-e',
          'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"stdin-echo",got:d})+"\\n")})',
        ],
        stdinInput: SECRET,
        timeoutMs: 8000,
      }),
    );
    const echo = results.find((item) => item?.type === 'stdin-echo');
    assert.ok(echo, 'supervised child should emit stdin-echo');
    assert.equal(echo.got, SECRET, 'stdinInput must reach the supervised child through cli-supervisor');
  },
);

test('resolveCliSupervisorNodeArgs falls back to source ts file under tsx runtime', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-cli-supervisor-source-'));
  try {
    const utilsDir = join(tempDir, 'src', 'utils');
    await mkdir(utilsDir, { recursive: true });
    const cliSpawnPath = join(utilsDir, 'cli-spawn.ts');
    const supervisorPath = join(utilsDir, 'cli-supervisor.ts');
    await writeFile(cliSpawnPath, '');
    await writeFile(supervisorPath, '');

    const args = resolveCliSupervisorNodeArgs(pathToFileURL(cliSpawnPath).href, ['--import', 'tsx']);

    assert.deepEqual(args, ['--import', 'tsx', supervisorPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveCliSupervisorNodeArgs drops API env-file execArgv from source ts fallback', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-cli-supervisor-env-file-'));
  try {
    const utilsDir = join(tempDir, 'src', 'utils');
    await mkdir(utilsDir, { recursive: true });
    const cliSpawnPath = join(utilsDir, 'cli-spawn.ts');
    const supervisorPath = join(utilsDir, 'cli-supervisor.ts');
    await writeFile(cliSpawnPath, '');
    await writeFile(supervisorPath, '');

    const args = resolveCliSupervisorNodeArgs(pathToFileURL(cliSpawnPath).href, [
      '--import',
      'tsx',
      '--env-file=.env',
      '--env-file',
      '.env.local',
      '--env-file-if-exists=.env.development',
      '--env-file-if-exists',
      '.env.optional',
      '--trace-warnings',
    ]);

    assert.deepEqual(args, ['--import', 'tsx', '--trace-warnings', supervisorPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveCliSupervisorNodeArgs prefers built js file when present', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-cli-supervisor-dist-'));
  try {
    const utilsDir = join(tempDir, 'dist', 'utils');
    await mkdir(utilsDir, { recursive: true });
    const cliSpawnPath = join(utilsDir, 'cli-spawn.js');
    const supervisorPath = join(utilsDir, 'cli-supervisor.js');
    await writeFile(cliSpawnPath, '');
    await writeFile(supervisorPath, '');

    const args = resolveCliSupervisorNodeArgs(pathToFileURL(cliSpawnPath).href, [
      '--import',
      'tsx',
      '--env-file=.env',
      '--env-file',
      '.env.local',
    ]);

    assert.deepEqual(args, [supervisorPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(
  'cli supervisor terminates supervised child when original parent is gone',
  { skip: process.platform === 'win32' && 'Unix process-group supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-cli-supervisor-'));
    const markerPath = join(tempDir, 'terminated.txt');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = [
      'const fs = require("node:fs");',
      `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(markerPath)}, "SIGTERM"); process.exit(0); });`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let supervisor;
    try {
      supervisor = nodeSpawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_SUPERVISOR_PARENT_PID: '999999',
          CAT_CAFE_SUPERVISOR_POLL_MS: '500',
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '300',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          supervisor.kill('SIGKILL');
          resolve({ timedOut: true, stderr });
        }, 3_000);
        supervisor.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stderr });
        });
      });

      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${exit.stderr}`);
      assert.equal(existsSync(markerPath), true, `child did not receive SIGTERM; stderr=${exit.stderr}`);
      assert.equal(await readFile(markerPath, 'utf8'), 'SIGTERM');
    } finally {
      supervisor?.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'cli supervisor escalates stubborn supervised child before parent kill grace elapses',
  { skip: process.platform === 'win32' && 'Unix process-group supervisor is not used on Windows' },
  async () => {
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = ['process.on("SIGTERM", () => {});', 'setInterval(() => {}, 60_000);'].join('\n');
    const supervisor = nodeSpawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
      env: {
        ...process.env,
        CAT_CAFE_SUPERVISOR_PARENT_PID: '999999',
        CAT_CAFE_SUPERVISOR_POLL_MS: '100',
        CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '150',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    supervisor.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          supervisor.kill('SIGKILL');
          resolve({ timedOut: true, stderr });
        }, 2_000);
        supervisor.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stderr });
        });
      });

      assert.notEqual(exit.timedOut, true, `supervisor did not escalate: ${exit.stderr}`);
      assert.equal(exit.code, 137, `SIGKILL child should surface as 137; stderr=${exit.stderr}`);
    } finally {
      supervisor.kill('SIGKILL');
    }
  },
);

test('spawnCli does not yield stderr data', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stderr.write('DEBUG: some warning\n');
  proc.stdout.write('{"type":"ok"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'ok' });
});

test('spawnCli skips parse errors in stdout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.write('{"valid":true}\n');
  proc.stdout.write('not-json-line\n');
  proc.stdout.write('{"also":"valid"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;

  // Behavioral assertion: parse errors are surfaced as sentinels while valid JSON still passes through
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { valid: true });
  assert.equal(isParseError(results[1]), true);
  assert.equal(results[1].line, 'not-json-line');
  assert.deepEqual(results[2], { also: 'valid' });
});

test('spawnCli plainText mode buffers raw stdout without NDJSON parsing', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: ['--print'], outputMode: 'plainText' }, { spawnFn }));

  proc.stdout.write('plain ');
  proc.stdout.write('response\n');
  proc.stderr.write('debug log\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    __cliPlainText: true,
    stdout: 'plain response\n',
    stderr: 'debug log\n',
    exitCode: 0,
    signal: null,
    command: 'test-cli',
  });
});

test('spawnCli plainText mode waits for close before emitting trailing stderr', async () => {
  const proc = createMockProcess({ autoCloseOnExit: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli({ command: 'agy', args: ['--print', 'hello'], outputMode: 'plainText' }, { spawnFn }),
  );

  proc.stdout.write('plain response\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  setImmediate(() => {
    proc.stderr.write('Error: neither PlanModel nor RequestedModel specified\n');
    proc.stderr.end();
    proc._emitter.emit('close', 0, null);
  });

  const results = await promise;
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    __cliPlainText: true,
    stdout: 'plain response\n',
    stderr: 'Error: neither PlanModel nor RequestedModel specified\n',
    exitCode: 0,
    signal: null,
    command: 'agy',
  });
});

test('spawnCli plainText mode waits for delayed close without fixed fallback', async () => {
  const proc = createMockProcess({ autoCloseOnExit: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli({ command: 'agy', args: ['--print', 'hello'], outputMode: 'plainText' }, { spawnFn }),
  );

  proc.stdout.write('plain response\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  setTimeout(() => {
    proc.stderr.write('Error: delayed diagnostic after exit\n');
    proc.stderr.end();
    proc._emitter.emit('close', 0, null);
  }, 80);

  const results = await promise;
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    __cliPlainText: true,
    stdout: 'plain response\n',
    stderr: 'Error: delayed diagnostic after exit\n',
    exitCode: 0,
    signal: null,
    command: 'agy',
  });
});

test('spawnCli plainText mode drains liveness warnings before stdout closes', async (t) => {
  const stallWarningMs = 120;
  const stallWarning = {
    __livenessWarning: true,
    state: 'idle-silent',
    silenceDurationMs: stallWarningMs,
    level: 'suspected_stall',
    cpuTimeMs: 0,
    processAlive: true,
  };
  let drainCalls = 0;

  t.mock.method(ProcessLivenessProbe.prototype, 'start', () => {});
  t.mock.method(ProcessLivenessProbe.prototype, 'getState', () => 'idle-silent');
  t.mock.method(ProcessLivenessProbe.prototype, 'drainWarnings', () => {
    drainCalls += 1;
    return drainCalls === 2 ? [stallWarning] : [];
  });

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const startedAt = Date.now();

  const promise = collect(
    spawnCli(
      {
        command: 'agy',
        args: ['--print', 'hello'],
        outputMode: 'plainText',
        timeoutMs: 800,
        livenessProbe: {
          sampleIntervalMs: 30,
          softWarningMs: 60,
          stallWarningMs,
          stallAutoKill: true,
        },
      },
      { spawnFn },
    ),
  );

  proc.stdout.write('partial plain text');

  const results = await promise;
  const elapsedMs = Date.now() - startedAt;
  const timeout = results.find(isCliTimeout);
  const warnings = results.filter(isLivenessWarning);

  assert.ok(timeout, 'should yield __cliTimeout event');
  assert.equal(timeout.stallKill, true, 'plainText stall warning should trigger stall auto-kill');
  assert.equal(timeout.timeoutMs, stallWarningMs, 'reported timeout should use stallWarningMs');
  assert.equal(warnings.length, 1, 'plainText path should surface liveness warning before stdout closes');
  assert.ok(elapsedMs < 500, `plainText stallAutoKill should fire before full timeout, took ${elapsedMs}ms`);
  assert.ok(proc.kill.mock.callCount() >= 1, 'should kill process on plainText stall');
});

test('parse-error noise does not reset timeout forever', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 60 }, { spawnFn }));

  const noiseTimer = setInterval(() => {
    if (!proc.stdout.writableEnded) {
      proc.stdout.write('not-json-line\n');
    }
  }, 10);

  // Let timeout fire while noise is still arriving.
  await new Promise((resolve) => setTimeout(resolve, 140));
  clearInterval(noiseTimer);
  if (!proc.stdout.writableEnded) proc.stdout.end();

  const results = await promise;
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true, 'invalid stdout noise should not keep invocation alive');
});

test('spawnCli kills process on timeout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Don't write anything to stdout - let it timeout
  // Wait for timeout to fire, then close stdout
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.stdout.end();

  await promise;

  // Verify kill was called
  assert.ok(proc.kill.mock.callCount() >= 1);
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');
});

test('CLI_TIMEOUT_MS=0 disables timeout (no auto-kill on silence)', async () => {
  const saved = process.env.CLI_TIMEOUT_MS;
  process.env.CLI_TIMEOUT_MS = '0';
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);

    const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

    // Wait longer than our typical small timeout values; should NOT auto-kill
    await new Promise((resolve) => setTimeout(resolve, 120));

    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);

    await promise;

    assert.equal(proc.kill.mock.callCount(), 0, 'should not kill when timeout is disabled');
  } finally {
    if (saved === undefined) {
      delete process.env.CLI_TIMEOUT_MS;
    } else {
      process.env.CLI_TIMEOUT_MS = saved;
    }
  }
});

test('spawnCli uses the configured fallback timeout when CLI_TIMEOUT_MS is unset', async () => {
  const savedEnv = process.env.CLI_TIMEOUT_MS;
  delete process.env.CLI_TIMEOUT_MS;

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const originalSetTimeout = global.setTimeout;
  const delays = [];

  global.setTimeout = (_handler, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(() => {}, 0, ...args);
  };

  try {
    const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
    await promise;

    assert.ok(delays.length > 0);
    assert.equal(delays[0], DEFAULT_CLI_TIMEOUT_MS);
  } finally {
    global.setTimeout = originalSetTimeout;
    if (savedEnv === undefined) {
      delete process.env.CLI_TIMEOUT_MS;
    } else {
      process.env.CLI_TIMEOUT_MS = savedEnv;
    }
  }
});

test('stderr activity does NOT extend timeout (post-fix: stderr is noise, not alive signal)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  // timeoutMs=200: process will time out before stdout at 300ms
  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 200 }, { spawnFn }));

  // stderr at 50ms and 100ms — must NOT extend timeout past 200ms
  await new Promise((resolve) => setTimeout(resolve, 50));
  proc.stderr.write('thinking...\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  proc.stderr.write('still working...\n');

  const results = await promise;

  // Process should time out at ~200ms despite stderr activity
  assert.ok(proc.kill.mock.callCount() >= 1, 'process should be killed — stderr does not extend timeout');
  const timeout = results.find((r) => r?.__cliTimeout);
  assert.ok(timeout, 'should yield __cliTimeout — stderr alone cannot keep process alive');
});

test('spawnCli kills process on abort signal', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const controller = new AbortController();

  const promise = collect(spawnCli({ command: 'test-cli', args: [], signal: controller.signal }, { spawnFn }));

  // Write one event then abort
  proc.stdout.write('{"type":"first"}\n');
  controller.abort();

  // Close stdout after abort
  await new Promise((resolve) => setTimeout(resolve, 50));
  proc.stdout.end();

  const results = await promise;

  // Should have the first event
  assert.ok(results.length >= 1);
  assert.deepEqual(results[0], { type: 'first' });

  // Verify kill was called
  assert.ok(proc.kill.mock.callCount() >= 1);
});

test('spawnCli cleans up on consumer break (early return)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  // Write data before iterating so the loop has something to break on
  proc.stdout.write('{"type":"first"}\n');
  proc.stdout.write('{"type":"second"}\n');

  const results = [];
  for await (const event of spawnCli({ command: 'test-cli', args: [] }, { spawnFn })) {
    results.push(event);
    if (results.length === 1) break; // Consumer stops early
  }

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'first' });

  // Verify kill was called (cleanup via finally)
  assert.ok(proc.kill.mock.callCount() >= 1);
});

test('spawnCli passes cwd and env to spawn', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'claude',
        args: ['-p', 'hello'],
        cwd: '/some/project',
        env: { CUSTOM_VAR: 'value' },
      },
      { spawnFn },
    ),
  );

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  const spawnCall = spawnFn.mock.calls[0];
  assert.equal(spawnCall.arguments[0], 'claude');
  assert.deepEqual(spawnCall.arguments[1], ['-p', 'hello']);
  assert.equal(spawnCall.arguments[2].cwd, '/some/project');
  assert.equal(spawnCall.arguments[2].env.CUSTOM_VAR, 'value');
});

test('spawnCli removes inherited env vars when override is null', async () => {
  const saved = process.env.SPAWN_DELETE_ME;
  process.env.SPAWN_DELETE_ME = 'secret-value';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const promise = collect(
    spawnCli(
      {
        command: 'claude',
        args: ['-p', 'hello'],
        env: { SPAWN_DELETE_ME: null, KEEP_ME: '1' },
      },
      { spawnFn },
    ),
  );

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2].env;
  assert.equal(env.SPAWN_DELETE_ME, undefined);
  assert.equal(Object.hasOwn(env, 'SPAWN_DELETE_ME'), false);
  assert.equal(env.KEEP_ME, '1');

  if (saved === undefined) delete process.env.SPAWN_DELETE_ME;
  else process.env.SPAWN_DELETE_ME = saved;
});

test('spawnCli handles already-aborted signal', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const controller = new AbortController();
  controller.abort(); // Already aborted

  const promise = collect(spawnCli({ command: 'test-cli', args: [], signal: controller.signal }, { spawnFn }));

  proc.stdout.end();
  await promise;

  // Verify kill was called immediately
  assert.ok(proc.kill.mock.callCount() >= 1);
});

test('spawnCli handles empty stdout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  const results = await promise;

  assert.equal(results.length, 0);
});

// === New tests for 缅因猫 review findings ===

test('spawnCli yields __cliError on non-zero exit code >= 2 (stderr sanitized)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.write('{"type":"partial"}\n');
  proc.stderr.write('Error: something went wrong\n');
  proc.stdout.end();
  // Exit code 2 is always a hard error (not soft-exited)
  proc._emitter.emit('exit', 2, null);

  const results = await promise;

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'partial' });

  // Second result should be the CLI error with sanitized message
  assert.equal(isCliError(results[1]), true);
  assert.equal(results[1].exitCode, 2);
  assert.equal(results[1].command, 'test-cli');
  assert.ok(results[1].message.includes('code: 2'));
  assert.ok(!results[1].stderr, 'stderr should not be exposed to users');
});

test('spawnCli yields __cliError for exit code 1 even with valid output (no soft exit in spawnCli)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: ['exec'] }, { spawnFn }));

  // spawnCli always reports non-zero exit as error — soft exit handling
  // is the caller's responsibility (e.g. CodexAgentService)
  proc.stdout.write('{"type":"review","text":"NEEDS_FIX"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'review', text: 'NEEDS_FIX' });
  assert.equal(isCliError(results[1]), true);
  assert.equal(results[1].exitCode, 1);
});

test('spawnCli marks no rollout found stderr as missing_rollout reasonCode', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: ['exec'] }, { spawnFn }));

  proc.stderr.write('Error: no rollout found for session 019d3eca\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;

  assert.equal(results.length, 1);
  assert.equal(isCliError(results[0]), true);
  assert.equal(results[0].reasonCode, 'missing_rollout');
});

test('formatCliExitError propagates reasonCode into message string', async () => {
  const { formatCliExitError } = await import('../dist/utils/cli-format.js');

  // Without reasonCode — unchanged behavior
  assert.equal(
    formatCliExitError('Codex CLI', { exitCode: 1, signal: null, message: 'CLI 异常退出 (code: 1, signal: none)' }),
    'Codex CLI: CLI 异常退出 (code: 1, signal: none)',
  );

  // With reasonCode — appended as tag
  assert.equal(
    formatCliExitError('Codex CLI', {
      exitCode: 1,
      signal: null,
      message: 'CLI 异常退出 (code: 1, signal: none)',
      reasonCode: 'missing_rollout',
    }),
    'Codex CLI: CLI 异常退出 (code: 1, signal: none) [missing_rollout]',
  );
});

test('spawnCli yields __cliError when killed by external signal (stderr sanitized)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stderr.write('Killed by OOM\n');
  proc.stdout.end();
  // External signal kill: exitCode=null, signal=SIGKILL
  proc._emitter.emit('exit', null, 'SIGKILL');

  const results = await promise;

  assert.equal(results.length, 1);
  assert.equal(isCliError(results[0]), true);
  assert.equal(results[0].exitCode, null);
  assert.equal(results[0].signal, 'SIGKILL');
  assert.equal(results[0].command, 'test-cli');
  // message is sanitized — no raw stderr exposed (contains signal info, not raw stderr)
  assert.ok(results[0].message.includes('SIGKILL'));
  assert.ok(!results[0].stderr, 'stderr should not be exposed to users');
});

test('spawnCli yields __cliTimeout (not __cliError) on timeout kill', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Let timeout fire and kill the process
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.stdout.end();

  const results = await promise;

  // Should NOT contain a __cliError (we killed it via timeout)
  const hasCliError = results.some((r) => isCliError(r));
  assert.equal(hasCliError, false);

  // Should contain a __cliTimeout instead
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true);

  const timeout = results.find((r) => isCliTimeout(r));
  assert.equal(timeout.timeoutMs, 50);
  assert.equal(timeout.command, 'test-cli');
});

test('isCliError type guard works correctly', () => {
  assert.equal(isCliError({ __cliError: true, exitCode: 1, message: 'CLI 异常退出', command: 'x' }), true);
  assert.equal(isCliError({ __cliError: false }), false);
  assert.equal(isCliError({ type: 'message' }), false);
  assert.equal(isCliError(null), false);
  assert.equal(isCliError('string'), false);
});

test('isCliTimeout type guard works correctly', () => {
  assert.equal(isCliTimeout({ __cliTimeout: true, timeoutMs: 300000, message: 'CLI 响应超时', command: 'x' }), true);
  assert.equal(isCliTimeout({ __cliTimeout: false }), false);
  assert.equal(isCliTimeout({ __cliError: true }), false);
  assert.equal(isCliTimeout(null), false);
  assert.equal(isCliTimeout('string'), false);
});

test('AbortSignal cancel does NOT yield __cliTimeout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const controller = new AbortController();

  const promise = collect(spawnCli({ command: 'test-cli', args: [], signal: controller.signal }, { spawnFn }));

  // Cancel via AbortSignal (not timeout)
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  proc.stdout.end();

  const results = await promise;

  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, false, 'User cancel should not yield __cliTimeout');
  const hasCliError = results.some((r) => isCliError(r));
  assert.equal(hasCliError, false, 'User cancel should not yield __cliError');
});

test('spawnCli escalates SIGTERM to SIGKILL after grace period', async () => {
  // Create a stubborn process that does NOT exit on SIGTERM
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'stubborn-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Wait for timeout to fire SIGTERM
  await new Promise((resolve) => setTimeout(resolve, 100));

  // First kill should be SIGTERM
  assert.ok(proc.kill.mock.callCount() >= 1);
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');

  // Wait for KILL_GRACE_MS to elapse for escalation
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 100));

  // Should have escalated to SIGKILL
  const killCalls = proc.kill.mock.calls;
  const signals = killCalls.map((c) => c.arguments[0]);
  assert.ok(signals.includes('SIGKILL'), `Expected SIGKILL in signals: ${signals}`);

  // Now actually exit the process so the generator resolves
  proc.stdout.end();
  proc._emitter.emit('exit', null, 'SIGKILL');

  await promise;
});

// === F118: Timeout diagnostic enrichment ===

test('timeout event includes firstEventAt/lastEventAt/lastEventType when events were received', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: [], timeoutMs: 50 }, { spawnFn }));

  // Feed one event then go silent
  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'abc' }) + '\n');

  // Wait for timeout
  // End before silence exceeds the soft threshold: this test verifies that
  // stderr activity resets probe silence, not that a later real quiet period
  // suppresses warnings forever.
  await new Promise((r) => setTimeout(r, 50));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout, 'should have timeout event');
  assert.equal(typeof timeout.firstEventAt, 'number');
  assert.equal(typeof timeout.lastEventAt, 'number');
  assert.equal(timeout.firstEventAt, timeout.lastEventAt, 'only one event — first === last');
  assert.equal(timeout.lastEventType, 'thread.started');
  assert.equal(typeof timeout.silenceDurationMs, 'number');
  assert.ok(timeout.silenceDurationMs >= 40, 'silence should be at least ~timeout ms');
  assert.equal(typeof timeout.processAlive, 'boolean');
});

test('timeout with no events has null firstEventAt/lastEventAt/lastEventType', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: [], timeoutMs: 50 }, { spawnFn }));

  // No events — just wait for timeout
  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.firstEventAt, null);
  assert.equal(timeout.lastEventAt, null);
  assert.equal(timeout.lastEventType, null);
  assert.equal(timeout.silenceDurationMs, timeout.timeoutMs, 'silence = full timeout when no events');
});

test('timeout includes invocationId and cliSessionId when passed in options', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 50,
        invocationId: 'inv-123',
        cliSessionId: 'sess-456',
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.invocationId, 'inv-123');
  assert.equal(timeout.cliSessionId, 'sess-456');
});

test('P1-fix: processAlive reflects state at timeout moment, not after kill', async () => {
  // Process is alive when timeout fires (hasn't exited on its own)
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const promise = collect(spawnCli({ command: 'codex', args: [], timeoutMs: 50 }, { spawnFn }));

  await new Promise((r) => setTimeout(r, 100));
  // Don't manually end stdout — let timeout kill handle it

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout, 'should have timeout event');
  // Process was alive when timeout fired (it hadn't exited on its own)
  assert.equal(timeout.processAlive, true, 'process should be alive at timeout moment');
});

test('timeout omits invocationId/cliSessionId when not provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.invocationId, undefined);
  assert.equal(timeout.cliSessionId, undefined);
});

// === F118 Phase B: Liveness probe integration ===

test('B4: yields alive_but_silent warning during CLI silence', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 2000,
        livenessProbe: { sampleIntervalMs: 100, softWarningMs: 250, stallWarningMs: 1200 },
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 2500));
  proc.stdout.end();

  const results = await promise;
  const warnings = results.filter((e) => e?.__livenessWarning);
  assert.ok(warnings.length > 0, 'should have liveness warnings');
  assert.ok(warnings.some((w) => w.level === 'alive_but_silent'));
});

test('B4 regression: drains pending liveness warning even if stdout closes before next loop drain', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  const originalDrainWarnings = ProcessLivenessProbe.prototype.drainWarnings;
  let releasePendingWarning = false;

  ProcessLivenessProbe.prototype.drainWarnings = function patchedDrainWarnings() {
    if (!releasePendingWarning) return [];
    releasePendingWarning = false;
    return [
      {
        __livenessWarning: true,
        state: 'idle-silent',
        silenceDurationMs: 120,
        level: 'alive_but_silent',
        cpuTimeMs: 0,
        processAlive: true,
      },
    ];
  };

  try {
    proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

    const promise = collect(
      spawnCli(
        {
          command: 'codex',
          args: [],
          timeoutMs: 500,
          livenessProbe: { sampleIntervalMs: 30, softWarningMs: 80, stallWarningMs: 300 },
        },
        { spawnFn },
      ),
    );

    await new Promise((r) => setTimeout(r, 40));
    releasePendingWarning = true;
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);

    const results = await promise;
    const warnings = results.filter((e) => e?.__livenessWarning);
    assert.ok(warnings.some((w) => w.level === 'alive_but_silent'));
  } finally {
    ProcessLivenessProbe.prototype.drainWarnings = originalDrainWarnings;
  }
});

test('B3: dead process triggers immediate cleanup via probe', async () => {
  // Use a PID that doesn't exist — probe should classify as dead
  const proc = createMockProcess({ exitOnKill: false, pid: 99999 });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 5000,
        livenessProbe: { sampleIntervalMs: 30 },
      },
      { spawnFn },
    ),
  );

  // Give probe time to detect dead process
  await new Promise((r) => setTimeout(r, 200));
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  await promise;
  const elapsedMs = Date.now() - startMs;
  assert.ok(elapsedMs < 2000, `should finish quickly (${elapsedMs}ms), not wait for 5s timeout`);
});

test('timeout includes rawArchivePath when passed in options', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 50,
        rawArchivePath: '/data/cli-raw-archive/2026-03-14/inv-123.ndjson',
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.rawArchivePath, '/data/cli-raw-archive/2026-03-14/inv-123.ndjson');
});

test('P1-fix: probe race timer is cleaned up when NDJSON wins', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  let clearCount = 0;
  const origClearTimeout = global.clearTimeout;
  global.clearTimeout = (timer) => {
    clearCount++;
    return origClearTimeout(timer);
  };

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 5000,
        livenessProbe: { sampleIntervalMs: 200 },
      },
      { spawnFn },
    ),
  );

  // Rapid-fire 10 events — each should win the race and clear the timer
  for (let i = 0; i < 10; i++) {
    proc.stdout.write(JSON.stringify({ type: 'msg', i }) + '\n');
    await new Promise((r) => setTimeout(r, 5));
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  global.clearTimeout = origClearTimeout;
  // Each NDJSON event that wins the race should clearTimeout the probe timer
  assert.ok(clearCount >= 10, `clearTimeout should be called at least 10 times, got ${clearCount}`);
});

test('Post-fix: stderr activity does NOT suppress alive_but_silent warnings', async () => {
  // Post-fix invariant: stderr is not user-visible output and should NOT reset
  // probe silence tracking. alive_but_silent warnings should fire based on
  // stdout/NDJSON silence, regardless of stderr activity.
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 500,
        livenessProbe: { sampleIntervalMs: 30, softWarningMs: 100, stallWarningMs: 1000 },
      },
      { spawnFn },
    ),
  );

  // Keep stderr active but stdout silent — should NOT suppress probe warnings
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 40));
    proc.stderr.write(`thinking step ${i}...\n`);
  }

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;
  const warnings = results.filter((e) => e?.__livenessWarning);
  const silentWarnings = warnings.filter((w) => w.level === 'alive_but_silent');
  assert.ok(silentWarnings.length > 0, 'stderr alone should NOT suppress alive_but_silent warnings');
});

test('spawnCli handles spawn error (e.g. command not found)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const gen = spawnCli({ command: 'nonexistent-command', args: [] }, { spawnFn });

  // Emit error before any stdout data
  process.nextTick(() => {
    const err = new Error('spawn nonexistent-command ENOENT');
    err.code = 'ENOENT';
    proc._emitter.emit('error', err);
    proc.stdout.end();
    proc._emitter.emit('exit', null, null);
  });

  await assert.rejects(
    async () => {
      for await (const _ of gen) {
        /* consume */
      }
    },
    (err) => {
      assert.ok(err.message.includes('ENOENT'));
      return true;
    },
  );
});

// F118 Phase C: isLivenessWarning type guard
test('isLivenessWarning returns true for valid warning events', () => {
  const warning = {
    __livenessWarning: true,
    state: 'busy-silent',
    silenceDurationMs: 125000,
    level: 'alive_but_silent',
    processAlive: true,
  };
  assert.ok(isLivenessWarning(warning));
});

test('isLivenessWarning returns false for non-warning objects', () => {
  assert.ok(!isLivenessWarning({ type: 'text', content: 'hello' }));
  assert.ok(!isLivenessWarning(null));
  assert.ok(!isLivenessWarning(42));
  assert.ok(!isLivenessWarning({ __livenessWarning: false }));
});

// === Issue #116: Semantic completion decoupled from process exit ===

test('Group A: semanticCompletionSignal aborted → generator finishes without waiting for exit', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec', '--json'],
        timeoutMs: 10_000,
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
  proc.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100 } }) + '\n');

  semanticController.abort();
  proc.stdout.end();

  // Simulate process exiting naturally during grace period (e.g. git push finishes)
  setTimeout(() => proc._emitter.emit('exit', 0, null), 200);

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  // Should finish after process exits (~200ms), not wait for full timeout (10s)
  assert.ok(elapsedMs < 2000, `Should finish once process exits during grace, took ${elapsedMs}ms`);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'thread.started', thread_id: 't1' });
  assert.deepEqual(results[1], { type: 'turn.completed', usage: { input_tokens: 100 } });
});

test('Group A: semanticCompletionSignal skips __cliError for post-completion exit', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'item.completed', text: 'hello' }) + '\n');
  semanticController.abort();
  proc.stdout.end();

  // Process exits with non-zero during grace (Codex CLI quirk)
  setTimeout(() => proc._emitter.emit('exit', 1, null), 100);

  const results = await promise;

  const hasCliError = results.some((r) => isCliError(r));
  assert.equal(hasCliError, false, 'Post-semantic-completion exit error should be suppressed');

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'item.completed', text: 'hello' });
});

test('Group B: no semanticCompletionSignal → generator waits for exit (existing behavior)', async () => {
  const proc = createMockProcess({ exitOnKill: true });
  const spawnFn = createMockSpawnFn(proc);

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        timeoutMs: 200,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
  proc.stdout.end();

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(elapsedMs >= 150, `Should wait for timeout (~200ms), only took ${elapsedMs}ms`);
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true, 'Without semanticCompletionSignal, should wait for exit and eventually timeout');
});

test('Group B: semanticCompletionSignal not aborted → still waits for exit', async () => {
  const proc = createMockProcess({ exitOnKill: true });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        timeoutMs: 200,
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
  proc.stdout.end();

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(elapsedMs >= 150, `Should wait for timeout (~200ms), only took ${elapsedMs}ms`);
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true, 'Un-aborted semanticCompletionSignal should behave like no signal');
});

test('Group A: lingering process is killed after grace period expires', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        timeoutMs: 60_000,
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  semanticController.abort();
  proc.stdout.end();

  // Process never exits — grace timer (SEMANTIC_COMPLETION_GRACE_MS) should expire,
  // then killChild() in finally should fire SIGTERM.
  // Emit exit after kill so generator can resolve.
  const exitAfterKill = () => {
    if (proc.kill.mock.callCount() > 0) {
      proc._emitter.emit('exit', null, 'SIGTERM');
    } else {
      setTimeout(exitAfterKill, 50);
    }
  };
  setTimeout(exitAfterKill, 100);

  const startMs = Date.now();
  await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(proc.kill.mock.callCount() >= 1, 'Should kill lingering process after grace');
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');
  assert.ok(
    elapsedMs >= SEMANTIC_COMPLETION_GRACE_MS - 500,
    `Should wait for grace period (~${SEMANTIC_COMPLETION_GRACE_MS}ms), took ${elapsedMs}ms`,
  );
});

// === Issue #774: stallAutoKill — fast-fail on idle-silent stall ===

test('#774: stallAutoKill kills process on suspected_stall + idle-silent instead of waiting for full timeout', async (t) => {
  const stallWarningMs = 200;
  const stallWarning = {
    __livenessWarning: true,
    state: 'idle-silent',
    silenceDurationMs: stallWarningMs,
    level: 'suspected_stall',
    cpuTimeMs: 0,
    processAlive: true,
  };
  let drainCalls = 0;

  // Keep the test deterministic under full-suite CPU pressure: #774 is about
  // spawnCli's reaction to a suspected_stall warning, not ps sampling latency.
  t.mock.method(ProcessLivenessProbe.prototype, 'start', () => {});
  t.mock.method(ProcessLivenessProbe.prototype, 'getState', () => 'idle-silent');
  t.mock.method(ProcessLivenessProbe.prototype, 'drainWarnings', () => {
    drainCalls += 1;
    return drainCalls === 2 ? [stallWarning] : [];
  });

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const resultsPromise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 10_000, // Full timeout must not be the reported timeout when stallAutoKill fires.
        livenessProbe: {
          sampleIntervalMs: 30,
          softWarningMs: 80,
          stallWarningMs,
          stallAutoKill: true, // #774: enable fast-fail
        },
      },
      { spawnFn },
    ),
  );

  // Simulate Codex pattern: one event then total silence.
  proc.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

  const results = await resultsPromise;

  const timeout = results.find((r) => r?.__cliTimeout);
  assert.ok(timeout, 'should yield __cliTimeout event');
  assert.equal(timeout.stallKill, true, 'should have stallKill: true');
  assert.equal(timeout.timeoutMs, stallWarningMs, 'reported timeout should use stallWarningMs, not full timeoutMs');

  assert.ok(proc.kill.mock.callCount() >= 1, 'should kill process on stall');
});

test('#774: stallAutoKill=false (default) does NOT kill on stall — waits for full timeout', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 300, // short timeout for test speed
        livenessProbe: {
          sampleIntervalMs: 30,
          softWarningMs: 50,
          stallWarningMs: 100,
          // stallAutoKill NOT set — should NOT kill early
        },
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 500));
  if (!proc.stdout.writableEnded) proc.stdout.end();

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  // Should wait for the full 300ms timeout, not the 100ms stall
  assert.ok(elapsedMs >= 250, `Should wait for full timeout (${elapsedMs}ms), not stall-kill early`);

  const timeout = results.find((r) => r?.__cliTimeout);
  assert.ok(timeout, 'should yield __cliTimeout from normal timeout');
  assert.equal(timeout.stallKill, undefined, 'should NOT have stallKill flag');
});

test('#774: process is killed when only stderr is active (stderr must not keep probe alive)', async () => {
  // Post-fix invariant: stderr is not user-visible output and must NOT reset
  // probe silence tracking. The process should be killed (by stall or timeout)
  // even with continuous stderr activity.
  // Note: with pid=process.pid, CPU sampling sees test process activity,
  // so probe may classify as busy-silent → CLI timeout fires instead of
  // stallAutoKill. Either way, the key invariant holds: process gets killed.
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

  const promise = collect(
    spawnCli(
      {
        command: 'claude',
        args: [],
        timeoutMs: 1000,
        livenessProbe: {
          sampleIntervalMs: 30,
          softWarningMs: 80,
          stallWarningMs: 150,
          stallAutoKill: true,
        },
      },
      { spawnFn },
    ),
  );

  // Simulate stderr chatter — this should NOT prevent timeout/kill
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 40));
    proc.stderr.write(`thinking step ${i}...\n`);
  }

  const results = await promise;

  // Post-fix: process MUST be killed — stderr does not extend lifetime indefinitely
  const timeout = results.find((r) => r?.__cliTimeout);
  assert.ok(timeout, 'process must be killed when only stderr is active (no NDJSON output)');
});

test('#774 R2: deferred stall-kill is cancelled when NDJSON recovery arrives before next probe timer', async () => {
  // The deferred pattern: stall warning drained → pendingStallKill=true → race.
  // If NDJSON wins the race → pendingStallKill=false (kill cancelled).
  // If probe timer wins → kill fires.
  //
  // Key: sampleIntervalMs must be wide enough that recovery NDJSON reliably
  // arrives within the race window. Using 100ms intervals gives a 100ms window.
  //
  // Timeline:
  //   T=0:    turn.started processed
  //   T=100:  probe samples → stall queued (silence=100ms > stallWarningMs=40ms)
  //   T=200:  race timer wins → drains stall → pendingStallKill=true → race (100ms timer)
  //   T=250:  recovery NDJSON arrives → NDJSON wins race → pendingStallKill=false
  //   T=300+: session completes normally
  const sleeper = (await import('node:child_process')).spawn('sleep', ['60']);
  try {
    const proc = createMockProcess({ pid: sleeper.pid });
    const spawnFn = createMockSpawnFn(proc);

    proc.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');

    const promise = collect(
      spawnCli(
        {
          command: 'codex',
          args: [],
          timeoutMs: 5000,
          livenessProbe: {
            sampleIntervalMs: 100, // wide race window for reliable test
            softWarningMs: 20,
            stallWarningMs: 40,
            stallAutoKill: true,
          },
        },
        { spawnFn },
      ),
    );

    // Wait for stall to be detected + drained + pendingStallKill set (~200ms)
    // then send recovery within the 100ms race window
    await new Promise((r) => setTimeout(r, 250));
    proc.stdout.write(JSON.stringify({ type: 'item.completed', id: 'recovered' }) + '\n');

    // Immediately complete the session so no further stall warnings can fire
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);

    const results = await promise;

    const timeout = results.find((r) => r?.__cliTimeout);
    assert.equal(timeout, undefined, 'deferred stall-kill must be cancelled by recovery NDJSON');
    assert.ok(
      results.some((r) => r?.type === 'turn.completed'),
      'should yield turn.completed from the recovered session',
    );
  } finally {
    sleeper.kill();
  }
});

// =============================================================================
// F212 Phase A — cliDiagnostics on __cliError / __cliTimeout (AC-A1, A7, A8, A9)
// =============================================================================

test('F212 AC-A1: __cliError includes cliDiagnostics with reasonCode for known stderr', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: ['exec'], invocationId: 'inv-A1' }, { spawnFn }));
  proc.stderr.write('Error: no rollout found for session abc\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.ok(err, 'expected __cliError');
  assert.ok(err.cliDiagnostics, 'cliDiagnostics field must be present');
  assert.equal(err.cliDiagnostics.reasonCode, 'missing_rollout');
  assert.ok(err.cliDiagnostics.safeExcerpt, 'safeExcerpt should be filled for known reasonCode');
  assert.ok(err.cliDiagnostics.publicSummary.length > 0);
  assert.ok(err.cliDiagnostics.publicHint.length > 0);
  assert.equal(err.cliDiagnostics.debugRef.command, 'codex');
  assert.equal(err.cliDiagnostics.debugRef.exitCode, 1);
  assert.equal(err.cliDiagnostics.debugRef.invocationId, 'inv-A1');
});

test('F212 AC-A1: __cliError for unknown stderr has cliDiagnostics with sanitized safeExcerpt (#857)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));
  proc.stderr.write('completely random weird thing\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 2, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.ok(err);
  assert.ok(err.cliDiagnostics);
  assert.equal(err.cliDiagnostics.reasonCode, undefined);
  // #857: unknown raw text now surfaced as sanitized safeExcerpt
  assert.ok(err.cliDiagnostics.safeExcerpt, 'unknown stderr should produce safeExcerpt (#857)');
  assert.equal(err.cliDiagnostics.excerptSource, 'unknown_raw');
  assert.match(err.cliDiagnostics.publicSummary, /未识别/);
});

test('F212 AC-A9 红线: __cliError.message does NOT contain raw stderr', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));
  const secret = 'super-secret-panic-marker-7f3xq';
  proc.stderr.write(`${secret}\n`);
  proc.stdout.end();
  proc._emitter.emit('exit', 2, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.ok(err);
  assert.ok(!err.message.includes(secret), `message leaked raw stderr: ${err.message}`);
  // Also check cliDiagnostics 公共面板字段不漏
  assert.ok(!err.cliDiagnostics.publicSummary.includes(secret));
  assert.ok(!err.cliDiagnostics.publicHint.includes(secret));
});

test('F212 (云端 codex P2): maybeCollectStreamError extracts Error.message (non-enumerable)', async () => {
  // 砚砚 round-3 catch: prior version of this test used a JSON plain object, which JSON.stringify
  // serializes correctly even without the fix. The real bug surfaces only when `evt.error` is a
  // genuine Error instance — name/message/stack are non-enumerable on Error.prototype and would
  // serialize to `{}`. Test the pure helper directly to exercise the actual failure mode.
  const { maybeCollectStreamError } = await import('../dist/utils/cli-spawn.js');
  const sink = [];
  const evt = { type: 'error', error: new Error('401 Unauthorized') };
  maybeCollectStreamError(evt, sink);
  assert.equal(sink.length, 1, 'expected one collected entry');
  assert.ok(
    sink[0].includes('401 Unauthorized'),
    `Error.message must survive non-enumerable serialization; got: ${sink[0]}`,
  );
  // Verify the classifier can actually reach the reasonCode from the extracted text
  const { classifyCliError } = await import('../dist/utils/cli-diagnostics.js');
  assert.equal(
    classifyCliError(sink[0]),
    'auth_failed',
    `classifier must classify extracted text; got: ${classifyCliError(sink[0])}`,
  );
});

test('F212 (云端 codex P2): maybeCollectStreamError extracts plain object error fields', async () => {
  // Regression: plain {error:{name,message,data:{message,statusCode}}} should also work.
  const { maybeCollectStreamError } = await import('../dist/utils/cli-spawn.js');
  const sink = [];
  maybeCollectStreamError(
    {
      type: 'error',
      error: { name: 'APIError', data: { message: 'model not supported', statusCode: 400 } },
    },
    sink,
  );
  assert.equal(sink.length, 1);
  assert.ok(sink[0].includes('model not supported'));
  assert.ok(sink[0].includes('400'));
});

test('F212 (云端 codex P2): maybeCollectStreamError ignores non-error events', async () => {
  const { maybeCollectStreamError } = await import('../dist/utils/cli-spawn.js');
  const sink = [];
  maybeCollectStreamError({ type: 'text', content: 'hello' }, sink);
  maybeCollectStreamError(null, sink);
  maybeCollectStreamError(undefined, sink);
  maybeCollectStreamError('string', sink);
  assert.equal(sink.length, 0, 'non-error events must not be collected');
});

test('F212 (云端 codex round-5 P2): maybeCollectStreamError bounds sink entries', async () => {
  // Long-running session emitting many error events must not grow sink unbounded.
  const { maybeCollectStreamError } = await import('../dist/utils/cli-spawn.js');
  const sink = [];
  // Push 100 small error events; cap is 50 entries.
  for (let i = 0; i < 100; i++) {
    maybeCollectStreamError({ type: 'error', error: { message: `err ${i}` } }, sink);
  }
  assert.ok(sink.length <= 50, `sink.length must be ≤50 entries; got ${sink.length}`);
});

test('F212 (云端 codex round-5 P2): maybeCollectStreamError bounds total chars', async () => {
  // Single huge error event must not push beyond 16384 chars total.
  const { maybeCollectStreamError } = await import('../dist/utils/cli-spawn.js');
  const sink = [];
  const huge = 'A'.repeat(20000); // 20KB single message
  maybeCollectStreamError({ type: 'error', error: { message: huge } }, sink);
  const total = sink.reduce((sum, s) => sum + s.length, 0);
  assert.ok(total <= 16384, `total chars must be ≤16384; got ${total}`);
});

test('F212 AC-A8: NDJSON stream error event triggers cliDiagnostics.reasonCode', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'opencode', args: [] }, { spawnFn }));
  // Simulate opencode CLI emitting an NDJSON error event with APIError payload (issue #777 reproducer)
  proc.stdout.write(
    JSON.stringify({
      type: 'error',
      error: {
        name: 'APIError',
        data: {
          message:
            'The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-v-4.',
          statusCode: 400,
        },
      },
    }) + '\n',
  );
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.ok(err);
  assert.ok(err.cliDiagnostics);
  // Stream error message contains "supported API model names" → model_not_found
  assert.equal(err.cliDiagnostics.reasonCode, 'model_not_found');
});

// =============================================================================
// F212 Phase F — Empty-stderr observability follow-up (砚砚 catch + CVO 2026-05-30)
// =============================================================================

// Test stub helper for P1-1 (砚砚 R1): captures log calls so we can assert the actual
// backend-log contract (AC-F1 unconditional 'CLI abnormal exit' + AC-F3 invocationId in
// stderr log). Without this stub, AC-F6 tests only proved publicHint behavior and the
// log.error lines could be deleted without test failure — exactly the gap 砚砚 caught.
function createLogStub() {
  const calls = [];
  return {
    stub: { error: (payload, msg) => calls.push({ payload, msg }) },
    calls,
    callsByMsg: (msg) => calls.filter((c) => c.msg === msg),
  };
}

test('F212 Phase F (AC-F1 + AC-F6, 砚砚 P1-1): abnormal exit writes "CLI abnormal exit" log UNCONDITIONALLY with full payload (empty stderr)', async () => {
  delete process.env.LOG_CLI_STDERR;
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);
  const { stub, callsByMsg } = createLogStub();

  const promise = collect(
    spawnCli(
      { command: 'codex.cmd', args: ['exec'], invocationId: 'inv-empty-windows', diagnosticLogger: stub },
      { spawnFn },
    ),
  );
  // No stderr — Windows codex.cmd empty-stderr case
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);
  await promise;

  // P1-1: assert the actual log was written (not just inferred from publicHint)
  const abnormalLogs = callsByMsg('CLI abnormal exit');
  assert.equal(abnormalLogs.length, 1, 'exactly one CLI abnormal exit log per abnormal exit');
  const payload = abnormalLogs[0].payload;
  // Full F1 payload contract verified — deleting any field below makes this fail
  assert.equal(payload.invocationId, 'inv-empty-windows', 'invocationId in log (砚砚 P1-1: was untested)');
  assert.equal(payload.command, 'codex.cmd');
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.signal, null);
  assert.equal(payload.stderrEmpty, true, 'empty-stderr flag — the Windows codex.cmd 死胡同 case');
  assert.equal(payload.streamErrorCount, 0);
  // P1-2: cwd MUST NOT leak into payload even though production code passes it
  assert.ok(!('cwd' in payload), `cwd MUST NOT appear in log (砚砚 P1-2 安全边界): ${JSON.stringify(payload)}`);
});

test('F212 Phase F (AC-F2 scope): "CLI abnormal exit" log fires when LOG_CLI_STDERR is UNSET (gate doesn\'t bleed)', async () => {
  delete process.env.LOG_CLI_STDERR;
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);
  const { stub, callsByMsg } = createLogStub();

  const promise = collect(
    spawnCli({ command: 'codex', args: [], invocationId: 'inv-gate-unset', diagnosticLogger: stub }, { spawnFn }),
  );
  proc.stderr.write('Some stderr content\n'); // non-empty stderr
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);
  await promise;

  // AC-F2: env gate does NOT control whether 'CLI abnormal exit' fires
  assert.equal(callsByMsg('CLI abnormal exit').length, 1, "'CLI abnormal exit' fires regardless of env gate");
  // The stderr log IS gated by LOG_CLI_STDERR — unset → no stderr log
  assert.equal(callsByMsg('CLI stderr (LOG_CLI_STDERR=1)').length, 0, 'stderr log gated off when LOG_CLI_STDERR unset');
});

test('F212 Phase F (AC-F3, 砚砚 P1-1): stderr log payload includes invocationId for cross-log correlation', async () => {
  process.env.LOG_CLI_STDERR = '1'; // enable stderr log so we can inspect its payload
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);
  const { stub, callsByMsg } = createLogStub();

  const promise = collect(
    spawnCli({ command: 'codex', args: [], invocationId: 'inv-stderr-log-id', diagnosticLogger: stub }, { spawnFn }),
  );
  proc.stderr.write('401 Unauthorized\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);
  await promise;
  delete process.env.LOG_CLI_STDERR;

  const stderrLogs = callsByMsg('CLI stderr (LOG_CLI_STDERR=1)');
  assert.equal(stderrLogs.length, 1, 'stderr log fires when env=1');
  // AC-F3 P1-1: invocationId in payload — deleting this assertion would let us regress
  assert.equal(
    stderrLogs[0].payload.invocationId,
    'inv-stderr-log-id',
    'invocationId in stderr log so frontend debugRef.invocationId can grep to this entry',
  );
});

// F212 Phase F (砚砚 R2 post-merge follow-up): timeout branch was missing the same fixes
// as abnormal-exit branch — buildCliDiagnostics call had no stderrEmpty (AC-F4 dead-end
// reappears) + timeout stderr log used module log directly (AC-F3 contract untestable).
// Without these tests, removing stderrEmpty pass-through OR removing diagnosticLogger
// injection in timeout branch would not be caught by the existing AC-F3/F4 suite.

test('F212 Phase F (AC-F4, 砚砚 R2 P1): timeout + empty stderr + unknown → honest hint, NO LOG_CLI_STDERR dangle', async () => {
  delete process.env.LOG_CLI_STDERR;
  const proc = createMockProcess(); // default exitOnKill — kills on timeout
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli({ command: 'codex.cmd', args: [], timeoutMs: 50, invocationId: 'inv-timeout-empty' }, { spawnFn }),
  );
  // Let timeout fire, then close stdout so the generator returns
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find((r) => r?.__cliTimeout);
  assert.ok(timeout, 'should yield __cliTimeout when no stderr + timeout fires');
  assert.equal(timeout.cliDiagnostics.reasonCode, undefined, 'unknown classifier (empty rawText)');
  // Same AC-F4 assertions as abnormal-exit branch
  assert.ok(
    timeout.cliDiagnostics.publicHint.includes('没有输出 stderr'),
    `timeout empty-stderr hint must mention "没有输出 stderr": ${timeout.cliDiagnostics.publicHint}`,
  );
  assert.ok(
    timeout.cliDiagnostics.publicHint.includes('invocationId'),
    `timeout empty-stderr hint must mention invocationId: ${timeout.cliDiagnostics.publicHint}`,
  );
  // Critical regression guard: do NOT dangle LOG_CLI_STDERR=1 false hope
  assert.ok(
    !timeout.cliDiagnostics.publicHint.includes('LOG_CLI_STDERR'),
    `timeout empty-stderr hint must NOT mention LOG_CLI_STDERR (would resurface dead-end UX): ${timeout.cliDiagnostics.publicHint}`,
  );
});

test('F212 Phase F (AC-F3, 砚砚 R2 P1): timeout stderr log routes through diagnosticLogger + carries invocationId', async () => {
  process.env.LOG_CLI_STDERR = '1';
  const proc = createMockProcess(); // default exitOnKill — kills on timeout
  const spawnFn = createMockSpawnFn(proc);
  const { stub, callsByMsg } = createLogStub();

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 50,
        invocationId: 'inv-timeout-stderr-id',
        diagnosticLogger: stub,
      },
      { spawnFn },
    ),
  );
  // Write stderr BEFORE timeout fires so the branch sees non-empty stderr and emits the log
  proc.stderr.write('401 Unauthorized\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.stdout.end();
  await promise;
  delete process.env.LOG_CLI_STDERR;

  // AC-F3 spec: 'CLI stderr on timeout (LOG_CLI_STDERR=1)' MUST also flow through the
  // stub (R2 P1 catch was: was hard-using module log → stub silent → contract untestable)
  const timeoutStderrLogs = callsByMsg('CLI stderr on timeout (LOG_CLI_STDERR=1)');
  assert.equal(timeoutStderrLogs.length, 1, 'timeout stderr log MUST route through diagnosticLogger (R2 P1 fix)');
  assert.equal(
    timeoutStderrLogs[0].payload.invocationId,
    'inv-timeout-stderr-id',
    'invocationId in timeout stderr log payload (AC-F3 contract)',
  );
});

test('F212 Phase F (AC-F4): exit 1 + empty stderr → cliDiagnostics carries empty-stderr honest hint (no LOG_CLI_STDERR mention)', async () => {
  delete process.env.LOG_CLI_STDERR;
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli({ command: 'codex.cmd', args: ['exec'], invocationId: 'inv-empty-windows' }, { spawnFn }),
  );
  // No stderr — replicates Windows codex.cmd exit 1 case
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.ok(err, 'should yield __cliError on exit 1');
  assert.equal(err.exitCode, 1);
  // unknown reasonCode (no rawText to classify)
  assert.equal(err.cliDiagnostics.reasonCode, undefined);
  // F4: hint mentions empty stderr + invocationId + suggests running CLI directly
  assert.ok(
    err.cliDiagnostics.publicHint.includes('没有输出 stderr'),
    `hint should mention empty stderr: ${err.cliDiagnostics.publicHint}`,
  );
  assert.ok(
    err.cliDiagnostics.publicHint.includes('invocationId'),
    `hint should mention invocationId search: ${err.cliDiagnostics.publicHint}`,
  );
  // Critical: hint must NOT dangle LOG_CLI_STDERR=1 false hope
  assert.ok(
    !err.cliDiagnostics.publicHint.includes('LOG_CLI_STDERR'),
    `hint must NOT mention LOG_CLI_STDERR for empty stderr: ${err.cliDiagnostics.publicHint}`,
  );
});

test('F212 Phase F (AC-F5): exit 1 + non-empty unclassified stderr → cliDiagnostics points to env-summary endpoint (NO absolute path)', async () => {
  delete process.env.LOG_CLI_STDERR;
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli({ command: 'opencode', args: [], invocationId: 'inv-nonempty-unknown' }, { spawnFn }),
  );
  // Non-empty but non-classifiable stderr
  proc.stderr.write('Some unfamiliar tool-specific error text\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.ok(err, 'should yield __cliError on exit 1');
  assert.equal(err.cliDiagnostics.reasonCode, undefined);
  // F5: hint points users to env-summary (NOT absolute path)
  assert.ok(
    err.cliDiagnostics.publicHint.includes('env-summary'),
    `hint should point to env-summary: ${err.cliDiagnostics.publicHint}`,
  );
  assert.ok(
    err.cliDiagnostics.publicHint.includes('runtimeLogs'),
    `hint should mention runtimeLogs key: ${err.cliDiagnostics.publicHint}`,
  );
  // F212 safety: NO absolute path leak in hint
  assert.ok(
    !err.cliDiagnostics.publicHint.match(/\/Users\/|\/home\/|C:\\\\/),
    `hint must NOT contain absolute path: ${err.cliDiagnostics.publicHint}`,
  );
});

test('F212 AC-A7: stderr NOT logged when LOG_CLI_STDERR unset (default)', async () => {
  // We can't easily stub the module logger, so smoke-test that no exception is thrown
  // and that __cliError still emits cliDiagnostics correctly.
  delete process.env.LOG_CLI_STDERR;
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));
  proc.stderr.write('401 Unauthorized: invalid api key sk-AbCdEfGh1234567890IjKlMnOpQr\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;
  const err = results.find((r) => r?.__cliError);
  assert.equal(err.cliDiagnostics.reasonCode, 'auth_failed');
  // safeExcerpt must have token redacted (KD-2 contract)
  assert.ok(!err.cliDiagnostics.safeExcerpt.includes('AbCdEfGh1234567890'));
  assert.ok(err.cliDiagnostics.safeExcerpt.includes('[TOKEN_REDACTED]'));
});

test('F212 AC-A1: __cliTimeout also carries cliDiagnostics', async () => {
  // Timeout path also needs cliDiagnostics for frontend rendering consistency.
  // Use a short timeout to trigger __cliTimeout quickly.
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));
  // Don't write anything → timeout fires
  // Mock process never exits; race against timeout
  setTimeout(() => {
    proc.stderr.write('ETIMEDOUT after wait\n');
    proc.stdout.end();
    proc._emitter.emit('exit', null, 'SIGTERM');
  }, 200);

  const results = await promise;
  const to = results.find((r) => r?.__cliTimeout);
  if (to) {
    assert.ok(to.cliDiagnostics, '__cliTimeout should also carry cliDiagnostics');
    assert.equal(to.cliDiagnostics.debugRef.command, 'test-cli');
  }
  // If __cliError fired instead (signal kill), it should also have cliDiagnostics
  const err = results.find((r) => r?.__cliError);
  if (err) {
    assert.ok(err.cliDiagnostics);
  }
  // At least one of them must have happened
  assert.ok(to || err, 'expected either __cliTimeout or __cliError');
});
