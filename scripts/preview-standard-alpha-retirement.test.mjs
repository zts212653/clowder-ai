import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

test('standard Alpha dead registration retires cleanly when older dead historical port-3011 records exist in stateDir without mutating them', async (t) => {
  const f = standardAlphaDeadFixture(t, { mode: 'unclaimed-v2' });
  const targetStartMs = Date.parse(f.record.startedAt);
  const olderIso = new Date(targetStartMs - 60_000).toISOString();
  const unloadedId = '1111111111111111';
  const loadedIdleId = '2222222222222222';
  const unloadedPath = join(f.config.stateDir, `${unloadedId}.json`);
  const unloadedPlistPath = join(f.config.stateDir, `${unloadedId}.plist`);
  const loadedIdlePath = join(f.config.stateDir, `${loadedIdleId}.json`);
  const loadedIdlePlistPath = join(f.config.stateDir, `${loadedIdleId}.plist`);
  const olderV2Path = join(f.config.stateDir, 'bbbbbbbbbbbbbbbb.json');
  const olderV2CompletionPath = join(
    f.config.stateDir,
    'bbbbbbbbbbbbbbbb.22222222-2222-4222-8222-222222222222.completion.json',
  );
  const olderUnknownCmdPath = join(f.config.stateDir, 'cccccccccccccccc.json');
  const olderUnknownCmdCompletionPath = join(
    f.config.stateDir,
    'cccccccccccccccc.33333333-3333-4333-8333-333333333333.completion.json',
  );

  f.write(unloadedPath, {
    version: 1,
    id: unloadedId,
    cwd: join(f.directory, 'cat-cafe-old-unloaded'),
    port: 3011,
    command: ['pnpm', 'alpha:start'],
    origin: process.platform === 'darwin' ? 'launchd' : 'detached',
    launchdLabel: `com.catcafe.preview.${unloadedId}`,
    plistPath: unloadedPlistPath,
    pid: 900000881,
    processStartedAt: 'Tue Aug 25 08:39:44 2026',
    processCommand: `xpcproxy com.catcafe.preview.${unloadedId}`,
    startedAt: olderIso,
    logPath: join(f.config.stateDir, `${unloadedId}.log`),
  });
  f.write(loadedIdlePath, {
    version: 1,
    id: loadedIdleId,
    cwd: join(f.directory, 'cat-cafe-old-loaded-idle'),
    port: 3011,
    command: ['pnpm', 'alpha:start'],
    origin: process.platform === 'darwin' ? 'launchd' : 'detached',
    launchdLabel: `com.catcafe.preview.${loadedIdleId}`,
    plistPath: loadedIdlePlistPath,
    pid: 900000885,
    processStartedAt: 'Tue Aug 25 09:00:00 2026',
    processCommand: `xpcproxy com.catcafe.preview.${loadedIdleId}`,
    startedAt: olderIso,
    logPath: join(f.config.stateDir, `${loadedIdleId}.log`),
  });
  f.write(loadedIdlePlistPath, { Label: `com.catcafe.preview.${loadedIdleId}`, KeepAlive: false });

  f.write(olderV2Path, {
    version: 1,
    id: 'bbbbbbbbbbbbbbbb',
    cwd: join(f.directory, 'cat-cafe-alpha'),
    port: 3011,
    command: ['pnpm', 'alpha:start'],
    origin: 'detached',
    pid: 900000882,
    processStartedAt: 'Sat Sep 19 07:02:21 2026',
    processCommand: 'node preview-process-lease-runner.mjs',
    startedAt: olderIso,
    expiresAt: new Date(targetStartMs - 30_000).toISOString(),
    completionPath: olderV2CompletionPath,
    logPath: join(f.config.stateDir, 'bbbbbbbbbbbbbbbb.log'),
  });
  f.write(`${olderV2CompletionPath}.owner.json`, {
    pid: 900000883,
    processGroupId: 900000883,
    version: 2,
    exitCode: 1,
    commandExitCode: 0,
    cleanupExitCode: 1,
  });
  f.write(`${olderV2CompletionPath}.command.json`, {
    version: 1,
    identityStatus: 'observed',
    pid: 900000884,
    processGroupId: 900000884,
  });

  f.write(olderUnknownCmdPath, {
    version: 1,
    id: 'cccccccccccccccc',
    cwd: join(f.directory, 'cat-cafe-fast-exit'),
    port: 3011,
    command: ['pnpm', 'alpha:start'],
    origin: 'detached',
    pid: 900000886,
    startedAt: olderIso,
    completionPath: olderUnknownCmdCompletionPath,
  });
  f.write(`${olderUnknownCmdCompletionPath}.command.json`, {
    version: 1,
    identityStatus: 'unknown',
    pid: null,
    processGroupId: null,
  });

  const beforeUnloaded = readFileSync(unloadedPath);
  const beforeLoadedIdle = readFileSync(loadedIdlePath);
  const beforeV2 = readFileSync(olderV2Path);
  const beforeUnknownCmd = readFileSync(olderUnknownCmdPath);
  const readJobCalls = [];
  f.recovery.isRunning = () => false;
  f.recovery.groupRunning = () => false;
  f.recovery.readJob = (cmd, args) => {
    readJobCalls.push([cmd, ...args].join(' '));
    const target = String(args.at(-1) ?? '');
    if (cmd === 'launchctl' && target.endsWith(`com.catcafe.preview.${unloadedId}`)) {
      throw Object.assign(new Error('launchctl exited 113'), {
        status: 113,
        stderr: `Bad request.\nCould not find service "com.catcafe.preview.${unloadedId}" in domain for user gui: 501\n`,
      });
    }
    if (cmd === 'launchctl' && target.endsWith(`com.catcafe.preview.${loadedIdleId}`)) {
      return '\tstate = not running\n';
    }
    if (cmd === 'plutil' && target === loadedIdlePlistPath) {
      return JSON.stringify({ Label: `com.catcafe.preview.${loadedIdleId}`, KeepAlive: false });
    }
    throw new Error(`unexpected readJob call: ${cmd} ${args.join(' ')}`);
  };

  const result = await stop(f);
  assert.equal(result.settlement.status, 'registration_retired');
  assert.equal(existsSync(f.config.recordPath), false);
  if (process.platform === 'darwin') {
    const uid = process.getuid();
    assert.deepEqual(
      new Set(readJobCalls),
      new Set([
        `launchctl print gui/${uid}/com.catcafe.preview.${unloadedId}`,
        `launchctl print gui/${uid}/com.catcafe.preview.${loadedIdleId}`,
        `plutil -convert json -o - ${loadedIdlePlistPath}`,
      ]),
    );
  }
  assert.deepEqual(readFileSync(unloadedPath), beforeUnloaded);
  assert.deepEqual(readFileSync(loadedIdlePath), beforeLoadedIdle);
  assert.deepEqual(readFileSync(olderV2Path), beforeV2);
  assert.deepEqual(readFileSync(olderUnknownCmdPath), beforeUnknownCmd);
});

test('standard Alpha unclaimed retirement retains oversized (>16 MB) diagnostic log in place and archives bounded logs', async (t) => {
  const fLarge = standardAlphaDeadFixture(t, { mode: 'unclaimed-v2' });
  const fd = openSync(fLarge.record.logPath, 'wx', 0o600);
  try {
    ftruncateSync(fd, 17 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  const logBefore = statSync(fLarge.record.logPath);
  const largeRes = await stop(fLarge);
  assert.equal(largeRes.settlement.status, 'registration_retired');
  assert.equal(existsSync(fLarge.config.recordPath), false);
  assert.deepEqual(statSync(fLarge.record.logPath), logBefore);
  assert.equal(existsSync(join(largeRes.settlement.journalPath, 'preview.log')), false);
  const largeJournal = JSON.parse(readFileSync(join(largeRes.settlement.journalPath, 'result.json'), 'utf8'));
  assert.equal(largeJournal.diagnosticLog.path, fLarge.record.logPath);
  assert.equal(largeJournal.diagnosticLog.bytes, logBefore.size);
  assert.equal(largeJournal.diagnosticLog.status, 'retained_at_source');
  assert.deepEqual(readPreviewSettlement(fLarge.config), largeRes.settlement);
  assert.equal(readRetiredPreviewRecord(fLarge.config).id, fLarge.config.id);

  const fSmall = standardAlphaDeadFixture(t, { mode: 'unclaimed-v2' });
  writeFileSync(fSmall.record.logPath, 'bounded alpha log\n');
  const smallRes = await stop(fSmall);
  assert.equal(readFileSync(join(smallRes.settlement.journalPath, 'preview.log'), 'utf8'), 'bounded alpha log\n');
  const smallJournal = JSON.parse(readFileSync(join(smallRes.settlement.journalPath, 'result.json'), 'utf8'));
  assert.equal('diagnosticLog' in smallJournal, false);
});
