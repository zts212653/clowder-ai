import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';

const runNative = process.env.RUN_F306_READONLY_LIVE === '1' && process.platform === 'darwin';
const live = { skip: runNative ? false : 'explicit macOS native sandbox acceptance; run RUN_F306_READONLY_LIVE=1' };

function processes() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), parent: Number(match[2]), state: match[3], command: match[4] } : null;
    })
    .filter(Boolean);
}

async function waitForProcesses(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = predicate(processes());
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('owned native process condition did not become true');
}

test('same Python/Node statistics command is restored under native readonly constraints', live, async () => {
  const root = mkdtempSync(join(tmpdir(), 'f306-statistics-runtime-'));
  const runtime = join(root, 'cat-cafe-runtime');
  mkdirSync(runtime);
  const data = join(runtime, 'statistics.json');
  writeFileSync(data, JSON.stringify([2, 3, 5]));
  try {
    for (const command of [
      `python3 -c 'import json; print(sum(json.load(open("${data}"))))'`,
      `node -e 'console.log(JSON.parse(require("node:fs").readFileSync("${data}","utf8")).reduce((a,b)=>a+b,0))'`,
    ]) {
      const old = decideNativeHookPayload({ tool_name: 'Bash', cwd: runtime, tool_input: { command } });
      assert.equal(old.decision, 'deny', 'opaque interpreter does not gain an argv read exemption');
      const result = await new ManagedRunner().launch(command, {
        cwd: runtime,
        executionPolicy: 'read_only',
        timeoutMs: 5000,
      });
      assert.equal(result.exitCode, 0, result.tailOutput);
      assert.equal(result.tailOutput.trim(), '10');
      assert.equal(readFileSync(data, 'utf8'), '[2,3,5]');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readonly child cannot write, delete, signal an external peer or contact loopback', live, async () => {
  const root = mkdtempSync(join(tmpdir(), 'f306-native-boundaries-'));
  const sentinel = join(root, 'sentinel');
  writeFileSync(sentinel, 'BEFORE');
  let connections = 0,
    signalled = false;
  const server = createServer((_request, response) => {
    connections++;
    response.end('UNEXPECTED');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const peer = spawn(process.execPath, [
    '-e',
    'process.on("SIGUSR1",()=>console.log("SIGNALLED"));console.log("READY");setInterval(()=>{},1000)',
  ]);
  peer.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('SIGNALLED')) signalled = true;
  });
  await once(peer.stdout, 'data');
  const port = server.address().port;
  try {
    for (const command of [
      `python3 -c 'open("${sentinel}","w").write("CHANGED")'`,
      `python3 -c 'import os; os.unlink("${sentinel}")'`,
      `python3 -c 'import subprocess; subprocess.run(["/bin/sh","-c","printf CHILD > ${sentinel}"],check=True)'`,
      `python3 -c 'import socket; socket.create_connection(("127.0.0.1",${port}),1)'`,
      `python3 -c 'import os,signal; os.kill(${peer.pid},signal.SIGUSR1)'`,
    ]) {
      const result = await new ManagedRunner().launch(command, {
        cwd: root,
        executionPolicy: 'read_only',
        timeoutMs: 5000,
      });
      assert.notEqual(result.exitCode, 0, command);
      assert.match(result.tailOutput, /not permitted|EPERM|EACCES/i);
      assert.equal(readFileSync(sentinel, 'utf8'), 'BEFORE');
    }
    assert.equal(connections, 0);
    assert.equal(signalled, false);
  } finally {
    peer.kill();
    await once(peer, 'close');
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('callback, provider, proxy and shell startup values do not return through final spawn', live, async () => {
  const keys = [
    'F306_CALLBACK_SENTINEL',
    'OPENAI_API_KEY',
    'HTTP_PROXY',
    'NODE_OPTIONS',
    'BASH_ENV',
    'PYTHONPATH',
    'CAT_CAFE_DEPLOYMENT_ID',
    'F306_ARBITRARY_AMBIENT_VALUE',
  ];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'synthetic-do-not-inherit';
    const code = `import os,json; print(json.dumps([k for k in ${JSON.stringify(keys)} if k in os.environ]))`;
    const result = await new ManagedRunner().launch(`python3 -c '${code}'`, {
      cwd: tmpdir(),
      executionPolicy: 'read_only',
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0, result.tailOutput);
    assert.deepEqual(JSON.parse(result.tailOutput), []);
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});

test('native lifecycle additions are Host-generated, never forged ambient values', live, async () => {
  const keys = ['CAT_CAFE_PROCESS_OWNER_ID', 'CAT_CAFE_SUPERVISOR_F306_SENTINEL', 'CODEX_SANDBOX', 'SHLVL'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'synthetic-do-not-inherit';
    const code = `import os,json;print(json.dumps({"leaked":[k for k in ${JSON.stringify(keys)} if os.environ.get(k)=="synthetic-do-not-inherit"],"nativeKeys":[k for k in os.environ if k.startswith(("CAT_CAFE_SUPERVISOR_","CODEX_SANDBOX"))]}))`;
    const result = await new ManagedRunner().launch(`python3 -c '${code}'`, {
      cwd: tmpdir(),
      executionPolicy: 'read_only',
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0, result.tailOutput);
    const environment = JSON.parse(result.tailOutput);
    assert.deepEqual(environment.leaked, []);
    assert.equal(environment.nativeKeys.length > 0, true);
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});

test('native timeout and cancellation end owned execution, including pre-launch cancellation', live, async () => {
  const timed = new ManagedRunner();
  const timeout = await timed.launch('python3 -c "import time;time.sleep(20)"', {
    cwd: tmpdir(),
    executionPolicy: 'read_only',
    timeoutMs: 1000,
  });
  assert.equal(timeout.timedOut, true, timeout.tailOutput);
  assert.equal(timed.state, 'timed_out');
  const before = new ManagedRunner();
  const initial = before.start('echo UNEXPECTED', { cwd: tmpdir(), executionPolicy: 'read_only', timeoutMs: 5000 });
  before.cancel();
  assert.equal((await initial.admission).spawned, false);
  assert.doesNotMatch((await initial.completion).tailOutput, /^UNEXPECTED/);
  const running = new ManagedRunner();
  const tag = `F306_STARTED_${randomUUID()}`;
  const started = running.start(
    `python3 -c 'import subprocess,time;subprocess.Popen(["sleep","20"]);time.sleep(20)' ${tag}`,
    {
      cwd: tmpdir(),
      executionPolicy: 'read_only',
      timeoutMs: 5000,
    },
  );
  const admission = await started.admission;
  assert.equal(admission.spawned, true);
  let owned;
  try {
    owned = await waitForProcesses((rows) => {
      const descendants = new Set([admission.pid]);
      let size;
      do {
        size = descendants.size;
        for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
      } while (size !== descendants.size);
      const parent = rows.find(
        (row) => descendants.has(row.pid) && row.command.includes(tag) && /python/i.test(row.command),
      );
      const child = parent && rows.find((row) => row.parent === parent.pid && /sleep 20/.test(row.command));
      return child && [parent.pid, child.pid];
    });
  } finally {
    running.cancel();
    await started.completion;
  }
  await waitForProcesses((rows) =>
    owned.every((pid) => !rows.some((row) => row.pid === pid && !/^[ZX]/.test(row.state))),
  );
  assert.equal(running.state, 'cancelled');
});

test('native output stays bounded without a newline', live, async () => {
  const result = await new ManagedRunner().launch(`python3 -c 'print("x"*200000,end="")'`, {
    cwd: tmpdir(),
    executionPolicy: 'read_only',
    timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 0, result.tailOutput);
  assert.equal(Buffer.byteLength(result.tailOutput) > 0, true);
  assert.equal(Buffer.byteLength(result.tailOutput) <= 65536, true);
});

test('native explicit exit 124 is a command exit, not an owned timeout', live, async () => {
  const runner = new ManagedRunner();
  const result = await runner.launch('exit 124', { cwd: tmpdir(), executionPolicy: 'read_only', timeoutMs: 5000 });
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, false);
  assert.equal(runner.state, 'completed');
});

test('native post-admission cleanup failure returns completion without a second admission', live, async (t) => {
  const { runManagedReadonlyCommand } = await import('../dist/infrastructure/managed-readonly-command.js');
  const originalRm = fsPromises.rm;
  let home;
  t.mock.method(fsPromises, 'rm', async (path, options) => {
    if (String(path).includes('/cat-cafe-readonly-host-')) {
      home = path;
      throw new Error('injected_post_admission_cleanup_failure');
    }
    return originalRm(path, options);
  });
  syncBuiltinESMExports();
  const admissions = [];
  try {
    const result = await runManagedReadonlyCommand(
      'printf OK',
      tmpdir(),
      5000,
      new AbortController().signal,
      (admission) => admissions.push(admission),
    );
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].spawned, true);
    assert.equal(result.exitCode, null);
    assert.match(result.tailOutput, /post_admission_cleanup_failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (home) await originalRm(home, { recursive: true, force: true });
  }
});
