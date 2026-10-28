import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recoveryGroupRunning, recoveryListeners } from './lib/preview-alpha-recovery-observation.mjs';
import { failedAlphaFixture } from './lib/preview-alpha-recovery-test-fixture.mjs';
import { withPreviewMutationLock } from './lib/preview-process-mutex.mjs';
import { stopManagedPreview } from './lib/preview-process-stop.mjs';

const stop = (f, recovery = f.recovery) =>
  stopManagedPreview(f.config, { record: f.record, status: 'stopped' }, { recovery });
const cli = fileURLToPath(new URL('./preview-process.mjs', import.meta.url));
const retained = (f) => {
  assert.ok(existsSync(f.config.recordPath));
  assert.ok(existsSync(f.leaseFile));
  assert.deepEqual(readFileSync(f.record.completionPath), f.originalCompletion);
  assert.deepEqual(readFileSync(`${f.record.completionPath}.owner.json`), f.originalOwner);
};

test('canonical stop can finish the same failed named Alpha cleanup without rewriting the original failure', async (t) => {
  const f = failedAlphaFixture(t);
  await stopManagedPreview(f.config, { record: f.record, status: 'stopped' }, { recovery: f.recovery });
  assert.equal(existsSync(f.config.recordPath), false);
  assert.equal(existsSync(f.leaseFile), false);
  assert.deepEqual(readFileSync(f.record.completionPath), f.originalCompletion);
  assert.deepEqual(readFileSync(`${f.record.completionPath}.owner.json`), f.originalOwner);
  assert.equal(f.calls.filter((argv) => argv.includes('shutdown')).length, 1);
  assert.ok(existsSync(f.dumpFile), 'the stop saves and retains data');
});

for (const [name, change, error] of [
  [
    'live supervisor',
    (f) => {
      f.recovery.isRunning = () => true;
    },
    /live or unproven/,
  ],
  [
    'unknown owner',
    (f) => {
      f.recovery.isRunning = () => undefined;
    },
    /live or unproven/,
  ],
  [
    'live group',
    (f) => {
      f.recovery.groupRunning = () => true;
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
    'application listener',
    (f) => {
      f.recovery.readListeners = () => [f.proof.pid];
    },
    /application port/,
  ],
  [
    'unreadable listener',
    (f) => {
      f.recovery.readListeners = () => {
        throw new Error('fixture unreadable');
      };
    },
    /unreadable/,
  ],
  [
    'replaced Redis',
    (f) => {
      f.recovery.readListeners = (port) => (port === f.proof.port ? [41022] : []);
    },
    /replaced/,
  ],
  [
    'changed birth',
    (f) => {
      const read = f.recovery.capture;
      f.recovery.capture = () => ({ ...read(), startedAtEpochMs: 0 });
    },
    /incarnation/,
  ],
  [
    'changed cwd',
    (f) => {
      const read = f.recovery.capture;
      f.recovery.capture = () => ({ ...read(), cwd: '/foreign' });
    },
    /incarnation/,
  ],
  [
    'build drift',
    (f) => writeFileSync(`${f.alphaRoot}/packages/api/dist/.build-commit`, 'foreign'),
    /compiled revision/,
  ],
  [
    'target drift',
    (f) => {
      f.lease.coordinates.targetSha = 'a'.repeat(40);
      f.write(f.leaseFile, f.lease);
    },
    /target revision/,
  ],
  [
    'foreign owner',
    (f) => {
      f.lease.owner.pid++;
      f.write(f.leaseFile, f.lease);
    },
    /producer lease/,
  ],
  [
    'foreign port tuple',
    (f) => {
      f.lease.coordinates.ports.redis = 16892;
      f.write(f.leaseFile, f.lease);
    },
    /producer lease/,
  ],
]) {
  test(`failed Alpha recovery preserves all evidence and sends no protocol for ${name}`, async (t) => {
    const f = failedAlphaFixture(t);
    change(f);
    await assert.rejects(stop(f), error);
    assert.equal(f.calls.length, 0);
    retained(f);
  });
}

test('anomalous empty Redis cannot overwrite a substantial startup snapshot', async (t) => {
  const f = failedAlphaFixture(t);
  const rdb = Buffer.concat([Buffer.from('REDIS0012'), Buffer.alloc(2048), Buffer.from([255]), Buffer.alloc(8)]);
  writeFileSync(f.dumpFile, rdb);
  const run = f.recovery.run;
  f.recovery.run = (program, argv) => (argv.at(-1) === 'dbsize' ? '0\n' : run(program, argv));
  await assert.rejects(stop(f), /anomalous empty database/);
  assert.deepEqual(readFileSync(f.dumpFile), rdb);
  assert.equal(f.calls.filter((argv) => argv.includes('shutdown')).length, 0);
  retained(f);
});

test('a symlinked lease refuses before protocol or metadata removal', async (t) => {
  const f = failedAlphaFixture(t);
  const bytes = readFileSync(f.leaseFile);
  writeFileSync(`${f.leaseFile}.original`, bytes);
  unlinkSync(f.leaseFile);
  symlinkSync(`${f.leaseFile}.original`, f.leaseFile);
  await assert.rejects(stop(f), /linked/);
  assert.equal(f.calls.length, 0);
  retained(f);
});

test('a shutdown whose result was not published is never replayed or inferred from absence', async (t) => {
  const f = failedAlphaFixture(t);
  const run = f.recovery.run;
  f.recovery.run = (program, argv) => {
    const value = run(program, argv);
    if (argv.includes('shutdown')) throw new Error('fixture interrupted after shutdown');
    return value;
  };
  await assert.rejects(stop(f), /interrupted after shutdown/);
  await assert.rejects(stop(f), /previous shutdown outcome is unproven/);
  assert.equal(f.calls.filter((argv) => argv.includes('shutdown')).length, 1);
  retained(f);
});

test('completed recovery resumes metadata cleanup without resending Redis commands', async (t) => {
  const f = failedAlphaFixture(t);
  f.recovery.removeLease = () => {
    throw new Error('fixture interrupted before lease release');
  };
  await assert.rejects(stop(f), /interrupted before lease release/);
  retained(f);
  const count = f.calls.length;
  delete f.recovery.removeLease;
  await stop(f);
  assert.equal(f.calls.length, count);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.equal(existsSync(f.leaseFile), false);
  assert.deepEqual(readFileSync(f.record.completionPath), f.originalCompletion);
});

test('completed recovery survives a crash after lease release while retaining the original preview record', async (t) => {
  const f = failedAlphaFixture(t);
  f.recovery.removeLease = (path) => {
    unlinkSync(path);
    throw new Error('fixture interrupted after lease release');
  };
  await assert.rejects(stop(f), /interrupted after lease release/);
  assert.equal(existsSync(f.leaseFile), false);
  const count = f.calls.length;
  delete f.recovery.removeLease;
  await stop(f);
  assert.equal(f.calls.length, count);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.deepEqual(readFileSync(f.record.completionPath), f.originalCompletion);
});

test('real OS observation adapters distinguish an absent listener/group from errors and incomplete output', () => {
  for (const result of [
    { status: 1, stdout: '', stderr: 'lsof: denied' },
    { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { status: 0, stdout: 'incomplete', stderr: '' },
  ])
    assert.throws(() => recoveryListeners(15397, { run: () => result }));
  assert.deepEqual(recoveryListeners(15397, { run: () => ({ status: 1, stdout: '', stderr: '' }) }), []);
  assert.equal(
    recoveryGroupRunning(1234, () => ({ status: 0, stdout: '1 S\n', stderr: '' })),
    false,
  );
  for (const result of [
    { status: 1, stdout: '' },
    { status: 0, stdout: '' },
    { status: 0, stdout: 'truncated' },
  ])
    assert.throws(() => recoveryGroupRunning(1234, () => result), /unproven|incomplete/);
});

test('start preserves an unresolved named Alpha record rather than launching over it', (t) => {
  const f = failedAlphaFixture(t);
  const before = readFileSync(f.config.recordPath);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'start',
      '--port',
      String(f.config.port),
      '--cwd',
      f.mainRoot,
      '--',
      process.execPath,
      '-e',
      'process.exit(91)',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cleanup remains unsettled/);
  assert.deepEqual(readFileSync(f.config.recordPath), before);
  retained(f);
});

test('start and a second stop are excluded by the same cross-process lifecycle lock', async (t) => {
  const f = failedAlphaFixture(t);
  await withPreviewMutationLock(f.config, async () => {
    for (const action of ['start', 'stop']) {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          action,
          '--port',
          String(f.config.port),
          '--cwd',
          f.mainRoot,
          ...(action === 'start' ? ['--', process.execPath, '-e', 'process.exit(91)'] : []),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
          timeout: 5000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /mutation already active or unproven/);
    }
  });
  retained(f);
  assert.equal(f.calls.length, 0);
});
