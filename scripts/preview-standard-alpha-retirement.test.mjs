import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { readPreviewSettlement, readRetiredPreviewRecord } from './lib/preview-registration-receipts.mjs';
import { standardAlphaDeadFixture } from './lib/preview-standard-alpha-test-fixture.mjs';
import { removeLaunchdJob } from './preview-process-launchers.mjs';

for (const [mode, expectedExit, expectedBusiness, expectedCleanup, expectedPrior] of [
  ['unclaimed-v2', 128, 128, null, 'unclaimed'],
  ['unclaimed-legacy', 1, null, null, 'unclaimed'],
  ['failed-owner-v2', 1, 0, 1, 'failed'],
  ['failed-owner-legacy', 1, null, null, 'legacy_unseparated'],
])
  test(`standard Alpha ${mode} dead registration retires cleanly with exit 3 while preserving original receipts and shared 6397`, async (t) => {
    const f = standardAlphaDeadFixture(t, { mode });
    // Shared Redis 6397 may legitimately remain running; only 3011/3012/4111/5211 must be absent.
    f.recovery.readListeners = (port) => (port === 6397 ? [77777] : []);
    const beforeCompletion = readFileSync(f.record.completionPath);
    const hasOwner = mode.startsWith('failed-owner');
    const beforeOwner = hasOwner ? readFileSync(`${f.record.completionPath}.owner.json`) : null;

    const result = await stop(f);
    const s = result.settlement;
    assert.equal(s.status, 'registration_retired');
    assert.equal(s.registered, false);
    assert.equal(s.originalExitCode, expectedExit);
    assert.equal(s.businessExitCode, expectedBusiness);
    assert.equal(s.cleanupExitCode, expectedCleanup);
    assert.equal(s.cleanupStatus, 'unknown');
    assert.equal(s.priorCleanupStatus, expectedPrior);
    assert.equal(s.otherResourcesStatus, 'not_reverified');
    assert.equal(s.persistenceStatus, 'not_reverified');
    assert.equal(existsSync(f.config.recordPath), false);
    assert.deepEqual(readFileSync(f.record.completionPath), beforeCompletion);
    if (hasOwner) assert.deepEqual(readFileSync(`${f.record.completionPath}.owner.json`), beforeOwner);

    assert.deepEqual(readPreviewSettlement(f.config), s);
    assert.equal(readRetiredPreviewRecord(f.config).id, f.config.id);
    const journal = JSON.parse(readFileSync(join(s.journalPath, 'result.json'), 'utf8'));
    assert.equal(journal.kind, 'standard-alpha-registration-retirement');

    for (const action of ['status', 'stop']) {
      const cli = spawnSync(
        process.execPath,
        [
          '--import',
          f.virtualPort3011PreloadUrl,
          fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
          action,
          '--cwd',
          f.config.cwd,
          '--port',
          '3011',
          '--json',
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
        },
      );
      assert.equal(cli.status, 3, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).status, 'registration_retired');
    }
  });

test('after standard Alpha dead registration retirement, subsequent preview start clears settlement pointer without unsettled block', async (t) => {
  const f = standardAlphaDeadFixture(t, { mode: 'unclaimed-v2' });
  await stop(f);
  t.after(() => removeLaunchdJob({ launchdLabel: f.config.launchdLabel }));
  const cli = spawnSync(
    process.execPath,
    [
      '--import',
      f.virtualPort3011PreloadUrl,
      fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
      'start',
      '--cwd',
      f.config.cwd,
      '--port',
      '3011',
      '--',
      process.execPath,
      '-e',
      'process.exit(9)',
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
    },
  );
  // Process exits 9 before listening, proving start moved past unsettled-cleanup refusal and cleared old pointer.
  assert.doesNotMatch(cli.stderr, /cleanup remains unsettled/);
  assert.equal(existsSync(join(f.config.stateDir, `${f.config.id}.settlement.json`)), false);
});
