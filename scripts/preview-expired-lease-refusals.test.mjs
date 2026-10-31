import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireNamedAlphaLifecycle } from './lib/alpha-lifecycle-lock.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { expiredLeaseFixture, forensicAttempt, retainedBytes } from './lib/preview-expired-lease-test-fixture.mjs';

for (const [name, change, message] of [
  [
    'unknown Redis PID',
    (f) => {
      f.recovery.isRunning = () => undefined;
    },
    /live or unproven/,
  ],
  [
    'reused Redis PID',
    (f) => {
      f.recovery.isRunning = (pid) => pid === f.proof.pid;
    },
    /listener was replaced/,
  ],
  [
    'unknown supervisor',
    (f) => {
      f.recovery.isRunning = (pid) => (pid === f.record.pid ? undefined : false);
    },
    /live or unproven/,
  ],
  [
    'live owner',
    (f) => {
      f.recovery.isRunning = (pid) => pid === f.owner.pid;
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
    'unknown listeners',
    (f) => {
      f.recovery.readListeners = () => {
        throw new Error('fixture lsof timeout');
      };
    },
    /lsof timeout/,
  ],
  [
    'replacement Redis listener',
    (f) => {
      f.recovery.readListeners = (port) => (port === f.proof.port ? [123] : []);
    },
    /Redis PID or port/,
  ],
  [
    'occupied application port',
    (f) => {
      f.recovery.readListeners = (port) => (port === f.config.port ? [123] : []);
    },
    /application port/,
  ],
  [
    'conflicting same-port lease',
    (f) => {
      f.write(join(f.recovery.registryDir, `redis-${f.proof.port}-123-456.json`), {});
    },
    /set changed or conflicts/,
  ],
  [
    'another registered pre-listener generation',
    (f) => {
      f.write(join(f.config.stateDir, 'aaaaaaaaaaaaaaaa.json'), { port: f.proof.port, command: [] });
    },
    /another registered Alpha/,
  ],
  [
    'changed historical Redis birth',
    (f) => {
      f.lease.redis.process.startedAtEpochMs -= 1000;
      f.write(f.leaseFile, f.lease);
    },
    /historical process identity/,
  ],
  [
    'linked data directory',
    (f) => {
      renameSync(f.proof.dataDirectory, `${f.proof.dataDirectory}.old`);
      symlinkSync(`${f.proof.dataDirectory}.old`, f.proof.dataDirectory);
    },
    /exact Alpha home|linked|symlink/,
  ],
]) {
  test(`expired lease metadata remains intact for ${name}`, async (t) => {
    const f = expiredLeaseFixture(t);
    change(f);
    const before = retainedBytes(f);
    await assert.rejects(stop(f), message);
    assert.deepEqual(retainedBytes(f), before);
  });
}

for (const defect of ['shutdown-intent', 'invalid-result', 'foreign-attempt', 'incomplete-attempt']) {
  test(`whole recovery history refuses ${defect} without downgrading to metadata retirement`, async (t) => {
    const f = expiredLeaseFixture(t);
    const history = forensicAttempt(f);
    if (defect === 'shutdown-intent')
      f.write(join(history.directory, 'shutdown-intent.json'), { requestedAt: new Date().toISOString() });
    if (defect === 'invalid-result') f.write(join(history.directory, 'result.json'), {});
    if (defect === 'foreign-attempt')
      f.write(join(history.directory, 'attempt.json'), {
        ...JSON.parse(readFileSync(join(history.directory, 'attempt.json'))),
        redis: {},
      });
    if (defect === 'incomplete-attempt')
      renameSync(join(history.directory, 'lease.json'), join(history.directory, 'unknown.json'));
    const before = retainedBytes(f);
    await assert.rejects(stop(f), /unproven|inconsistent|another lifecycle|incomplete/);
    assert.deepEqual(retainedBytes(f), before);
  });
}

for (const target of ['data-content', 'data-file-set', 'lease', 'record']) {
  test(`drift in ${target} after journal publication preserves the live lease and registration`, async (t) => {
    const f = expiredLeaseFixture(t);
    f.recovery.afterSettlementJournal = () => {
      if (target === 'data-content') writeFileSync(f.dumpFile, 'changed');
      if (target === 'data-file-set') writeFileSync(join(f.proof.dataDirectory, 'new.aof'), 'new');
      if (target === 'lease') f.write(f.leaseFile, { ...f.lease, createdAt: new Date().toISOString() });
      if (target === 'record') f.write(f.config.recordPath, { ...f.record, readyAt: new Date().toISOString() });
    };
    await assert.rejects(stop(f), /source bytes changed|file set changed/);
    assert.ok(existsSync(f.config.recordPath));
    assert.ok(existsSync(f.leaseFile));
  });
}

test('a historical owner born before this supervisor cannot use delayed-registration retirement', async (t) => {
  const f = expiredLeaseFixture(t);
  f.lease.owner.process.startedAt = 'Wed Sep 30 19:59:49 2026';
  f.lease.owner.process.startedAtEpochMs = Date.parse('2026-09-30T19:59:49Z');
  f.write(f.leaseFile, f.lease);
  const before = retainedBytes(f);
  await assert.rejects(stop(f), /recorded owner lifetime/);
  assert.deepEqual(retainedBytes(f), before);
});

test('a named lifecycle reservation held before listening blocks old lease retirement', async (t) => {
  const f = expiredLeaseFixture(t);
  const unlock = await acquireNamedAlphaLifecycle(f.lease.coordinates);
  try {
    await assert.rejects(stop(f), /lifecycle is active or unproven/);
  } finally {
    await unlock();
  }
  assert.ok(existsSync(f.leaseFile));
});

for (const mode of ['automatic-restart', 'unknown']) {
  test(`expired lease cannot be retired with ${mode} launchd state`, async (t) => {
    const f = expiredLeaseFixture(t);
    f.config.launchdLabel = `com.catcafe.preview.${f.config.id}`;
    f.config.plistPath = join(f.config.stateDir, `${f.config.id}.plist`);
    const args = [process.execPath, '/fixture/preview-process-lease-runner.mjs'];
    Object.assign(f.record, {
      origin: 'launchd',
      launchdLabel: f.config.launchdLabel,
      plistPath: f.config.plistPath,
      processCommand: args.join(' '),
    });
    const plist = {
      Label: f.config.launchdLabel,
      KeepAlive: mode === 'automatic-restart',
      WorkingDirectory: f.mainRoot,
      ProgramArguments: args,
    };
    f.write(f.config.plistPath, plist);
    f.write(f.config.recordPath, f.record);
    f.recovery.readJob = (program) => {
      if (program === 'plutil') return JSON.stringify(plist);
      throw new Error('fixture launchd unknown');
    };
    const before = retainedBytes(f);
    await assert.rejects(stop(f), mode === 'automatic-restart' ? /may restart/ : /launchd unknown/);
    assert.deepEqual(retainedBytes(f), before);
  });
}
