import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { finishInEnvironment, scheduledFinish } from './lib/worktree-finish-ipc-fixture.mjs';

async function orphanOwnController(f) {
  const records = f.journal();
  const control = records.findLast((row) => row.phase === 'control');
  const native = records.findLast((row) => row.phase === 'native-client');
  assert.ok(control && native);
  const command = spawnSync('ps', ['-p', String(control.pid), '-o', 'ppid=,command='], { encoding: 'utf8' }).stdout;
  assert.ok(command.trimStart().startsWith(`${f.finish.pid} `) && command.includes('worktree-fsmonitor-stop.pl'));
  const exited = once(f.finish, 'exit');
  f.finish.kill('SIGKILL');
  await exited;
  process.kill(control.pid, 'SIGKILL'); // Exact helper created by this fixture, never a discovered global PID.
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
  return records[0];
}

describe('native IPC initialization failures', { skip: process.platform !== 'darwin', timeout: 180000 }, () => {
  for (const environment of ['changed', 'replaced', 'relative'])
    it(`recovers an interrupted owner with a different TMPDIR, mode=${environment}`, () =>
      scheduledFinish('stop', async (f) => {
        const replaceControl = environment !== 'changed';
        const base = await orphanOwnController(f);
        const recordedControl = base.controlPath;
        const retryTmp = environment === 'relative' ? 'new-tmp' : join(f.fx.root, 'new-tmp');
        mkdirSync(resolve(f.fx.repo, retryTmp), { mode: 0o700 });
        if (replaceControl) {
          renameSync(recordedControl, join(f.fx.root, 'preserved-original-control'));
          mkdirSync(recordedControl, { mode: 0o700 });
          writeFileSync(join(recordedControl, 'preserve.txt'), 'replacement staging original\n');
          const refused = finishInEnvironment(f, { TMPDIR: retryTmp });
          assert.notEqual(refused.code, 0);
          assert.equal(lstatSync(f.socket).mode & 0o777, base.mode, 'failed recovery left socket admission closed');
          assert.equal(existsSync(`${f.socket}.lock`), false, 'failed recovery stranded its proven startup mutex');
        }
        const released = finishInEnvironment(f, { TMPDIR: retryTmp });
        assert.equal(released.code, 0, released.error);
        assert.equal(released.receipt.storageDisposition, 'removed');
        assert.equal(f.fx.finish(f.path, { mode: 'check' }).state, 'released');
        if (replaceControl) {
          assert.equal(readFileSync(join(recordedControl, 'preserve.txt'), 'utf8'), 'replacement staging original\n');
          rmSync(recordedControl, { recursive: true }); // This fixture's deliberately replaced control root only.
        }
      }));
  it('does not publish an empty canonical mutex when the first real journal write fails', () =>
    scheduledFinish(
      'unmatched',
      async (f) => {
        assert.notEqual((await f.complete()).code, 0);
        assert.equal(
          existsSync(`${f.socket}.lock`),
          false,
          'failed first write published an unrecoverable canonical lock',
        );
        const released = f.fx.finish(f.path, { cwdProbe: undefined });
        assert.equal(released.storageDisposition, 'removed');
      },
      '',
      { fileSizeLimit: 0 },
    ));

  for (const step of ['mkdir', 'sysopen', 'bind', 'link'])
    it(`retries after a real controller interruption at ${step}, before its control record`, () =>
      scheduledFinish(
        'control',
        async (f) => {
          const pid = Number(readFileSync(f.marker, 'utf8'));
          const process = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], { encoding: 'utf8' }).stdout;
          assert.ok(process.includes(String(f.finish.pid)) && process.includes('worktree-fsmonitor-stop.pl'));
          const base = f.journal()[0];
          globalThis.process.kill(pid, 'SIGKILL'); // The exact helper of this fixture's finish.
          assert.notEqual((await f.complete()).code, 0);
          assert.equal(existsSync(`${f.socket}.lock`), false, 'incomplete control setup permanently held startup');
          const released = f.fx.finish(f.path, { cwdProbe: undefined });
          assert.equal(released.storageDisposition, 'removed');
          if (base.controlPath) rmSync(base.controlPath, { recursive: true, force: true }); // Own fixture's preserved staging.
        },
        '',
        { pauseControl: step },
      ));

  it('preserves an unrelated empty staging directory after exclusive creation fails', () =>
    scheduledFinish(
      'status',
      async (f) => {
        assert.notEqual((await f.complete()).code, 0);
        const path = readFileSync(f.collision, 'utf8');
        assert.equal(existsSync(path), true, 'failed mkdir removed a directory it did not create');
        assert.equal(existsSync(`${f.socket}.lock`), false);
        rmSync(path, { recursive: true }); // Only the empty directory deliberately created by this fixture.
      },
      '',
      { collideControl: true },
    ));

  it('leaves a foreign canonical Git lock unchanged', () =>
    scheduledFinish('status', async (f) => {
      const lock = `${f.socket}.lock`;
      writeFileSync(lock, 'foreign Git initialization\n', { flag: 'wx' });
      assert.notEqual((await f.complete()).code, 0);
      assert.equal(readFileSync(lock, 'utf8'), 'foreign Git initialization\n');
      unlinkSync(lock); // Only the foreign sentinel deliberately created by this fixture.
    }));

  it('restores after an interrupted final journal append without accepting the incomplete row', () =>
    scheduledFinish('stop', async (f) => {
      const rows = f.journal();
      const helper = rows.findLast((row) => row.phase === 'control');
      f.finish.kill('SIGSTOP');
      try {
        process.kill(helper.pid, 'SIGKILL'); // Exact controller recorded by this fixture.
        appendFileSync(`${f.socket}.lock`, '{"phase":"stopped"');
      } finally {
        f.finish.kill('SIGCONT');
      }
      assert.notEqual((await f.complete()).code, 0);
      assert.equal(existsSync(`${f.socket}.lock`), false);
      assert.equal(spawnSync(f.realGit, ['-C', f.path, 'fsmonitor--daemon', 'status']).status, 0);
      assert.equal(f.fx.finish(f.path, { cwdProbe: undefined }).storageDisposition, 'removed');
    }));

  it('preserves a replaced control inode rather than unlinking its same-name replacement', () =>
    scheduledFinish('stop', async (f) => {
      const base = f.journal()[0];
      const head = join(base.controlPath, 'HEAD');
      unlinkSync(head);
      writeFileSync(head, 'preserve replacement\n', { flag: 'wx' });
      assert.notEqual((await f.complete()).code, 0);
      assert.equal(readFileSync(head, 'utf8'), 'preserve replacement\n');
      assert.equal(existsSync(`${f.socket}.lock`), false);
      rmSync(base.controlPath, { recursive: true }); // Only this fixture's external staging and replacement sentinel.
    }));
});
