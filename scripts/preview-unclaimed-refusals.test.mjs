import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveNamedAlphaCoordinates } from './lib/alpha-coordinates.mjs';
import { acquireNamedAlphaLifecycle } from './lib/alpha-lifecycle-lock.mjs';
import { readNamedAlphaRegistration } from './lib/preview-alpha-recovery-evidence.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { unclaimed } from './lib/preview-unclaimed-test-fixture.mjs';

for (const [label, change] of [
  [
    'unknown supervisor',
    (f) => {
      f.recovery.isRunning = () => undefined;
    },
  ],
  [
    'live supervisor',
    (f) => {
      f.recovery.isRunning = () => true;
    },
  ],
  [
    'unknown supervisor group',
    (f) => {
      f.recovery.groupRunning = () => undefined;
    },
  ],
  [
    'unknown listener observation',
    (f) => {
      f.recovery.readListeners = () => {
        throw Error('unreadable');
      };
    },
  ],
  [
    'occupied websocket',
    (f) => {
      f.recovery.readListeners = (p) => (p === 5411 ? [123] : []);
    },
  ],
  [
    'any same-port lease',
    (f) => {
      f.write(join(f.recovery.registryDir, 'redis-15397-1-2.json'), {});
    },
  ],
  [
    'missing registry',
    (f) => {
      renameSync(f.recovery.registryDir, `${f.recovery.registryDir}.old`);
    },
  ],
  [
    'present malformed owner',
    (f) => {
      writeFileSync(`${f.record.completionPath}.owner.json`, 'bad');
    },
  ],
  [
    'linked owner',
    (f) => {
      symlinkSync(f.record.completionPath, `${f.record.completionPath}.owner.json`);
    },
  ],
  [
    'forced command',
    (f) => {
      f.write(f.record.completionPath, { ...f.completion, forced: true });
    },
  ],
  [
    'unversioned receipt',
    (f) => {
      f.write(f.record.completionPath, { ...f.completion, version: undefined });
    },
  ],
  [
    'mixed outcome',
    (f) => {
      f.write(f.record.completionPath, { ...f.completion, cleanupExitCode: 0 });
    },
  ],
  [
    'wrong command exit',
    (f) => {
      f.write(f.record.completionPath, { ...f.completion, commandExitCode: 1 });
    },
  ],
  [
    'active checkout build',
    (f) => {
      f.recovery.readCwds = () => [{ pid: 123, cwd: join(f.alphaRoot, 'packages/api') }];
    },
  ],
  [
    'unknown checkout processes',
    (f) => {
      f.recovery.readCwds = () => {
        throw Error('unreadable cwd');
      };
    },
  ],
  [
    'new generation before listening',
    (f) => {
      f.write(join(f.config.stateDir, 'aaaaaaaaaaaaaaaa.json'), { ...f.record, id: 'aaaaaaaaaaaaaaaa', pid: 111 });
    },
  ],
  [
    'prior Redis protocol journal',
    (f) => {
      mkdirSync(`${f.record.completionPath}.recovery`);
    },
  ],
])
  test(`unclaimed retirement refuses ${label} and preserves original artifacts`, async (t) => {
    const f = unclaimed(t);
    change(f);
    const before = [f.config.recordPath, f.record.completionPath, f.dumpFile].map((p) => readFileSync(p));
    await assert.rejects(stop(f));
    assert.deepEqual(
      [f.config.recordPath, f.record.completionPath, f.dumpFile].map((p) => readFileSync(p)),
      before,
    );
  });

test('named build admission blocks retirement and its real pre-listener launcher', async (t) => {
  const f = unclaimed(t);
  const unlock = await acquireNamedAlphaLifecycle(readNamedAlphaRegistration(f.config, f.record));
  try {
    await assert.rejects(stop(f), /lifecycle is active/);
    for (const action of ['start', 'init']) {
      const launch = f.run([action, '--instance', 'f290-communication', '--ports', '5311,5312,5411,15397']);
      assert.notEqual(launch.status, 0);
      assert.match(launch.stderr, /lifecycle already active/);
    }
    assert.ok(existsSync(f.config.recordPath));
  } finally {
    await unlock();
  }
});

test('another instance reserving an overlapping tuple is busy before listeners, while unrelated tuples remain usable', async (t) => {
  const f = unclaimed(t);
  const other = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'other-build',
    ports: '5311,5512,5611,15497',
  });
  const distinct = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'unrelated-build',
    ports: '5511,5513,5612,15498',
  });
  const unlock = await acquireNamedAlphaLifecycle(other);
  try {
    const releaseDistinct = await acquireNamedAlphaLifecycle(distinct);
    await releaseDistinct();
    await assert.rejects(stop(f), /lifecycle is active/);
  } finally {
    await unlock();
  }
});

test('retirement holds both locks through deletion; a crash resumes metadata only', async (t) => {
  const f = unclaimed(t);
  const before = readFileSync(f.record.completionPath);
  f.recovery.afterSettlementJournal = async () => {
    await assert.rejects(stop(f), /mutation already active/);
    await assert.rejects(
      acquireNamedAlphaLifecycle(readNamedAlphaRegistration(f.config, f.record)),
      /lifecycle is active/,
    );
    throw Error('simulated interruption');
  };
  await assert.rejects(stop(f), /simulated interruption/);
  assert.ok(existsSync(f.config.recordPath));
  const result = readFileSync(join(`${f.record.completionPath}.settlement`, 'result.json'));
  f.recovery.afterSettlementJournal = undefined;
  await stop(f);
  assert.deepEqual(readFileSync(join(`${f.record.completionPath}.settlement`, 'result.json')), result);
  assert.deepEqual(readFileSync(f.record.completionPath), before);
});

for (const target of ['record', 'owner', 'rdb'])
  test(`last source recheck catches ${target} drift`, async (t) => {
    const f = unclaimed(t);
    f.recovery.afterSettlementJournal = () => {
      if (target === 'owner') f.write(`${f.record.completionPath}.owner.json`, {});
      else if (target === 'record') f.write(f.config.recordPath, { ...f.record, readyAt: 'changed' });
      else writeFileSync(f.dumpFile, Buffer.concat([readFileSync(f.dumpFile), Buffer.from('change')]));
    };
    await assert.rejects(stop(f));
    assert.ok(existsSync(f.config.recordPath));
  });

test('retirement receipt never authorizes next start over a currently occupied port', async (t) => {
  const f = unclaimed(t);
  await stop(f);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(f.config.port, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
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
      'does-not-exist',
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, HOME: f.directory, CAT_CAFE_PREVIEW_PROCESS_DIR: f.config.stateDir },
    },
  );
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /refusing to replace unmanaged target/);
  assert.equal(existsSync(f.config.recordPath), false);
  assert.ok(existsSync(join(f.config.stateDir, `${f.config.id}.settlement.json`)));
});
