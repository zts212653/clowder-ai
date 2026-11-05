import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { original, stop, stoppedFixture } from './lib/preview-alpha-settlement-test-fixture.mjs';

for (const versioned of [false, true]) {
  test(`canonical stop retires stopped registration and preserves ${versioned ? 'explicit cleanup0' : 'legacy unknown'}`, async (t) => {
    const f = stoppedFixture(t);
    if (versioned) {
      f.write(f.record.completionPath, { ...f.completion, version: 2, commandExitCode: 1, cleanupExitCode: 0 });
      f.write(`${f.record.completionPath}.owner.json`, {
        ...f.owner,
        version: 2,
        exitCode: 0,
        commandExitCode: 1,
        cleanupExitCode: 0,
      });
    }
    const before = original(f);
    const result = await stop(f);
    assert.equal(existsSync(f.config.recordPath), false);
    assert.deepEqual(original(f), before);
    assert.equal(result.settlement.originalExitCode, 1);
    assert.equal(result.settlement.businessExitCode, versioned ? 1 : null);
    assert.equal(result.settlement.cleanupExitCode, versioned ? 0 : null);
    assert.equal(result.settlement.persistenceStatus, 'not_reverified');
    assert.equal(result.settlement.registered, false);
    assert.equal('shutdownExitCode' in result.settlement, false);
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
    assert.equal(queried.status, 1, queried.stderr);
    assert.deepEqual(JSON.parse(queried.stdout).settlement, result.settlement);
    const repeated = spawnSync(
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
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout).settlement, result.settlement);
    assert.deepEqual(original(f), before);
    const text = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
        'stop',
        '--cwd',
        f.mainRoot,
        '--port',
        String(f.config.port),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
        timeout: 5000,
      },
    );
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /original process exit: 1/);
    assert.match(text.stdout, versioned ? /business exit: 1/ : /business exit: unknown \(legacy\)/);
    assert.match(text.stdout, /saved data: not reverified/);
  });
}

test('registration publication can follow the original runner birth by more than a second', async (t) => {
  const f = stoppedFixture(t);
  f.record.startedAt = '2026-09-30T19:59:52.500Z';
  f.write(f.config.recordPath, f.record);
  const before = original(f);
  await stop(f);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.deepEqual(original(f), before);
});

test('interruption after durable settlement retries only registration reconciliation', async (t) => {
  const f = stoppedFixture(t);
  const before = original(f);
  f.recovery.afterSettlementJournal = () => {
    throw new Error('fixture interruption');
  };
  await assert.rejects(stop(f), /fixture interruption/);
  assert.ok(existsSync(f.config.recordPath));
  f.recovery.afterSettlementJournal = undefined;
  await stop(f);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.deepEqual(original(f), before);
  assert.equal(readdirSync(`${f.record.completionPath}.settlement`).filter((name) => name === 'result.json').length, 1);
});

test('available original log and pre-stop RDB archive are durably preserved', async (t) => {
  const f = stoppedFixture(t);
  const log = join(f.config.stateDir, `${f.config.id}.log`);
  f.record.logPath = log;
  f.write(f.config.recordPath, f.record);
  writeFileSync(log, 'original business failure; old cleanup outcome unknown\n');
  const backups = join(f.alphaRoot, '.cat-cafe/redis-backups');
  mkdirSync(backups, { recursive: true });
  const archive = join(backups, `worktree-${f.proof.port}-pre-stop-fixture.rdb`);
  writeFileSync(archive, readFileSync(f.dumpFile));
  const result = await stop(f);
  const dir = result.settlement.journalPath;
  assert.deepEqual(readFileSync(join(dir, 'preview.log')), readFileSync(log));
  const journal = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.equal(journal.data.length, 2);
  for (const data of journal.data) assert.deepEqual(readFileSync(data.savedPath), readFileSync(data.path));
});

test('concurrent canonical start and second stop cannot replace the settling lifecycle', async (t) => {
  const f = stoppedFixture(t);
  let release, entered;
  const inJournal = new Promise((resolve) => {
    entered = resolve;
  });
  f.recovery.afterSettlementJournal = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const stopping = stop(f);
  await inJournal;
  try {
    await assert.rejects(stop(f), /mutation already active/);
    const started = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
        'start',
        '--cwd',
        f.mainRoot,
        '--port',
        String(f.config.port),
        '--json',
        '--',
        ...f.record.command,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
        timeout: 5000,
      },
    );
    assert.equal(started.status, 1, started.stderr);
    assert.match(started.stderr, /mutation already active/);
    assert.ok(existsSync(f.config.recordPath));
  } finally {
    release();
    await stopping;
  }
});

test('retirement without an RDB creates no database or saving claim', async (t) => {
  const f = stoppedFixture(t);
  unlinkSync(f.dumpFile);
  const result = await stop(f);
  assert.equal(existsSync(f.dumpFile), false);
  assert.equal(result.settlement.persistenceStatus, 'not_reverified');
  const journal = JSON.parse(readFileSync(join(result.settlement.journalPath, 'result.json'), 'utf8'));
  assert.deepEqual(journal.data, []);
});
