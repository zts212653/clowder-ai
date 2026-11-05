/**
 * #1838: a Windows API process that dies must not leave a provider it can no longer account for.
 *
 * These tests run real processes. The fixture host adopts its own kernel job, then spawns a provider
 * whose launcher exits immediately — the measured counterexample where the surviving writer's
 * ParentProcessId names a dead process, which is what defeats `taskkill /T /F` and any
 * walk-down-from-the-root reconstruction. Killing the host must still reap that writer.
 *
 * Everything here is an isolated fixture: temp directories, temp job names, and only the files and
 * PIDs this test just created.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
const modulePath = fileURLToPath(new URL('../dist/utils/windows-job-owner.js', import.meta.url));

const { adoptWindowsApiJob, parseWindowsJobOwnerRecord, queryWindowsJobStopEvidence, resolveWindowsJobStopEvidence } =
  await import(pathToFileURL(modulePath).href);
const { readWindowsJobExecutionLinks, recordWindowsJobExecutionLink } = await import(pathToFileURL(modulePath).href);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function killOwned(pid) {
  if (!pid || !alive(pid)) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Already gone.
  }
}

/**
 * A fixture host that adopts its own job, then forks the broken-chain provider tree.
 * Paths arrive as argv so nothing has to survive string escaping.
 */
const HOST_SCRIPT = `
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [scriptDir, dataDir, moduleUrl] = process.argv.slice(2);
const { adoptWindowsApiJob } = await import(moduleUrl);
const adoption = await adoptWindowsApiJob({ dataDir });
writeFileSync(join(scriptDir, 'adoption.json'), JSON.stringify(adoption));
if (!adoption.adopted) process.exit(3);
// Forked only after adoption, so the provider tree lands inside the job.
spawn(process.execPath, [join(scriptDir, 'launcher.cjs')], { stdio: 'ignore', windowsHide: true });
const deadline = Date.now() + 15000;
while (!existsSync(join(scriptDir, 'tree.json')) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!existsSync(join(scriptDir, 'tree.json'))) process.exit(4);
const tree = JSON.parse(readFileSync(join(scriptDir, 'tree.json'), 'utf8'));
writeFileSync(join(scriptDir, 'ready.json'), JSON.stringify({ host: process.pid, launcher: tree.launcher, writer: tree.writer }));
setInterval(() => {}, 1000);
`;

function writeFixture(scriptDir, dataDir) {
  writeFileSync(join(scriptDir, 'writer.cjs'), 'setInterval(() => {}, 1000);');
  // The launcher exits immediately after detaching its writer: the writer survives with a PPID
  // that names a process which no longer exists.
  writeFileSync(
    join(scriptDir, 'launcher.cjs'),
    [
      "const { spawn } = require('node:child_process');",
      "const path = require('node:path');",
      "const fs = require('node:fs');",
      "const writer = spawn(process.execPath, [path.join(__dirname, 'writer.cjs')], { stdio: 'ignore', detached: true });",
      'writer.unref();',
      "fs.writeFileSync(path.join(__dirname, 'tree.json'), JSON.stringify({ launcher: process.pid, writer: writer.pid }));",
    ].join('\n'),
  );
  writeFileSync(join(scriptDir, 'host.mjs'), HOST_SCRIPT);
  return {
    readyFile: join(scriptDir, 'ready.json'),
    adoptionFile: join(scriptDir, 'adoption.json'),
    moduleUrl: pathToFileURL(modulePath).href,
    dataDir,
  };
}

test(
  'a killed API job reaps a provider whose PPID chain was already broken',
  { skip: !isWindows, timeout: 180_000 },
  async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'issue1838-job-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'issue1838-job-data-'));
    let host;
    let tree;
    try {
      const fixture = writeFixture(scriptDir, dataDir);
      host = spawn(process.execPath, [join(scriptDir, 'host.mjs'), scriptDir, dataDir, fixture.moduleUrl], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      host.stderr.on('data', (chunk) => process.stderr.write(`[fixture-host] ${chunk}`));

      tree = await waitFor(
        () => (existsSync(fixture.readyFile) ? JSON.parse(readFileSync(fixture.readyFile, 'utf8')) : null),
        30_000,
        'fixture ready.json',
      );
      await waitFor(() => !alive(tree.launcher), 15_000, 'the launcher to exit');
      assert.equal(alive(tree.writer), true, 'the late writer must outlive its intermediate');

      const adoption = JSON.parse(readFileSync(fixture.adoptionFile, 'utf8'));
      assert.equal(adoption.adopted, true, `adoption must succeed: ${JSON.stringify(adoption)}`);

      // While the API runs, the job exists and owns both the host and the disconnected writer.
      const before = await queryWindowsJobStopEvidence(adoption.record.jobName);
      assert.equal(before.verdict, 'present', `a live API must read present: ${JSON.stringify(before)}`);
      assert.equal(before.activeProcesses, 2, 'the host and the orphaned writer both belong to the job');

      // Kill ONLY the API host: the kernel closes the job and reaps the tree.
      host.kill();
      await waitFor(() => !alive(tree.writer), 20_000, 'the job to reap the orphaned writer');
      assert.equal(alive(tree.host), false, 'the host is gone');
      assert.equal(
        alive(tree.writer),
        false,
        'the job must reap the writer even though its PPID names a dead launcher',
      );

      // A fresh process reads what the recovery path reads.
      const after = await queryWindowsJobStopEvidence(adoption.record.jobName);
      assert.equal(after.verdict, 'absent', `a dead owner must read absent: ${JSON.stringify(after)}`);

      const resolution = await resolveWindowsJobStopEvidence({ dataDir });
      assert.equal(resolution.verifiedStopped.length, 1, 'the dead owner resolves to a verified stop');
      assert.equal(resolution.unresolved.length, 0);
    } finally {
      if (host && host.exitCode === null) host.kill();
      await killOwned(tree?.writer);
      await killOwned(tree?.launcher);
      rmSync(scriptDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test('a query that cannot run is unknown, never a stop verdict', { timeout: 20_000 }, async () => {
  const jobName = `Local\\ClowderApiJob-${process.pid}`;
  const failed = await queryWindowsJobStopEvidence(jobName, {
    execute: async () => {
      throw new Error('powershell unavailable');
    },
  });
  assert.equal(failed.verdict, 'unknown');
  assert.equal(failed.activeProcesses, 0);

  const unparseable = await queryWindowsJobStopEvidence(jobName, {
    execute: async () => ({ stdout: 'not json at all', stderr: '' }),
  });
  assert.equal(unparseable.verdict, 'unknown');
});

test('malformed and foreign job records never become stop evidence', { timeout: 20_000 }, async () => {
  assert.equal(parseWindowsJobOwnerRecord(null), null);
  assert.equal(parseWindowsJobOwnerRecord({ v: 1 }), null);
  // A job outside our own namespace must never be adoptable as this deployment's ownership.
  assert.equal(
    parseWindowsJobOwnerRecord({ v: 1, jobName: 'Global\\Foreign', apiPid: 1, helperPid: 2, createdAt: 3 }),
    null,
  );
  assert.equal(
    parseWindowsJobOwnerRecord({ v: 1, jobName: 'Local\\ClowderApiJob-x', apiPid: 0, helperPid: 2, createdAt: 3 }),
    null,
  );
  const valid = `Local\\ClowderApiJob-${'a'.repeat(8)}-0000-4000-8000-000000000000`;
  assert.equal(
    parseWindowsJobOwnerRecord({ v: 1, jobName: valid, apiPid: 4321, helperPid: 4322, createdAt: 9 })?.apiPid,
    4321,
  );
});

test('the helper adopts the process it was actually pointed at', { skip: !isWindows, timeout: 60_000 }, async () => {
  // Adoption is refused for a pid whose command line does not match the expected script, so a
  // reused or foreign pid can never be silently taken over.
  const dataDir = mkdtempSync(join(tmpdir(), 'issue1838-adopt-'));
  try {
    const rejected = await adoptWindowsApiJob({
      dataDir,
      targetPid: process.pid,
      expectedScript: 'definitely-not-this-process.mjs',
    });
    assert.equal(rejected.adopted, false);
    assert.match(rejected.reason ?? '', /JOB_FAILED_NOT_OUR_PROCESS/);

    const accepted = await adoptWindowsApiJob({
      dataDir,
      targetPid: process.pid,
      expectedScript: basename(process.argv[1]),
    });
    assert.equal(accepted.adopted, true, `adoption must succeed: ${JSON.stringify(accepted)}`);
    const present = await queryWindowsJobStopEvidence(accepted.record.jobName);
    assert.equal(present.verdict, 'present', 'this live test process must read present');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('executions are linked to a job by name, not by a reusable pid', { timeout: 20_000 }, async () => {
  // The link is what scopes a verified stop to real executions. Keying it by job name keeps a dead
  // API's pid out of the decision: a reused pid can never resolve another instance's job.
  const dataDir = mkdtempSync(join(tmpdir(), 'issue1838-links-'));
  // Built from char codes so the separator survives every editing layer unharmed.
  const sep = String.fromCharCode(92);
  const jobA = `Local${sep}ClowderApiJob-${'a'.repeat(8)}-0000-4000-8000-00000000000a`;
  const jobB = `Local${sep}ClowderApiJob-${'b'.repeat(8)}-0000-4000-8000-00000000000b`;
  try {
    recordWindowsJobExecutionLink({ dataDir, jobName: jobA, invocationId: 'inv-a', executionId: 'exec-a' });
    recordWindowsJobExecutionLink({ dataDir, jobName: jobA, invocationId: 'inv-b', executionId: 'exec-b' });
    recordWindowsJobExecutionLink({ dataDir, jobName: jobB, invocationId: 'inv-c', executionId: 'exec-c' });

    const a = readWindowsJobExecutionLinks(jobA, dataDir);
    assert.deepEqual(a.links.map((link) => link.invocationId).sort(), ['inv-a', 'inv-b']);
    assert.equal(a.invalidPaths.length, 0);
    // A different job's links never leak into this one's evidence.
    assert.deepEqual(
      readWindowsJobExecutionLinks(jobB, dataDir).links.map((link) => link.invocationId),
      ['inv-c'],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
