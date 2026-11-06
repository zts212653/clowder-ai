import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findScheduledRun, prepareDesktop } from './nightly-desktop.mjs';

test('the Codex scheduled entry selects only the current Shanghai calendar day', () => {
  const repository = 'zts212653/clowder-ai';
  const now = new Date('2026-11-06T16:10:00Z');
  const yesterday = { id: 100, event: 'schedule', created_at: '2026-11-05T16:08:00Z' };
  const today = { id: 101, event: 'schedule', created_at: '2026-11-06T16:08:00Z' };
  const gh = (workflow_runs) => (args) => {
    assert.deepEqual(args, [
      'api',
      `repos/${repository}/actions/workflows/desktop-nightly.yml/runs?event=schedule&per_page=10`,
    ]);
    return JSON.stringify({ workflow_runs });
  };
  assert.equal(findScheduledRun(repository, now, gh([today, yesterday])), '101');
  assert.throws(() => findScheduledRun(repository, now, gh([yesterday])), /2026-11-07/);
});

test('desktop preparation stages the same attempt and rejects different installer bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-prepare-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = 'zts212653/clowder-ai';
  const source = 'a'.repeat(40);
  const catalogRevision = 'b'.repeat(40);
  const platform = 'windows-x64';
  const digest = createHash('sha256').update('candidate bytes').digest('hex');
  const report = {
    runId: '123',
    attempt: '2',
    source,
    catalogRevision,
    packageVersion: '1.14.0',
    platforms: [platform],
    cases: [{ id: 'DESKTOP-ONBOARDING', platform, executor: 'computer-use' }],
  };
  const prepare = (dir, bytes) =>
    prepareDesktop(repo, '123', platform, dir, (args) => {
      if (args[0] === 'api') {
        return JSON.stringify({
          status: 'completed',
          path: '.github/workflows/desktop-nightly.yml',
          head_sha: catalogRevision,
          run_attempt: 2,
        });
      }
      const [artifact, , destination] = args.slice(-3);
      fs.mkdirSync(destination, { recursive: true });
      if (artifact === 'desktop-nightly-report-attempt-2') {
        fs.writeFileSync(path.join(destination, 'report.json'), JSON.stringify(report));
      } else if (artifact === 'desktop-evidence-windows-x64-attempt-2') {
        fs.mkdirSync(path.join(destination, 'installer'));
        fs.writeFileSync(
          path.join(destination, 'installer', 'distribution-sha256.json'),
          JSON.stringify({ Hash: digest.toUpperCase() }),
        );
      } else {
        assert.equal(artifact, 'windows-installer-1.14.0-attempt-2');
        fs.writeFileSync(path.join(destination, 'ClowderAI-Setup-1.14.0.exe'), bytes);
      }
      return '';
    });

  const ready = await prepare(path.join(root, 'ready'), 'candidate bytes');
  assert.equal(ready.packageSha256, digest);
  assert.equal(ready.source, source);
  assert.equal(ready.attempt, '2');
  assert.deepEqual(
    ready.cases.map(({ id }) => id),
    ['DESKTOP-ONBOARDING'],
  );
  await assert.rejects(prepare(path.join(root, 'wrong'), 'other bytes'), /Candidate package hash mismatch/);
  assert.equal(fs.existsSync(path.join(root, 'wrong', 'desktop-plan.json')), false);
});
