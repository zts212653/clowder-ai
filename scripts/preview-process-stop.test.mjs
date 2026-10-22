import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stopManagedPreview } from './lib/preview-process-stop.mjs';
import { readProcessIdentity } from './preview-process-launchers.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preview-process.mjs');
const LEASE_RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preview-process-lease-runner.mjs');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

it(
  'does not report a managed process stopped until the exact process has exited',
  { skip: process.platform === 'win32' && 'Requires POSIX ps identity and process groups' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-preview-process-stop-'));
    const stateDir = join(root, 'state');
    const port = await reservePort();
    const descendantPidPath = join(root, 'managed-descendant.pid');
    const descendantFixture = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const leaderFixture = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantFixture)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');
    const child = spawn(process.execPath, ['-e', leaderFixture], { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();

    try {
      const deadline = Date.now() + 2_000;
      while (!readFileSync(descendantPidPath, { encoding: 'utf8', flag: 'a+' }).trim()) {
        if (Date.now() >= deadline) throw new Error('managed descendant did not publish its PID');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const descendantPid = Number(readFileSync(descendantPidPath, 'utf8').trim());
      const identity = readProcessIdentity(child.pid);
      assert.ok(identity, 'the test-owned process must publish its canonical identity');
      const { processStartedAt: started, processCommand: command } = identity;
      const id = createHash('sha256').update(`${root}\0${port}`).digest('hex').slice(0, 16);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, `${id}.json`),
        `${JSON.stringify({
          version: 1,
          id,
          cwd: root,
          port,
          command: [process.execPath, '-e', 'fixture'],
          pid: child.pid,
          processStartedAt: started,
          processCommand: command,
          startedAt: new Date().toISOString(),
          logPath: join(stateDir, `${id}.log`),
        })}\n`,
      );
      const env = { ...process.env, CAT_CAFE_PREVIEW_PROCESS_DIR: stateDir };
      const status = spawnSync(
        process.execPath,
        [SCRIPT_PATH, 'status', '--port', String(port), '--cwd', root, '--json'],
        {
          env,
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      assert.equal(status.status, 0, status.stderr || status.stdout);
      assert.equal(JSON.parse(status.stdout).status, 'starting');

      const stop = spawnSync(process.execPath, [SCRIPT_PATH, 'stop', '--port', String(port), '--cwd', root, '--json'], {
        env,
        encoding: 'utf8',
        timeout: 6_000,
      });
      if (stop.status !== 0) {
        t.diagnostic(
          JSON.stringify({
            started,
            command,
            current: spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).stdout,
          }),
        );
      }
      assert.equal(stop.status, 0, stop.stderr || stop.stdout);
      if (child.exitCode === null && child.signalCode === null) {
        child.ref(); // The fixture unrefs the child; an exit listener alone cannot keep Node's loop alive.
        await new Promise((resolve) => child.once('exit', resolve));
      }
      assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
      assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const outcome of ['complete', 'owner failure', 'missing receipt']) {
  it(
    `an unreaped supervisor with ${outcome} keeps the cleanup receipt contract`,
    { skip: process.platform === 'win32' && 'Requires POSIX zombie observation' },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'preview-unreaped-'));
      const completionPath = join(root, 'completion.json');
      const readyPath = join(root, 'ready');
      const finishPath = join(root, 'finish');
      const recordPath = join(root, 'record.json');
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const exitCode = outcome === 'owner failure' ? 7 : 0;
      const program = `
        const fs = require('node:fs');
        fs.writeFileSync(process.env.CAT_CAFE_PREVIEW_CLEANUP_RESULT,
          JSON.stringify({pid:process.pid,processGroupId:process.pid,exitCode:${exitCode}}));
        fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        setInterval(() => { if (fs.existsSync(${JSON.stringify(finishPath)})) process.exit(${exitCode}); }, 10);
      `;
      const runner = spawn(
        process.execPath,
        [
          LEASE_RUNNER_PATH,
          '--expires-at',
          expiresAt,
          '--completion-path',
          completionPath,
          '--',
          process.execPath,
          '-e',
          program,
        ],
        { stdio: 'ignore' },
      );
      try {
        const readyDeadline = Date.now() + 5_000;
        while (!existsSync(readyPath) && Date.now() < readyDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(readyPath), 'the real supervisor must own a ready child');
        const identity = readProcessIdentity(runner.pid);
        assert.ok(identity);
        const record = { pid: runner.pid, ...identity, expiresAt, completionPath };
        writeFileSync(recordPath, JSON.stringify(record));
        const port = await reservePort();
        writeFileSync(finishPath, 'finish');
        // Keep Node's child watcher from reaping this owned runner, so the
        // otherwise brief ps/exit race is deterministic without faking ps.
        const exitDeadline = Date.now() + 5_000;
        let state = '';
        while (Date.now() < exitDeadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          state = spawnSync('ps', ['-p', String(runner.pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
          if (state.startsWith('Z')) break;
        }
        assert.match(state, /^Z/, 'the test must hold an actual unreaped supervisor');
        assert.equal(JSON.parse(readFileSync(completionPath, 'utf8')).exitCode, exitCode);
        if (outcome === 'missing receipt') rmSync(completionPath);
        const stop = stopManagedPreview({ recordPath, port }, { status: 'stopped', record });
        if (outcome === 'complete') {
          await stop;
          assert.equal(existsSync(recordPath), false);
        } else {
          await assert.rejects(stop, /cleanup incomplete or failed/);
          assert.equal(existsSync(recordPath), true, 'unproven cleanup must retain its evidence');
        }
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill('SIGTERM');
          await new Promise((resolve) => runner.once('exit', resolve));
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
