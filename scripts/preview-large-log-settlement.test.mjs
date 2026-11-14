import assert from 'node:assert/strict';
import {
  appendFileSync,
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { original, stop, stoppedFixture } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { expiredLeaseFixture } from './lib/preview-expired-lease-test-fixture.mjs';
import { standardAlphaDeadFixture } from './lib/preview-standard-alpha-test-fixture.mjs';

function attachLargeLog(f) {
  const log = join(f.config.stateDir, `${f.config.id}.log`);
  f.record.logPath = log;
  f.write(f.config.recordPath, f.record);
  const fd = openSync(log, 'wx', 0o600);
  try {
    ftruncateSync(fd, 17 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  return log;
}

function ordinary(t) {
  const f = stoppedFixture(t);
  f.record.command = ['pnpm', 'dev:direct'];
  f.write(f.record.completionPath, {
    ...f.completion,
    version: 2,
    commandExitCode: 1,
    cleanupExitCode: 0,
    runnerExitCode: 1,
  });
  f.write(`${f.record.completionPath}.owner.json`, {
    ...f.owner,
    version: 2,
    exitCode: 0,
    commandExitCode: 1,
    cleanupExitCode: 0,
  });
  return f;
}

for (const [kind, fixture] of [
  ['ordinary', ordinary],
  ['named Alpha', stoppedFixture],
  ['expired lease', expiredLeaseFixture],
  ['standard Alpha', (t) => standardAlphaDeadFixture(t, { mode: 'failed-owner-v2' })],
]) {
  test(`${kind} stop retains a large diagnostic log in place and releases only proven stopped ownership`, async (t) => {
    const f = fixture(t);
    const log = attachLargeLog(f);
    const before = original(f);
    const logBefore = statSync(log);
    const result = await stop(f);
    assert.equal(existsSync(f.config.recordPath), false);
    assert.deepEqual(original(f), before);
    assert.deepEqual(statSync(log), logBefore, 'the original log must not be copied, truncated or replaced');
    assert.equal(existsSync(join(result.settlement.journalPath, 'preview.log')), false);
    const journal = JSON.parse(readFileSync(join(result.settlement.journalPath, 'result.json'), 'utf8'));
    assert.equal(journal.diagnosticLog.path, log);
    assert.equal(journal.diagnosticLog.bytes, logBefore.size);
    assert.equal(journal.diagnosticLog.status, 'retained_at_source');
    assert.equal(result.settlement.persistenceStatus, 'not_reverified');
    assert.equal('shutdownExitCode' in result.settlement, false);
    if (kind === 'ordinary') {
      assert.equal(result.settlement.businessExitCode, 1);
      assert.equal(result.settlement.cleanupExitCode, 0);
    }
  });
}

for (const change of ['append', 'symlink', 'coordinate', 'live-process']) {
  test(`large diagnostic log cannot hide ${change} during stopped registration settlement`, async (t) => {
    const f = stoppedFixture(t);
    const log = attachLargeLog(f);
    const before = original(f);
    if (change === 'coordinate') {
      f.record.logPath = join(f.config.stateDir, 'another.log');
      f.write(f.config.recordPath, f.record);
    } else if (change === 'live-process') {
      f.recovery.isRunning = () => true;
    } else {
      f.recovery.afterSettlementJournal = () => {
        if (change === 'append') appendFileSync(log, 'unexpected writer\n');
        else {
          renameSync(log, `${log}.original`);
          symlinkSync(`${log}.original`, log);
        }
      };
    }
    await assert.rejects(stop(f), /log|live|running/);
    assert.equal(existsSync(f.config.recordPath), true);
    assert.deepEqual(original(f), before);
  });
}

for (const change of ['append', 'symlink', 'nonexistent-coordinate', 'created-mid-retirement']) {
  test(`standard Alpha retirement rejects ${change} diagnostic log anomaly without removing record`, async (t) => {
    const f = standardAlphaDeadFixture(t, { mode: 'unclaimed-v2' });
    if (change === 'nonexistent-coordinate') {
      f.record.logPath = join(f.config.stateDir, 'missing-other.log');
      f.write(f.config.recordPath, f.record);
    } else if (change === 'created-mid-retirement') {
      f.recovery.afterSettlementJournal = () => {
        writeFileSync(f.record.logPath, 'late writer\n');
      };
    } else {
      const log = attachLargeLog(f);
      f.recovery.afterSettlementJournal = () => {
        if (change === 'append') appendFileSync(log, 'unexpected writer\n');
        else {
          renameSync(log, `${log}.original`);
          symlinkSync(`${log}.original`, log);
        }
      };
    }
    const beforeRecord = readFileSync(f.config.recordPath);
    const beforeCompletion = readFileSync(f.record.completionPath);
    await assert.rejects(stop(f), /log/);
    assert.equal(existsSync(f.config.recordPath), true);
    assert.deepEqual(readFileSync(f.config.recordPath), beforeRecord);
    assert.deepEqual(readFileSync(f.record.completionPath), beforeCompletion);
  });
}
