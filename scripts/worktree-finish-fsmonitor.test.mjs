import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectedClient, fixture, git, SOURCE } from './lib/worktree-finish-fixture.mjs';
import { processRefs, statusFacts } from './lib/worktree-reaper-probes.mjs';

// Git's native FSEvents daemon/UDS are the boundary under test, not a fake process probe.
describe('finish with native Git fsmonitor', { skip: process.platform !== 'darwin' }, () => {
  let fx;
  let path;
  let child;
  let other;
  const monitorStatus = () => spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'status']).status;
  const socketPath = () => join(git(path, 'rev-parse', '--absolute-git-dir').trim(), 'fsmonitor--daemon.ipc');
  beforeEach(() => {
    fx = fixture();
    git(fx.repo, 'config', 'core.fsmonitor', 'false');
    path = fx.make();
    git(path, 'config', '--worktree', 'core.fsmonitor', 'true');
    assert.equal(monitorStatus(), 1);
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    child = undefined;
    if (other) spawnSync('git', ['-C', other, 'fsmonitor--daemon', 'stop']);
    other = undefined;
    spawnSync('git', ['-C', path, 'fsmonitor--daemon', 'stop']);
    spawnSync('git', ['-C', fx.repo, 'fsmonitor--daemon', 'stop']);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('does not start a daemon during a read-only cleanliness probe', () => {
    assert.deepEqual(statusFacts(path), { trackedChanges: 0, untrackedPreserved: 0 });
    assert.equal(monitorStatus(), 1, 'statusFacts started a daemon in the target it judges');
    const script = fileURLToPath(new URL('./worktree-inventory.mjs', import.meta.url));
    execFileSync(process.execPath, [script, '--repo', fx.repo], { cwd: fx.repo, stdio: 'pipe' });
    assert.equal(monitorStatus(), 1, 'inventory started a daemon');
    assert.throws(() => fx.finish(path, { mode: 'check' }), /no retained/);
    assert.equal(monitorStatus(), 1, 'check started a daemon');
    assert.equal(git(path, 'config', '--worktree', 'core.fsmonitor').trim(), 'true');
  });

  it('finishes an eligible owned checkout with its existing native daemon and verifies the archive', () => {
    other = fx.make('cat-cafe-other-owner');
    git(other, 'config', '--worktree', 'catcafe.lifecycle.owner', 'another-cat');
    git(other, 'config', '--worktree', 'core.fsmonitor', 'true');
    git(other, 'fsmonitor--daemon', 'start');
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, '.cat-cafe/private.txt'), 'owned original\n');
    git(path, 'fsmonitor--daemon', 'start');
    assert.equal(monitorStatus(), 0);
    git(fx.repo, 'config', 'core.fsmonitor', 'true');
    const receipt = fx.finish(path, { cwdProbe: undefined });
    assert.equal(receipt.storageDisposition, 'removed');
    assert.equal(existsSync(path), false);
    assert.equal(fx.finish(path, { mode: 'check' }).state, 'released');
    const config = readFileSync(join(receipt.archivePath, 'git-metadata/config.worktree'), 'utf8');
    assert.match(config, /fsmonitor = true/);
    assert.equal(git(fx.repo, 'config', 'core.fsmonitor').trim(), 'true');
    assert.equal(readFileSync(join(receipt.archivePath, 'files/.cat-cafe/private.txt'), 'utf8'), 'owned original\n');
    assert.equal(spawnSync('git', ['-C', other, 'fsmonitor--daemon', 'status']).status, 0);
  });

  it('runs the actual CLI once with fsmonitor enabled and verifies using the same source', () => {
    git(path, 'fsmonitor--daemon', 'start');
    const script = fileURLToPath(new URL('./worktree-finish.mjs', import.meta.url));
    const run = (...flags) =>
      JSON.parse(
        execFileSync(process.execPath, [script, path, '--source-ref', SOURCE, ...flags], {
          cwd: fx.repo,
          encoding: 'utf8',
          env: { ...process.env, CAT_CAFE_CAT_ID: 'codex61-sol', CAT_CAFE_DATA_DIR: join(fx.root, 'data') },
        }),
      );
    assert.equal(run().storageDisposition, 'removed');
    assert.equal(run('--check').state, 'released');
  });

  for (const [reason, change] of [
    ['owner mismatch', () => ({ owner: 'another-cat' })],
    ['HEAD changed', () => ({ expectedHead: '0'.repeat(40) })],
    [
      'dirty',
      () => {
        writeFileSync(join(path, 'README.md'), 'unfinished\n');
        return {};
      },
    ],
    [
      'unmerged',
      () => {
        writeFileSync(join(path, 'new.txt'), 'unfinished\n');
        git(path, 'add', 'new.txt');
        git(path, 'commit', '-qm', 'unmerged');
        return {};
      },
    ],
    [
      'durable consumer',
      () => {
        const dir = join(fx.root, 'data', 'managed-gate-jobs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'queued.json'), JSON.stringify({ state: 'queued', cwd: path }));
        return {};
      },
    ],
  ]) {
    it(`preserves the running monitor when the checkout is ineligible: ${reason}`, () => {
      git(path, 'fsmonitor--daemon', 'start');
      assert.throws(() => fx.finish(path, { cwdProbe: undefined, ...change() }));
      assert.equal(monitorStatus(), 0);
      assert.equal(lstatSync(socketPath()).isSocket(), true);
      assert.equal(existsSync(path), true);
    });
  }

  it('preserves an existing monitor while another real process still consumes the checkout', async () => {
    git(path, 'fsmonitor--daemon', 'start');
    child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], {
      cwd: path,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await once(child.stdout, 'data');
    assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /busy/);
    assert.equal(monitorStatus(), 0);
  });

  it('does not stop or unlink a socket held by an unrelated process', async () => {
    const dir = git(path, 'rev-parse', '--absolute-git-dir').trim();
    child = spawn(
      process.execPath,
      ['-e', 'require("node:net").createServer().listen("fsmonitor--daemon.ipc",()=>process.stdout.write("ready"))'],
      {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await once(child.stdout, 'data');
    const inode = lstatSync(socketPath()).ino;
    assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /identity unknown|unproven/);
    assert.equal(child.exitCode, null);
    assert.equal(lstatSync(socketPath()).ino, inode);
  });

  it('does not treat incomplete socket observations as idle', () => {
    git(path, 'fsmonitor--daemon', 'start');
    const refs = processRefs({ excludePids: [process.pid], observerPid: process.pid });
    assert.ok(refs);
    assert.throws(
      () => fx.finish(path, { cwdProbe: () => ({ ...refs, openFilesComplete: false }) }),
      /observations unknown/,
    );
    assert.equal(monitorStatus(), 0);
  });

  it('preserves a bound but non-listening socket even though native status reports no listener', async () => {
    const dir = git(path, 'rev-parse', '--absolute-git-dir').trim();
    child = spawn(
      'python3',
      [
        '-I',
        '-S',
        '-c',
        'import socket,signal; s=socket.socket(socket.AF_UNIX); s.bind("fsmonitor--daemon.ipc"); print("ready",flush=True); signal.pause()',
      ],
      {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await once(child.stdout, 'data');
    const inode = lstatSync(socketPath()).ino;
    assert.equal(monitorStatus(), 1);
    assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /binding|identity unknown|unproven/);
    assert.equal(child.exitCode, null);
    assert.equal(lstatSync(socketPath()).ino, inode);
  });

  for (const [kind, listening] of [
    ['SOCK_STREAM', false],
    ['SOCK_DGRAM', false],
    ['SOCK_STREAM', true],
  ]) {
    it(`preserves a renamed live socket after its holder leaves: ${kind}, listening=${listening}`, async () => {
      const dir = git(path, 'rev-parse', '--absolute-git-dir').trim();
      const socket = socketPath();
      child = spawn(
        'python3',
        [
          '-I',
          '-S',
          '-c',
          `import os,socket,signal; s=socket.socket(socket.AF_UNIX,socket.${kind}); s.bind("original.sock"); os.rename("original.sock","fsmonitor--daemon.ipc"); ${listening ? 's.listen(8);' : ''} os.chdir("/"); print("ready",flush=True); signal.pause()`,
        ],
        {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await once(child.stdout, 'data');
      const inode = lstatSync(socket).ino;
      assert.equal(monitorStatus(), listening ? 0 : 1);
      assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /binding|holder|IPC/);
      assert.equal(child.exitCode, null);
      assert.equal(lstatSync(socket).ino, inode);
      assert.equal(existsSync(path), true);
    });
  }

  it('finishes while an independent repository main keeps its native monitor and connected client', async () => {
    const independent = fixture();
    try {
      git(independent.repo, 'config', 'core.fsmonitor', 'true');
      git(independent.repo, 'fsmonitor--daemon', 'start');
      child = spawn('python3', ['-I', '-S', '-c', connectedClient()], {
        cwd: join(independent.repo, '.git'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const [ready] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit')]);
      assert.equal(String(ready).trim(), 'ready');
      git(path, 'fsmonitor--daemon', 'start');
      const receipt = fx.finish(path, { cwdProbe: undefined });
      assert.equal(receipt.storageDisposition, 'removed');
      assert.equal(fx.finish(path, { mode: 'check' }).state, 'released');
      assert.equal(spawnSync('git', ['-C', independent.repo, 'fsmonitor--daemon', 'status']).status, 0);
      const reply = once(child.stdout, 'data');
      child.stdin.write('check\n');
      assert.equal(String((await reply)[0]).trim(), 'open');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      spawnSync('git', ['-C', independent.repo, 'fsmonitor--daemon', 'stop']);
      rmSync(independent.root, { recursive: true, force: true });
    }
  });

  it('preserves an unheld socket when binding verification is denied', () => {
    const dir = git(path, 'rev-parse', '--absolute-git-dir').trim();
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-c', 'import socket; s=socket.socket(socket.AF_UNIX); s.bind("fsmonitor--daemon.ipc")'],
      { cwd: dir },
    );
    assert.equal(result.status, 0);
    const socket = socketPath();
    const inode = lstatSync(socket).ino;
    chmodSync(socket, 0o000);
    try {
      assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /binding observations unknown/);
      assert.equal(lstatSync(socket).ino, inode);
    } finally {
      chmodSync(socket, 0o600);
    }
  });
});
