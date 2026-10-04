import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./run-public-test-distributable.sh', import.meta.url));
const requiresRootLinux = process.platform !== 'linux' || process.getuid() !== 0;
// Match the actual checkout owner on hosted runners; a made-up uid cannot
// traverse runner-private parent directories after setpriv.
const runnerUid = process.env.SUDO_UID ?? '1000';
const runnerGid = process.env.SUDO_GID ?? '1000';
const args = (code) => [launcher, runnerUid, runnerGid, process.env.PATH, process.execPath, '-e', code];
const run = (code, { isolated = true } = {}) =>
  spawnSync(isolated ? 'unshare' : launcher, isolated ? ['--net', '--', ...args(code)] : args(code).slice(1), {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, CAT_CAFE_PUBLIC_TEST_NETNS_PROOF: '/forged/path' },
  });

describe(
  'public-test launcher kernel receipt',
  { skip: requiresRootLinux && 'requires isolated Linux root to create a network namespace' },
  () => {
    it('emits a protected receipt for the exact child namespace before dropping all privileges', () => {
      const child = run(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const receiptPath = process.env.CAT_CAFE_PUBLIC_TEST_NETNS_PROOF;
      assert.notEqual(receiptPath, '/forged/path');
      const directory = fs.lstatSync(path.dirname(receiptPath));
      const file = fs.lstatSync(receiptPath);
      assert.equal(directory.uid, 0);
      assert.equal(directory.mode & 0o777, 0o755);
      assert.equal(file.uid, 0);
      assert.equal(file.mode & 0o777, 0o444);
      assert.ok(file.isFile() && !file.isSymbolicLink());
      assert.throws(() => fs.openSync(receiptPath, 'w'), { code: 'EACCES' });
      assert.throws(() => fs.unlinkSync(receiptPath), { code: 'EACCES' });
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      const ns = fs.statSync('/proc/self/ns/net', { bigint: true });
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.isolated, ns.dev + ':' + ns.ino);
      assert.notEqual(receipt.host, receipt.isolated);
      assert.equal(receipt.bootId, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      assert.match(receipt.nonce, /^[a-f0-9-]{36}$/);
      assert.notEqual(process.getuid(), 0);
      process.stdout.write(JSON.stringify({ receipt: 'verified', nonce: receipt.nonce }));
    `);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(JSON.parse(child.stdout).receipt, 'verified');
    });

    it('refuses same-host launch rather than issuing proof for an empty route table', () => {
      const child = run('process.stdout.write("must-not-run")', { isolated: false });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /shares the host network namespace/);
      assert.doesNotMatch(child.stdout, /must-not-run/);
    });

    it('preserves the command exit status through the privilege boundary', () => {
      const child = run('process.exit(37)');
      assert.equal(child.status, 37, child.stdout + child.stderr);
    });
  },
);
