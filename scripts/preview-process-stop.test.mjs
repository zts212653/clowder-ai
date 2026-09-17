import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preview-process.mjs');

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

it('does not report a managed process stopped until the exact process has exited', async () => {
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
    const started = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
    const command = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
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
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
