import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { original, stop, stoppedFixture } from './lib/preview-alpha-settlement-test-fixture.mjs';

for (const [name, change, pattern] of [
  [
    'registration preceding runner birth',
    (f) => {
      f.record.startedAt = '2026-09-30T19:59:49.000Z';
      f.write(f.config.recordPath, f.record);
    },
    /supervisor lifetime is inconsistent/,
  ],
  [
    'unknown supervisor',
    (f) => {
      f.recovery.isRunning = () => undefined;
    },
    /live or unproven/,
  ],
  [
    'live owner',
    (f) => {
      f.recovery.isRunning = () => true;
    },
    /live or unproven/,
  ],
  [
    'unknown group',
    (f) => {
      f.recovery.groupRunning = () => undefined;
    },
    /live or unproven/,
  ],
  [
    'unreadable listeners',
    (f) => {
      f.recovery.readListeners = () => {
        throw new Error('fixture observation unavailable');
      };
    },
    /unavailable/,
  ],
  [
    'live Redis listener',
    (f) => {
      f.recovery.readListeners = (port) => (port === f.proof.port ? [f.proof.pid] : []);
    },
    /Redis port is live/,
  ],
  [
    'conflicting lease',
    (f) => {
      f.write(join(f.recovery.registryDir, `redis-${f.proof.port}-123-456.json`), {});
    },
    /producer lease/,
  ],
  [
    'unreadable lease registry',
    (f) => {
      renameSync(f.recovery.registryDir, `${f.recovery.registryDir}.old`);
    },
    /ENOENT/,
  ],
  [
    'bad original completion',
    (f) => {
      f.write(f.record.completionPath, { ...f.completion, exitCode: '1' });
    },
    /cleanup incomplete or failed/,
  ],
  [
    'foreign owner group',
    (f) => {
      f.write(`${f.record.completionPath}.owner.json`, { ...f.owner, processGroupId: 0 });
    },
    /inconsistent/,
  ],
  [
    'linked RDB',
    (f) => {
      renameSync(f.dumpFile, `${f.dumpFile}.original`);
      symlinkSync(`${f.dumpFile}.original`, f.dumpFile);
    },
    /linked/,
  ],
  [
    'damaged RDB',
    (f) => {
      writeFileSync(f.dumpFile, 'damaged fixture');
    },
    /RDB evidence/,
  ],
]) {
  test(`no registration or data mutation for ${name}`, async (t) => {
    const f = stoppedFixture(t);
    change(f);
    const before = original(f);
    await assert.rejects(stop(f), pattern);
    assert.ok(existsSync(f.config.recordPath));
    assert.deepEqual(original(f), before);
  });
}

test('source or RDB drift after journal publication never releases registration', async (t) => {
  for (const target of ['record', 'rdb']) {
    const f = stoppedFixture(t);
    f.recovery.afterSettlementJournal = () => {
      if (target === 'record') f.write(f.config.recordPath, { ...f.record, readyAt: new Date().toISOString() });
      else writeFileSync(f.dumpFile, Buffer.concat([readFileSync(f.dumpFile), Buffer.from('changed')]));
    };
    await assert.rejects(stop(f), /source bytes changed/);
    assert.ok(existsSync(f.config.recordPath));
  }
});

test('a linked lease registry is not evidence of absence', async (t) => {
  const f = stoppedFixture(t);
  const directory = f.recovery.registryDir;
  renameSync(directory, `${directory}.original`);
  symlinkSync(`${directory}.original`, directory, 'dir');
  await assert.rejects(stop(f), /registry is linked/);
  assert.ok(existsSync(f.config.recordPath));
});

for (const mode of ['auto-restart', 'unknown']) {
  test(`launchd ${mode} cannot retire a stopped registration`, async (t) => {
    const f = stoppedFixture(t);
    f.config.launchdLabel = `com.catcafe.preview.${f.config.id}`;
    f.config.plistPath = join(f.config.stateDir, `${f.config.id}.plist`);
    f.record.origin = 'launchd';
    f.record.launchdLabel = f.config.launchdLabel;
    f.record.plistPath = f.config.plistPath;
    const arguments_ = [process.execPath, '/fixture/preview-process-lease-runner.mjs'];
    f.record.processCommand = arguments_.join(' ');
    const plist = {
      KeepAlive: mode === 'auto-restart',
      Label: f.config.launchdLabel,
      WorkingDirectory: f.mainRoot,
      ProgramArguments: arguments_,
    };
    f.write(f.config.plistPath, plist);
    f.write(f.config.recordPath, f.record);
    f.recovery.readJob = (program) => {
      if (program === 'plutil') return JSON.stringify(plist);
      throw new Error('fixture launchd observation unknown');
    };
    await assert.rejects(stop(f), mode === 'auto-restart' ? /may restart/ : /observation unknown/);
    assert.ok(existsSync(f.config.recordPath));
  });
}

test('contradictory explicit cleanup outcomes are not accepted as a legacy result', async (t) => {
  const f = stoppedFixture(t);
  f.write(f.record.completionPath, { ...f.completion, version: 2, commandExitCode: 1, cleanupExitCode: 1 });
  f.write(`${f.record.completionPath}.owner.json`, {
    ...f.owner,
    version: 2,
    exitCode: 0,
    commandExitCode: 1,
    cleanupExitCode: 0,
  });
  await assert.rejects(stop(f), /versioned preview outcomes are inconsistent/);
  assert.ok(existsSync(f.config.recordPath));
});

test('a changed durable receipt makes subsequent queries unverified', async (t) => {
  const f = stoppedFixture(t);
  const result = await stop(f);
  writeFileSync(join(result.settlement.journalPath, 'result.json'), '{}');
  const queried = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
      'status',
      '--cwd',
      f.mainRoot,
      '--port',
      String(f.config.port),
      '--json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
      timeout: 5000,
    },
  );
  assert.equal(queried.status, 1);
  assert.equal(queried.stdout, '');
  assert.match(queried.stderr, /receipt changed/);
});

test('damaged registration is not treated as missing even with a completed settlement', async (t) => {
  const f = stoppedFixture(t);
  await stop(f);
  writeFileSync(f.config.recordPath, '{broken');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
      'stop',
      '--cwd',
      f.mainRoot,
      '--port',
      String(f.config.port),
      '--json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim());
  assert.equal(readFileSync(f.config.recordPath, 'utf8'), '{broken');
});
