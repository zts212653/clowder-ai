import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readGitHubApiResource } from '../dist/infrastructure/github/github-object-validator.js';

function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  try {
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    return true;
  }
}

function restorePath(priorPath) {
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
}

function killHelper(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

describe('default GitHub validation process ownership', { concurrency: false }, () => {
  // C1 retires Host review-wait/conflict executors. This suite covers the
  // retained Host transport; plugin producers own their transport coverage.
  test(
    'object lookup',
    { skip: process.platform === 'win32' ? 'POSIX credential subprocess lifecycle' : false },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gh-validation-cleanup-'));
      const helperPidFile = join(dir, 'helper.pid');
      const helperFile = join(dir, 'helper.cjs');
      const ghFile = join(dir, 'gh');
      const priorPath = process.env.PATH;
      const priorLocalCommandFixtures = process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES;
      let helperPid;
      try {
        await writeFile(
          helperFile,
          `process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(${JSON.stringify(helperPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        );
        await writeFile(
          ghFile,
          `#!${process.execPath}
const fs = require('node:fs');
require('node:child_process').spawn(process.execPath, [${JSON.stringify(helperFile)}], { stdio: 'ignore' });
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(helperPidFile)})) return;
  clearInterval(timer);
  process.stdout.write('42', () => process.exit(0));
}, 10);
`,
        );
        await chmod(ghFile, 0o755);
        process.env.PATH = `${dir}${delimiter}${priorPath ?? ''}`;
        process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES = ghFile;
        // Exercise the actual default transport: injecting execFileAsync would
        // hide the production wiring defect that leaves the helper orphaned.
        assert.equal(await readGitHubApiResource('repos/owner/repo/pulls/42', '.number'), '42');
        helperPid = Number(await readFile(helperPidFile, 'utf8'));
        assert.ok(Number.isInteger(helperPid) && helperPid > 0);
        for (let i = 0; i < 100 && isRunning(helperPid); i++) await delay(10);
        assert.equal(isRunning(helperPid), false, 'credential helper survived the completed default validation');
      } finally {
        restorePath(priorPath);
        if (priorLocalCommandFixtures === undefined) delete process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES;
        else process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES = priorLocalCommandFixtures;
        helperPid ??= Number(await readFile(helperPidFile, 'utf8').catch(() => ''));
        killHelper(helperPid);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
