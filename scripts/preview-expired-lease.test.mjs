import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFailedAlphaEvidence } from './lib/preview-alpha-recovery-evidence.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { addAofSet, expiredLeaseFixture, forensicAttempt } from './lib/preview-expired-lease-test-fixture.mjs';

test('canonical stop settles an absent recorded Redis and exact stale lease without sending a Redis command', async (t) => {
  const f = expiredLeaseFixture(t);
  const before = [f.record.completionPath, `${f.record.completionPath}.owner.json`, f.leaseFile, f.dumpFile].map((p) =>
    readFileSync(p),
  );
  const result = await stop(f);
  assert.equal(result.settlement.status, 'stopped');
  assert.equal(result.settlement.leaseStatus, 'retired');
  assert.equal(result.settlement.originalExitCode, 1);
  assert.equal(result.settlement.businessExitCode, null);
  assert.equal(result.settlement.cleanupExitCode, null);
  assert.equal(result.settlement.persistenceStatus, 'not_reverified');
  assert.equal('shutdownExitCode' in result.settlement, false);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.equal(existsSync(f.leaseFile), false);
  const journal = result.settlement.journalPath;
  assert.deepEqual(readFileSync(join(journal, 'lease.json')), before[2]);
  assert.deepEqual(
    [f.record.completionPath, `${f.record.completionPath}.owner.json`, f.dumpFile].map((p) => readFileSync(p)),
    [before[0], before[1], before[3]],
  );
});

test('retirement archives the stable entire AOF, RDB and backup set and preserves forensic-only history', async (t) => {
  const f = expiredLeaseFixture(t);
  const paths = [f.dumpFile, ...addAofSet(f)];
  const originals = paths.map((path) => readFileSync(path));
  const history = forensicAttempt(f);
  const attempt = readFileSync(join(history.directory, 'attempt.json'));
  const result = await stop(f);
  const journal = JSON.parse(readFileSync(join(result.settlement.journalPath, 'result.json')));
  for (const [index, path] of paths.entries()) {
    const saved = journal.data.find((data) => data.path === path);
    assert.ok(saved, `missing archive for ${path}`);
    assert.deepEqual(readFileSync(saved.savedPath), originals[index]);
    assert.deepEqual(readFileSync(path), originals[index]);
  }
  assert.deepEqual(readFileSync(join(history.directory, 'attempt.json')), attempt);
  assert.ok(Object.values(journal.sources).some((source) => source.path === join(history.directory, 'attempt.json')));
  assert.equal(existsSync(join(history.directory, 'shutdown-intent.json')), false);
});

for (const explicit of [false, true]) {
  test(`stop, status and repeat stop preserve lease retirement and ${explicit ? 'explicit failure' : 'legacy unknown'}`, async (t) => {
    const f = expiredLeaseFixture(t);
    if (explicit) {
      f.write(f.record.completionPath, {
        ...f.completion,
        version: 2,
        exitCode: 2,
        commandExitCode: 2,
        cleanupExitCode: 1,
        runnerExitCode: 2,
      });
      f.write(`${f.record.completionPath}.owner.json`, {
        ...f.owner,
        version: 2,
        commandExitCode: 2,
        cleanupExitCode: 1,
      });
    }
    const result = await stop(f);
    const query = (action, json = true) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
          action,
          '--cwd',
          f.mainRoot,
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
    const status = query('status');
    assert.equal(status.status, 1, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).settlement, result.settlement);
    const repeated = query('stop');
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout).settlement, result.settlement);
    const text = query('stop', false);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /producer lease: retired/);
    assert.match(text.stdout, /saved data: not reverified/);
    assert.equal(result.settlement.businessExitCode, explicit ? 2 : null);
    assert.equal(result.settlement.cleanupExitCode, explicit ? 1 : null);
    assert.equal(result.settlement.originalExitCode, explicit ? 2 : 1);
  });
}

for (const startedAt of ['2026-09-30T19:59:52.500Z', '2026-09-30T19:59:56.500Z']) {
  test(`metadata retirement accepts delayed registration ${startedAt} without relaxing protocol recovery`, async (t) => {
    const f = expiredLeaseFixture(t);
    f.record.startedAt = startedAt;
    f.write(f.config.recordPath, f.record);
    assert.throws(() => readFailedAlphaEvidence(f.config, f.record, f.recovery), /supervisor lifetime is inconsistent/);
    const result = await stop(f);
    assert.equal(result.settlement.leaseStatus, 'retired');
    assert.equal(result.settlement.persistenceStatus, 'not_reverified');
  });
}
