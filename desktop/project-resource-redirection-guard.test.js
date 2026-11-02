const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

test(
  'real Windows RedirectionGuard rejects old non-admin junctions but permits physical resources and consumers',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async (t) => {
    const root =
      process.env.CLOWDER_REDIRECTION_FIXTURE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'redirection-guard-'));
    if (!process.env.CLOWDER_REDIRECTION_FIXTURE_ROOT) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const worker = path.join(__dirname, 'test-fixtures/redirection-guard-worker.cjs');
    const batch = path.join(root, 'create.cmd');
    fs.writeFileSync(
      batch,
      `@echo off\r\n"${process.execPath}" "${worker}" create "${root}" > "${root}/creator-output.txt" 2>&1\r\n`,
    );
    const env = { ...process.env, CLOWDER_REDIRECTION_FIXTURE_ROOT: root };
    const run = (script, args) =>
      spawnSync(
        'pwsh.exe',
        ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'test-fixtures', script), ...args],
        { env, windowsHide: true, encoding: 'utf8', timeout: 30000 },
      );
    const creation = run('create-restricted-fixture.ps1', ['-BatchFile', batch]);
    assert.equal(creation.status, 0, creation.stderr);
    const creatorPid = JSON.parse(creation.stdout.trim()).pid;
    const receipt = path.join(root, 'receipt.json');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(receipt); attempt += 1) await delay(100);
    if (!fs.existsSync(receipt)) {
      try {
        process.kill(creatorPid);
      } catch {
        /* Already exited. */
      }
      assert.fail(
        `Restricted junction creator did not finish: ${fs.readFileSync(path.join(root, 'creator-output.txt'), 'utf8')}`,
      );
    }
    assert.equal(JSON.parse(fs.readFileSync(receipt)).phase, 'restricted-junctions-created');
    const guarded = run('guarded-node.ps1', ['-NodeExe', process.execPath, '-Worker', worker]);
    const errorFile = path.join(root, 'worker-error.txt');
    assert.equal(
      guarded.status,
      0,
      `${guarded.stdout}\n${guarded.stderr}\n${fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : ''}`,
    );
    const result = JSON.parse(fs.readFileSync(receipt));
    assert.equal(result.phase, 'guarded-readiness-passed');
    assert.deepEqual(result.after, []);
    assert.equal(result.historyPreserved, true);
    if (fs.existsSync(path.join(__dirname, '../packages/api/dist/index.js'))) {
      assert.equal(result.apiConsumers.status, 'passed');
    }
    assert.match(guarded.stdout, /flags=1/);
  },
);
