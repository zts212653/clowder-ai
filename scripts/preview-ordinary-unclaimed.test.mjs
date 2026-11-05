import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { ordinaryUnclaimedFixture } from './lib/preview-ordinary-unclaimed-test-fixture.mjs';
import { removeLaunchdJob } from './preview-process-launchers.mjs';

for (const [version, exitCode, businessExitCode] of [
  ['legacy', 1, null],
  ['legacy', 0, null],
  ['v2', 1, null],
  ['v2', 0, 0],
  ['v2', 2, 2],
])
  test(`${version} ordinary once-ready service exit ${exitCode}/business ${businessExitCode} retires only its supervisor registration`, async (t) => {
    const f = ordinaryUnclaimedFixture(t, version),
      data = readFileSync(f.dumpFile);
    f.completion.exitCode = exitCode;
    if (version === 'v2') f.completion.commandExitCode = f.completion.runnerExitCode = businessExitCode;
    f.write(f.record.completionPath, f.completion);
    const before = readFileSync(f.record.completionPath);
    const result = await stop(f),
      s = result.settlement;
    assert.equal(s.status, 'registration_retired');
    assert.equal(s.originalExitCode, exitCode);
    assert.equal(s.businessExitCode, businessExitCode);
    assert.equal(s.cleanupExitCode, null);
    assert.equal(s.commandGroupStatus, 'unverified');
    assert.equal(s.otherResourcesStatus, 'not_reverified');
    assert.equal(s.persistenceStatus, 'not_reverified');
    assert.equal('shutdownExitCode' in s, false);
    assert.equal(existsSync(f.config.recordPath), false);
    assert.equal(existsSync(`${f.record.completionPath}.owner.json`), false);
    assert.deepEqual(readFileSync(f.record.completionPath), before);
    assert.deepEqual(readFileSync(f.dumpFile), data);
    const journal = JSON.parse(readFileSync(join(s.journalPath, 'result.json')));
    assert.equal(JSON.parse(readFileSync(join(s.journalPath, 'record.json'))).readyAt, f.record.readyAt);
    assert.deepEqual(journal.data, []);
    assert.equal(journal.dataCoordinatesStatus, 'unknown');
    for (const action of ['stop', 'status'])
      for (const json of [true, false]) {
        const r = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
            action,
            '--cwd',
            f.config.cwd,
            '--port',
            String(f.config.port),
            ...(json ? ['--json'] : []),
          ],
          {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
          },
        );
        assert.equal(r.status, 3, r.stderr);
        if (json) assert.equal(JSON.parse(r.stdout).settlement.businessExitCode, businessExitCode);
        else {
          assert.ok(r.stdout.includes(`business exit: ${businessExitCode ?? 'unknown'}`));
          assert.match(r.stdout, /other resources: not verified/);
        }
      }
  });

for (const version of ['legacy', 'v2'])
  test(`start preserves ${version} zero-exit registration when cleanup is unclaimed`, (t) => {
    const f = ordinaryUnclaimedFixture(t, version);
    f.completion.exitCode = 0;
    if (version === 'v2') f.completion.commandExitCode = f.completion.runnerExitCode = 0;
    f.write(f.record.completionPath, f.completion);
    const before = readFileSync(f.config.recordPath);
    t.after(() => removeLaunchdJob({ launchdLabel: `com.catcafe.preview.${f.config.id}` }));
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
        'start',
        '--cwd',
        f.config.cwd,
        '--port',
        String(f.config.port),
        '--',
        process.execPath,
        '-e',
        'process.exit(9)',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
      },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /cleanup remains unsettled/);
    assert.deepEqual(readFileSync(f.config.recordPath), before);
  });

test('ordinary retirement holds its mutation lock against concurrent stop and start', async (t) => {
  const f = ordinaryUnclaimedFixture(t);
  f.recovery.afterSettlementJournal = async () => {
    await assert.rejects(stop(f), /mutation already active/);
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
        'start',
        '--cwd',
        f.config.cwd,
        '--port',
        String(f.config.port),
        '--',
        process.execPath,
        '-e',
        'process.exit(9)',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
      },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /mutation already active/);
    assert.ok(existsSync(f.config.recordPath));
  };
  await stop(f);
});
