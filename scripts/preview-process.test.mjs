import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(SCRIPT_DIR, 'preview-process.mjs');

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
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe('preview-process managed lifecycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-preview-process-'));
  const stateDir = join(root, 'state');
  let port;
  const env = {
    ...process.env,
    CAT_CAFE_PREVIEW_PROCESS_DIR: stateDir,
    CAT_CAFE_CALLBACK_TOKEN: 'must-not-leak-to-managed-preview',
  };

  before(async () => {
    port = await reservePort();
  });

  after(() => {
    if (port) {
      spawnSync(process.execPath, [SCRIPT_PATH, 'stop', '--port', String(port), '--cwd', root], {
        env,
        encoding: 'utf8',
      });
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a preview server alive after start exits and reports exact status until stop', () => {
    const fixture = [
      "const http = require('node:http');",
      `http.createServer((_req, res) => res.end('managed-preview-ok:' + (process.env.CAT_CAFE_CALLBACK_TOKEN ? 'leaked' : 'clean'))).listen(${port}, '127.0.0.1');`,
    ].join('');
    const start = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'start', '--port', String(port), '--cwd', root, '--', process.execPath, '-e', fixture],
      { env, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(start.status, 0, start.stderr || start.stdout);
    if (process.platform === 'darwin') assert.match(start.stdout, /origin: launchd/);

    const status = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'status', '--port', String(port), '--cwd', root, '--json'],
      { env, encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).status, 'running');

    if (process.platform === 'darwin') {
      const id = createHash('sha256').update(`${root}\0${port}`).digest('hex').slice(0, 16);
      const record = JSON.parse(readFileSync(join(stateDir, `${id}.json`), 'utf8'));
      assert.equal(
        record.origin,
        'launchd',
        'a preview handed to the user must be launched outside the invocation process domain',
      );
      assert.match(record.launchdLabel, /^com\.catcafe\.preview\.[a-f0-9]{16}$/);

      const launchd = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${record.launchdLabel}`], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      assert.equal(launchd.status, 0, launchd.stderr || launchd.stdout);
      assert.match(launchd.stdout, new RegExp(`\\bpid = ${record.pid}\\b`));
      assert.match(launchd.stdout, /\bruns = 1\b/);
      assert.doesNotMatch(
        launchd.stdout,
        /properties = keepalive/,
        'a one-shot preview launcher must not spin by relaunching an already-running child',
      );
      assert.doesNotMatch(launchd.stdout, /\.codex\/tmp/);
      const plist = readFileSync(record.plistPath, 'utf8');
      assert.doesNotMatch(plist, /<key>CAT_CAFE_(?:CALLBACK_TOKEN|INVOCATION_ID|AGENT_KEY_FILES)<\/key>/);
      assert.doesNotMatch(plist, /\.codex\/tmp/);

      const ppid = spawnSync('ps', ['-p', String(record.pid), '-o', 'ppid='], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      assert.equal(ppid.status, 0, ppid.stderr || ppid.stdout);
      assert.equal(Number(ppid.stdout.trim()), 1);
    }

    const response = spawnSync(
      process.execPath,
      ['-e', `fetch('http://127.0.0.1:${port}').then(r => r.text()).then(console.log)`],
      { encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(response.status, 0, response.stderr);
    assert.equal(response.stdout.trim(), 'managed-preview-ok:clean');

    const stop = spawnSync(process.execPath, [SCRIPT_PATH, 'stop', '--port', String(port), '--cwd', root], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const stopped = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'status', '--port', String(port), '--cwd', root, '--json'],
      { env, encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(stopped.status, 1);
    assert.equal(JSON.parse(stopped.stdout).status, 'stopped');
  });

  it('refuses to replace an unmanaged listener on the requested port', async () => {
    const occupiedPort = await reservePort();
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(occupiedPort, '127.0.0.1', resolve);
    });
    try {
      const result = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          'start',
          '--port',
          String(occupiedPort),
          '--cwd',
          root,
          '--',
          process.execPath,
          '-e',
          'setInterval(() => {}, 1000)',
        ],
        { env, encoding: 'utf8', timeout: 5_000 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /refusing to replace unmanaged target/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('cleans an exited one-shot LaunchAgent without claiming ownership of another process', async () => {
    if (process.platform !== 'darwin') return;
    const oneShotPort = await reservePort();
    const fixture = [
      "const http = require('node:http');",
      `const server = http.createServer((_req, res) => res.end('one-shot')).listen(${oneShotPort}, '127.0.0.1');`,
      'setTimeout(() => server.close(() => process.exit(0)), 750);',
    ].join('');
    const start = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'start', '--port', String(oneShotPort), '--cwd', root, '--', process.execPath, '-e', fixture],
      { env, encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(start.status, 0, start.stderr || start.stdout);

    const deadline = Date.now() + 3_000;
    let status;
    do {
      status = spawnSync(
        process.execPath,
        [SCRIPT_PATH, 'status', '--port', String(oneShotPort), '--cwd', root, '--json'],
        { env, encoding: 'utf8', timeout: 5_000 },
      );
      if (JSON.parse(status.stdout).status === 'stopped') break;
    } while (Date.now() < deadline);
    assert.equal(JSON.parse(status.stdout).status, 'stopped');

    const stop = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'stop', '--port', String(oneShotPort), '--cwd', root, '--json'],
      { env, encoding: 'utf8', timeout: 5_000 },
    );
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const id = createHash('sha256').update(`${root}\0${oneShotPort}`).digest('hex').slice(0, 16);
    const launchd = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.catcafe.preview.${id}`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(launchd.status, 0, 'stopping an exited one-shot preview must boot out its loaded job');
  });

  it('continues a bounded readiness probe when a managed cold start crosses ten seconds', async () => {
    const latePort = await reservePort();
    const fixture = [
      "const http = require('node:http');",
      `setTimeout(() => http.createServer((_req, res) => res.end('late-ready')).listen(${latePort}, '127.0.0.1'), 10_500);`,
      'setInterval(() => {}, 1000);',
    ].join('');

    const start = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'start', '--port', String(latePort), '--cwd', root, '--', process.execPath, '-e', fixture],
      { env, encoding: 'utf8', timeout: 20_000 },
    );

    try {
      assert.equal(start.status, 0, start.stderr || start.stdout);
      assert.match(start.stdout, /\[preview-process\] running/);
    } finally {
      spawnSync(process.execPath, [SCRIPT_PATH, 'stop', '--port', String(latePort), '--cwd', root], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
      });
    }
  });

  it('does not report a managed process stopped until the exact process has exited', async () => {
    const startingPort = await reservePort();
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

    const descendantDeadline = Date.now() + 2_000;
    while (!readFileSync(descendantPidPath, { encoding: 'utf8', flag: 'a+' }).trim()) {
      if (Date.now() >= descendantDeadline) throw new Error('managed descendant did not publish its PID');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8').trim());

    const started = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
    const command = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
    const id = createHash('sha256').update(`${root}\0${startingPort}`).digest('hex').slice(0, 16);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${id}.json`),
      `${JSON.stringify({
        version: 1,
        id,
        cwd: root,
        port: startingPort,
        command: [process.execPath, '-e', 'fixture'],
        pid: child.pid,
        processStartedAt: started,
        processCommand: command,
        startedAt: new Date().toISOString(),
        logPath: join(stateDir, `${id}.log`),
      })}\n`,
    );

    try {
      const status = spawnSync(
        process.execPath,
        [SCRIPT_PATH, 'status', '--port', String(startingPort), '--cwd', root, '--json'],
        { env, encoding: 'utf8', timeout: 5_000 },
      );
      assert.equal(status.status, 0, status.stderr || status.stdout);
      assert.equal(JSON.parse(status.stdout).status, 'starting');

      const stop = spawnSync(
        process.execPath,
        [SCRIPT_PATH, 'stop', '--port', String(startingPort), '--cwd', root, '--json'],
        { env, encoding: 'utf8', timeout: 6_000 },
      );
      assert.equal(stop.status, 0, stop.stderr || stop.stdout);
      if (child.exitCode === null) {
        await new Promise((resolve) => child.once('exit', resolve));
      }
      assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
      assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  });
});
