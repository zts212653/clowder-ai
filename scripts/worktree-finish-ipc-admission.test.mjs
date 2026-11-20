import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scheduledFinish } from './lib/worktree-finish-ipc-fixture.mjs';

describe('native fsmonitor admission and lifetime', { skip: process.platform !== 'darwin', timeout: 120000 }, () => {
  it('holds native startup admission through removal when there was initially no daemon or IPC', () =>
    scheduledFinish(
      'remove',
      async (f) => {
        const start = spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'start']);
        if (start.status === 0) {
          assert.equal((await f.startClient()).state, 'connected');
        }
        const result = await f.complete();
        if (start.status === 0) {
          assert.notEqual(result.code, 0, 'removed a newly started daemon and its real client');
          assert.equal(existsSync(f.path), true);
        } else {
          assert.equal(result.code, 0, result.error);
          assert.equal(existsSync(f.path), false);
        }
      },
      '',
      { noDaemon: true },
    ));
  it('cleans a newly created startup mutex when kernel-lock acquisition fails', () =>
    scheduledFinish(
      'status',
      async (f) => {
        const mode = lstatSync(f.socket).mode & 0o777;
        const result = await f.complete();
        assert.notEqual(result.code, 0);
        assert.match(result.error, /IPC admission already active or unknown/);
        assert.equal(existsSync(`${f.socket}.lock`), false, 'failed acquisition left its own empty mutex behind');
        assert.equal(lstatSync(f.socket).mode & 0o777, mode);
        assert.equal(spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'status']).status, 0);
      },
      '',
      { denyFlock: true },
    ));
  it('refuses a successful validator exit without a fresh qualification witness', () =>
    scheduledFinish(
      'status',
      async (f) => {
        const mode = lstatSync(f.socket).mode & 0o777;
        const result = await f.complete();
        assert.notEqual(result.code, 0);
        assert.match(result.error, /positive qualification witness missing/);
        assert.equal(lstatSync(f.socket).mode & 0o777, mode);
        assert.equal(spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'status']).status, 0);
      },
      '',
      { skipValidator: true },
    ));
  it('closes admission before the last consumer check and native stop', () =>
    scheduledFinish('stop', async (f) => {
      const { state } = await f.startClient();
      const result = await f.complete();
      if (state === 'connected') {
        assert.notEqual(result.code, 0, 'finish stopped a listener with a client admitted after its last snapshot');
        assert.equal(existsSync(f.path), true);
      } else {
        assert.match(state, /^denied:/);
        assert.equal(result.code, 0, result.error);
        assert.equal(result.receipt.storageDisposition, 'removed');
        assert.equal(existsSync(f.path), false);
      }
    }));

  it('keeps native startup closed through archive validation and actual removal', () =>
    scheduledFinish('remove', async (f) => {
      assert.equal(existsSync(`${f.socket}.lock`), true, 'startup mutex was released before removal');
      assert.notEqual(
        spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'start']).status,
        0,
        'another native daemon entered during removal',
      );
      const result = await f.complete();
      assert.equal(result.code, 0, result.error);
      assert.equal(result.receipt.storageDisposition, 'removed');
    }));

  it('restores admission and preserves a client entering before the gate closes', () =>
    scheduledFinish('status', async (f) => {
      const mode = lstatSync(f.socket).mode & 0o777;
      const { client, state } = await f.startClient();
      assert.equal(state, 'connected');
      const result = await f.complete();
      assert.notEqual(result.code, 0);
      assert.match(result.error, /active Unix IPC consumer/);
      assert.equal(lstatSync(f.socket).mode & 0o777, mode);
      assert.equal(existsSync(`${f.socket}.lock`), false);
      assert.equal(spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'status']).status, 0);
      const reply = once(client.stdout, 'data');
      client.stdin.write('check\n');
      assert.equal((await reply)[0].toString().trim(), 'open');
    }));

  it('restores the original monitor and permissions when the native stop command fails', () =>
    scheduledFinish(
      'stop',
      async (f) => {
        const mode = f.journal()[0].mode;
        const result = await f.complete();
        assert.notEqual(result.code, 0);
        assert.equal(lstatSync(f.socket).mode & 0o777, mode);
        assert.equal(existsSync(`${f.socket}.lock`), false);
        assert.equal(spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'status']).status, 0);
      },
      23,
    ));

  it('recovers a real dead-daemon IPC using its durable sealed-lifetime proof', () =>
    scheduledFinish('stop', async (f) => {
      const records = f.journal();
      assert.ok(records.some((row) => row.phase === 'qualified'));
      const inode = lstatSync(f.socket).ino;
      process.kill(records[0].monitorPid, 'SIGKILL'); // Only the monitor this exact fixture just created and qualified.
      const result = await f.complete();
      assert.notEqual(result.code, 0, 'the interrupted native command must retain a truthful failure');
      assert.equal(lstatSync(f.socket).ino, inode);
      const receipts = readdirSync(f.dir).filter((name) => name.endsWith('.stopped'));
      assert.equal(receipts.length, 1, 'sealed proof was lost when the failed finish released its mutex');
      const released = f.fx.finish(f.path, { cwdProbe: undefined });
      assert.equal(released.storageDisposition, 'removed');
      assert.equal(f.fx.finish(f.path, { mode: 'check' }).state, 'released');
      assert.equal(existsSync(join(released.archivePath, 'git-metadata', receipts[0])), true);
    }));

  it('does not apply a genuine old lifetime receipt to a replacement IPC inode', () =>
    scheduledFinish('stop', async (f) => {
      const base = f.journal()[0];
      process.kill(base.monitorPid, 'SIGKILL');
      assert.notEqual((await f.complete()).code, 0);
      assert.ok(readdirSync(f.dir).some((name) => name.endsWith('.stopped')));
      unlinkSync(f.socket);
      assert.equal(
        spawnSync(
          'python3',
          ['-I', '-S', '-c', "import socket; s=socket.socket(socket.AF_UNIX); s.bind('fsmonitor--daemon.ipc')"],
          { cwd: f.dir },
        ).status,
        0,
      );
      const inode = lstatSync(f.socket).ino;
      linkSync(f.socket, join(f.fx.root, 'replacement-alias.ipc'));
      assert.throws(() => f.fx.finish(f.path, { cwdProbe: undefined }), /cold IPC inode or links changed/);
      assert.equal(lstatSync(f.socket).ino, inode);
      assert.equal(existsSync(f.path), true);
    }));

  it('keeps an orphaned helper exclusive and recovers only after its kernel lease ends', () =>
    scheduledFinish('stop', async (f) => {
      const records = f.journal();
      const control = records.findLast((row) => row.phase === 'control');
      const native = records.findLast((row) => row.phase === 'native-client');
      assert.ok(control && native);
      const command = spawnSync('ps', ['-p', String(control.pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
      assert.ok(command.includes('worktree-fsmonitor-stop.pl') && command.includes(f.path));
      const exited = once(f.finish, 'exit');
      f.finish.kill('SIGKILL');
      await exited;
      assert.throws(() => f.fx.finish(f.path, { cwdProbe: undefined }), /admission already active/);
      process.kill(control.pid, 'SIGKILL'); // The exact controller forked by this fixture's finish process.
      await f.complete();
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          process.kill(native.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          throw error;
        }
        assert.ok(Date.now() < deadline, 'orphaned native client did not exit');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const released = f.fx.finish(f.path, { cwdProbe: undefined });
      assert.equal(released.storageDisposition, 'removed');
      assert.equal(f.fx.finish(f.path, { mode: 'check' }).state, 'released');
    }));
});
