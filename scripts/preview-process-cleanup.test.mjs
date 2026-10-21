import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupOwnerResultPath } from './lib/preview-cleanup-result.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'preview-process.mjs');
const test =
  process.platform === 'win32'
    ? (name, fn) => nodeTest(name, { skip: 'Requires POSIX process groups and Bash cleanup traps' }, fn)
    : nodeTest;

async function fixture(
  t,
  {
    seconds = 1,
    wrapped = false,
    earlyExit,
    exitCode = 0,
    lifetime = 60,
    waitForWrapperExit = false,
    report = false,
    rawSignal = false,
    singleProcess = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'preview-cleanup-'));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const state = join(root, 'state');
  let record;
  const env = { ...process.env, CAT_CAFE_PREVIEW_PROCESS_DIR: state };
  const run = (action, args = []) =>
    spawnSync(process.execPath, [cli, action, '--port', String(port), '--cwd', root, '--json', ...args], {
      env,
      encoding: 'utf8',
      timeout: 40_000,
    });
  writeFileSync(
    join(root, 'server.cjs'),
    `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');`,
  );
  writeFileSync(
    join(root, 'owner.sh'),
    `#!/bin/bash
${
  report
    ? `
owner_group=$(ps -p "$$" -o pgid= | tr -d ' ')
report_cleanup() {
  printf '{"pid":%s,"processGroupId":%s,"exitCode":%s}' "$$" "$owner_group" "$1" > "$CAT_CAFE_PREVIEW_CLEANUP_RESULT.tmp"
  mv "$CAT_CAFE_PREVIEW_CLEANUP_RESULT.tmp" "$CAT_CAFE_PREVIEW_CLEANUP_RESULT"
}
report_cleanup null
`
    : 'report_cleanup() { :; }'
}
trap 'trap "" INT TERM; printf "cleanup-start\\n" >> events; ${waitForWrapperExit ? 'while kill -0 "$WRAPPER_PID" 2>/dev/null; do :; done; printf "wrapper-proven-dead\\n" >> events' : `sleep ${seconds}`}; printf "cleanup-complete\\n" >> events; report_cleanup ${exitCode}; exit ${exitCode}' TERM
printf '%s\\n' "$$" > owner.pid
"${process.execPath}" server.cjs &
printf '%s\\n' "$!" > server.pid
wait
`,
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { start: 'bash owner.sh' } }));
  writeFileSync(
    join(root, 'wrapper.cjs'),
    `const {spawn}=require('node:child_process');
const {appendFileSync}=require('node:fs');
spawn('/bin/bash',['owner.sh'],{stdio:'inherit',env:{...process.env,WRAPPER_PID:String(process.pid)}});
${rawSignal ? '' : `process.on('SIGTERM',()=>{appendFileSync('events','wrapper-exit\\n');process.exit(${earlyExit ?? 143});});`}
setInterval(()=>{},1000);`,
  );
  t.after(() => {
    run('stop');
    // Only this fixture's recorded processes; never kill by port or name.
    for (const name of ['owner.pid', 'server.pid']) {
      if (!existsSync(join(root, name))) continue;
      try {
        process.kill(Number(readFileSync(join(root, name), 'utf8')), 'SIGKILL');
      } catch {}
    }
    if (record?.origin === 'launchd') {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${record.launchdLabel}`]);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const command = singleProcess
    ? [process.execPath, 'server.cjs']
    : earlyExit !== undefined
      ? [process.execPath, 'wrapper.cjs']
      : wrapped
        ? ['pnpm', 'run', 'start']
        : ['/bin/bash', 'owner.sh'];
  const started = run('start', ['--lifetime-seconds', String(lifetime), '--', ...command]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const id = createHash('sha256').update(`${root}\0${port}`).digest('hex').slice(0, 16);
  const recordPath = join(state, `${id}.json`);
  record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const events = () => (existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8') : '');
  return { run, events, record, recordPath };
}

test('stop waits for reported cleanup after the listening port has closed', async (t) => {
  const f = await fixture(t, { report: true });
  const stopped = f.run('stop');
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.match(f.events(), /cleanup-complete/, 'stopped must mean owner cleanup completed');
});

test('a managed single process raw signal is termination, not a cleanup acknowledgement', async (t) => {
  const f = await fixture(t, { singleProcess: true });
  const stopped = f.run('stop');
  assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
  assert.ok(existsSync(f.recordPath));
  assert.equal(JSON.parse(f.run('status').stdout).status, 'stopped');
});

for (const wrapped of [false, true]) {
  test(`unreported ${wrapped ? 'pnpm' : 'direct'} cleanup success is not a certified stop`, async (t) => {
    const f = await fixture(t, { wrapped });
    const stopped = f.run('stop');
    assert.match(f.events(), /cleanup-complete/);
    assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
    assert.ok(existsSync(f.recordPath));
  });
}

for (const [earlyExit, exitCode] of [
  [143, 7],
  [143, 0],
  [0, 7],
]) {
  test(`early wrapper exit ${earlyExit} cannot certify unreported owner outcome ${exitCode}`, async (t) => {
    const f = await fixture(t, { earlyExit, exitCode });
    const stopped = f.run('stop');
    assert.match(f.events(), /cleanup-complete/);
    assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
    assert.ok(existsSync(f.recordPath), 'unproven cleanup must retain the managed record');
    assert.equal(f.run('stop').status, 1);
  });
}

for (const rawSignal of [false, true]) {
  test(`fast owner failure after proven wrapper death cannot become successful cleanup (${rawSignal ? 'raw signal' : 'exit zero'})`, async (t) => {
    const f = await fixture(t, { earlyExit: 0, exitCode: 7, waitForWrapperExit: true, rawSignal });
    const stopped = f.run('stop');
    assert.match(f.events(), /wrapper-proven-dead[\s\S]*cleanup-complete/);
    if (!rawSignal) assert.match(f.events(), /wrapper-exit[\s\S]*wrapper-proven-dead/);
    assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
    assert.ok(existsSync(f.recordPath));
  });
}

for (const resultKind of ['incomplete JSON', 'another process group']) {
  test(`an owner result with ${resultKind} cannot certify cleanup`, async (t) => {
    const f = await fixture(t);
    const value =
      resultKind === 'incomplete JSON'
        ? '{'
        : JSON.stringify({ pid: f.record.pid, processGroupId: f.record.pid, exitCode: 0 });
    writeFileSync(cleanupOwnerResultPath(f.record.completionPath), value);
    const stopped = f.run('stop');
    assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
    assert.match(f.events(), /cleanup-complete/);
    assert.ok(existsSync(f.recordPath));
  });
}

test('stop permits the reported launcher eight-second drain through pnpm', async (t) => {
  const f = await fixture(t, { seconds: 8, wrapped: true, report: true });
  const stopped = f.run('stop');
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.match(f.events(), /cleanup-complete/);
});

test('cleanup failure through pnpm is not a successful stop and retains its evidence', async (t) => {
  const f = await fixture(t, { exitCode: 7, wrapped: true });
  const stopped = f.run('stop');
  assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
  assert.match(f.events(), /cleanup-complete/);
  assert.ok(existsSync(f.recordPath), 'failed cleanup must retain the managed record');
  assert.equal(f.run('stop').status, 1, 'retry must not erase a failed terminal outcome');
});

test('a later managed start keeps the original failed completion and owner result intact', async (t) => {
  const f = await fixture(t, { exitCode: 7, wrapped: true, report: true });
  assert.equal(f.run('stop').status, 1);
  assert.equal(JSON.parse(f.run('status').stdout).status, 'stopped');
  const failedCompletion = readFileSync(f.record.completionPath, 'utf8');
  const failedOwnerPath = cleanupOwnerResultPath(f.record.completionPath);
  const failedOwner = readFileSync(failedOwnerPath, 'utf8');
  assert.notEqual(JSON.parse(failedCompletion).exitCode, 0);
  assert.equal(JSON.parse(failedOwner).exitCode, 7);
  const started = f.run('start', ['--', 'pnpm', 'run', 'start']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const current = JSON.parse(readFileSync(f.recordPath, 'utf8'));
  assert.notEqual(current.completionPath, f.record.completionPath);
  assert.equal(readFileSync(f.record.completionPath, 'utf8'), failedCompletion);
  assert.equal(readFileSync(failedOwnerPath, 'utf8'), failedOwner);
});

test('lease expiry also waits for a reported wrapped launcher cleanup', async (t) => {
  const f = await fixture(t, { seconds: 8, wrapped: true, lifetime: 2, report: true });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !f.events().includes('cleanup-complete')) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(f.events(), /cleanup-complete/, 'expiry must not truncate cleanup');
  assert.equal(
    f.events().match(/cleanup-start/g)?.length,
    1,
    'the cooperating owner drains once despite pnpm signal forwarding',
  );
  const stopped = f.run('stop');
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
});

test('a changed process identity cannot be signalled using the stored launchd PID', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.recordPath, JSON.stringify({ ...f.record, processCommand: 'different incarnation' }));
  try {
    assert.equal(f.run('stop').status, 1);
    assert.equal(f.events(), '', 'an identity mismatch must not start cleanup');
  } finally {
    writeFileSync(f.recordPath, JSON.stringify(f.record));
  }
});

test('forced cleanup timeout remains a failure after the process group is killed', async (t) => {
  const f = await fixture(t, { seconds: 40 });
  const stopped = f.run('stop');
  assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
  assert.doesNotMatch(f.events(), /cleanup-complete/);
  assert.ok(existsSync(f.recordPath));
  assert.equal(f.run('stop').status, 1);
});
