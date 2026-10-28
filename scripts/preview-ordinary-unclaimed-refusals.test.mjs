import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { ordinaryUnclaimedFixture } from './lib/preview-ordinary-unclaimed-test-fixture.mjs';

for (const [label, change] of [
  ['unknown version', (f) => f.write(f.record.completionPath, { ...f.completion, version: 9 })],
  ['unknown zero-exit version', (f) => f.write(f.record.completionPath, { ...f.completion, version: 9, exitCode: 0 })],
  [
    'malformed zero-exit receipt',
    (f) => f.write(f.record.completionPath, { ...f.completion, exitCode: 0, commandExitCode: 0 }),
  ],
  [
    'named Alpha cannot downgrade to ordinary',
    (f) => {
      f.record.command = ['pnpm', 'alpha:worktree:start', '--instance', 'another-alpha'];
      f.write(f.config.recordPath, f.record);
    },
  ],
  [
    'v2 missing version cannot downgrade',
    (f) => f.write(f.record.completionPath, { ...f.completion, commandExitCode: 1 }),
  ],
  ['damaged v2', (f) => f.write(f.record.completionPath, { ...f.completion, version: 2, commandExitCode: 1 })],
  ['forced receipt', (f) => f.write(f.record.completionPath, { ...f.completion, forced: true })],
  [
    'future readiness',
    (f) => {
      f.record.readyAt = '2099-01-01T00:00:00Z';
      f.write(f.config.recordPath, f.record);
    },
  ],
  ['owner present', (f) => f.write(`${f.record.completionPath}.owner.json`, {})],
  [
    'supervisor unknown',
    (f) => {
      f.recovery.isRunning = () => undefined;
    },
  ],
  [
    'group unknown',
    (f) => {
      f.recovery.groupRunning = () => undefined;
    },
  ],
  [
    'listener unknown',
    (f) => {
      f.recovery.readListeners = () => {
        throw Error('probe unavailable');
      };
    },
  ],
  [
    'listener present',
    (f) => {
      f.recovery.readListeners = () => [123];
    },
  ],
  [
    'host unresolved',
    (f) => {
      f.recovery.readHost = () => ({ confidence: 'unreadable' });
    },
  ],
  [
    'host nondefault port',
    (f) => {
      f.recovery.readHost = () => ({
        confidence: 'exact',
        facet: {
          runtime: { apiPort: f.config.port },
          launcherPids: [],
          hostDependencies: [],
          installation: { projectRoot: '/other' },
        },
      });
    },
  ],
  [
    'host dependency port',
    (f) => {
      f.recovery.readHost = () => ({
        confidence: 'exact',
        facet: {
          runtime: { apiPort: 3002 },
          launcherPids: [],
          hostDependencies: [{ port: f.config.port }],
          installation: { projectRoot: '/other' },
        },
      });
    },
  ],
  [
    'successor registration',
    (f) => f.write(join(f.config.stateDir, 'aaaaaaaaaaaaaaaa.json'), { ...f.record, id: 'aaaaaaaaaaaaaaaa' }),
  ],
  ['Redis recovery cannot downgrade', (f) => f.write(`${f.record.completionPath}.recovery`, {})],
])
  test(`ordinary finite retirement refuses ${label}`, async (t) => {
    const f = ordinaryUnclaimedFixture(t);
    change(f);
    const before = [f.config.recordPath, f.record.completionPath, f.dumpFile].map((p) => readFileSync(p));
    await assert.rejects(stop(f));
    assert.ok(existsSync(f.config.recordPath));
    assert.deepEqual(
      [f.config.recordPath, f.record.completionPath, f.dumpFile].map((p) => readFileSync(p)),
      before,
    );
  });

for (const target of ['owner', 'record', 'successor'])
  test(`ordinary final recheck catches ${target} after durable journal`, async (t) => {
    const f = ordinaryUnclaimedFixture(t);
    f.recovery.afterSettlementJournal = () => {
      if (target === 'owner') f.write(`${f.record.completionPath}.owner.json`, {});
      else if (target === 'record') f.write(f.config.recordPath, { ...f.record, readyAt: 'changed' });
      else f.write(join(f.config.stateDir, 'bbbbbbbbbbbbbbbb.json'), { ...f.record, id: 'bbbbbbbbbbbbbbbb' });
    };
    await assert.rejects(stop(f));
    assert.ok(existsSync(f.config.recordPath));
  });

test('ordinary crash retry only reconciles registration, preserving its first result', async (t) => {
  const f = ordinaryUnclaimedFixture(t),
    original = readFileSync(f.record.completionPath);
  f.recovery.afterSettlementJournal = () => {
    throw Error('interruption');
  };
  await assert.rejects(stop(f), /interruption/);
  const result = readFileSync(`${f.record.completionPath}.settlement/result.json`);
  f.recovery.afterSettlementJournal = undefined;
  await stop(f);
  assert.deepEqual(readFileSync(`${f.record.completionPath}.settlement/result.json`), result);
  assert.deepEqual(readFileSync(f.record.completionPath), original);
});

test('a host root directory alias cannot be mistaken for an unrelated ordinary target', async (t) => {
  const f = ordinaryUnclaimedFixture(t);
  const hostAlias = join(f.directory, 'host-alias');
  symlinkSync(f.config.cwd, hostAlias, 'dir');
  f.recovery.readHost = () => ({
    confidence: 'exact',
    facet: {
      runtime: { apiPort: 3002 },
      launcherPids: [],
      hostDependencies: [],
      installation: { projectRoot: hostAlias },
    },
  });
  const before = readFileSync(f.config.recordPath);
  await assert.rejects(stop(f), /belongs to the current host/);
  assert.deepEqual(readFileSync(f.config.recordPath), before);
});
