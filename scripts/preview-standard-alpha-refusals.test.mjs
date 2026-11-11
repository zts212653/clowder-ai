import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonStatePaths, writeDaemonState } from './lib/daemon-state.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { ordinaryUnclaimedFixture } from './lib/preview-ordinary-unclaimed-test-fixture.mjs';
import { previewProcessRecordId } from './lib/preview-process-record-key.mjs';
import { standardAlphaDeadFixture } from './lib/preview-standard-alpha-test-fixture.mjs';

for (const occupiedPort of [3011, 3012, 4111, 5211])
  test(`standard Alpha retirement refuses when application port ${occupiedPort} still has a listener`, async (t) => {
    const f = standardAlphaDeadFixture(t);
    f.recovery.readListeners = (port) => (port === occupiedPort ? [54321] : []);
    const before = readFileSync(f.config.recordPath);
    await assert.rejects(stop(f), /occupied|listener/i);
    assert.deepEqual(readFileSync(f.config.recordPath), before);
  });

for (const [label, mutate] of [
  ['forced completion', (f) => f.write(f.record.completionPath, { ...f.completion, forced: true })],
  ['existing recovery directory', (f) => f.write(`${f.record.completionPath}.recovery`, {})],
  [
    'live supervisor',
    (f) => {
      f.recovery.isRunning = (pid) => pid === f.record.pid;
    },
  ],
  [
    'unknown supervisor',
    (f) => {
      f.recovery.isRunning = () => undefined;
    },
  ],
  [
    'live supervisor group',
    (f) => {
      f.recovery.groupRunning = () => true;
    },
  ],
  [
    'live failed owner process',
    (f) => {
      const f2 = f;
      f2.completion = {
        ...f2.completion,
        version: 2,
        exitCode: 1,
        commandExitCode: 0,
        runnerExitCode: 1,
        cleanupExitCode: 1,
        cleanupOwnerStatus: 'complete',
      };
      f2.owner = {
        pid: 900000002,
        processGroupId: 900000003,
        version: 2,
        exitCode: 1,
        commandExitCode: 0,
        cleanupExitCode: 1,
      };
      f2.write(f2.record.completionPath, f2.completion);
      f2.write(`${f2.record.completionPath}.owner.json`, f2.owner);
      f2.recovery.isRunning = (pid) => pid === 900000002;
    },
  ],
  [
    'listener observation failure',
    (f) => {
      f.recovery.readListeners = () => {
        throw new Error('lsof unavailable');
      };
    },
  ],
  [
    'unresolved host facet',
    (f) => {
      f.recovery.readHost = () => ({ confidence: 'unreadable' });
    },
  ],
  [
    'mismatched installation projectRoot',
    (f) => {
      f.recovery.readHost = () => ({
        confidence: 'exact',
        facet: {
          runtime: { apiPort: 3002, worktree: join(f.directory, 'cat-cafe-runtime') },
          launcherPids: [],
          hostDependencies: [],
          installation: { projectRoot: join(f.directory, 'other-cat-cafe') },
        },
      });
    },
  ],
  [
    'successor standard Alpha registration in stateDir',
    (f) => {
      f.write(join(f.config.stateDir, 'aaaaaaaaaaaaaaaa.json'), { ...f.record, id: 'aaaaaaaaaaaaaaaa' });
    },
  ],
  [
    'non-Alpha command inside cat-cafe root',
    (f) => {
      f.record.command = ['pnpm', 'dev:direct'];
      f.write(f.config.recordPath, f.record);
    },
  ],
  [
    'named Alpha --instance command cannot downgrade to standard Alpha retirement',
    (f) => {
      f.record.command = ['pnpm', 'alpha:start', '--', '--instance', 'named-one', '--ports', '4311,4312,4411,16397'];
      f.write(f.config.recordPath, f.record);
    },
  ],
])
  test(`standard Alpha retirement refuses ${label} without removing record`, async (t) => {
    const f = standardAlphaDeadFixture(t);
    mutate(f);
    const before = readFileSync(f.config.recordPath);
    await assert.rejects(stop(f));
    assert.equal(existsSync(f.config.recordPath), true);
    assert.deepEqual(readFileSync(f.config.recordPath), before);
  });

test('standard Alpha retirement refuses while live standard Alpha daemon-state is still running', async (t) => {
  const f = standardAlphaDeadFixture(t);
  const mockDaemonIdentity = (pid) =>
    pid === 900000111
      ? {
          pid: 900000111,
          pgid: 900000111,
          cwd: f.stdAlphaRoot,
          startedAt: 'Wed Sep 30 19:59:55 2026',
          startedAtEpochMs: 1790798395000,
          argvAvailable: true,
          command: `bash ${join(f.stdAlphaRoot, 'scripts/start-dev.sh')} --quick --cat-cafe-daemon-token=tok-live-alpha`,
        }
      : null;
  writeDaemonState({
    paths: daemonStatePaths({ homeDir: f.directory, projectRoot: f.stdAlphaRoot, deploymentId: 'alpha' }),
    pid: 900000111,
    projectRoot: f.stdAlphaRoot,
    deploymentId: 'alpha',
    launchToken: 'tok-live-alpha',
    logFile: join(f.stdAlphaRoot, '.daemon.log'),
    ports: { frontend: 3011, api: 3012, redis: 6397, preview: 4111 },
    captureIdentity: mockDaemonIdentity,
  });
  f.recovery.captureDaemonProcess = mockDaemonIdentity;
  await assert.rejects(stop(f), /daemon/i);
  assert.equal(existsSync(f.config.recordPath), true);
});

test('ordinary worktree on reserved port 3011 remains blocked by reserved-port protection', async (t) => {
  const f = ordinaryUnclaimedFixture(t, 'v2');
  const id = previewProcessRecordId(f.config.cwd, 3011);
  const recordPath = join(f.config.stateDir, `${id}.json`);
  const completionPath = join(f.config.stateDir, `${id}.11111111-1111-4111-8111-111111111111.completion.json`);
  mkdirSync(f.config.stateDir, { recursive: true });
  f.config = { ...f.config, port: 3011, id, recordPath };
  f.record = { ...f.record, port: 3011, id, completionPath };
  writeFileSync(recordPath, `${JSON.stringify(f.record)}\n`);
  writeFileSync(completionPath, `${JSON.stringify(f.completion)}\n`);
  await assert.rejects(stop(f), /host\/sanctuary coordinate/);
  assert.equal(existsSync(recordPath), true);
});

test('standard Alpha crash re-entry after settlement journal preserves original result and completion', async (t) => {
  const f = standardAlphaDeadFixture(t);
  const originalCompletion = readFileSync(f.record.completionPath);
  f.recovery.afterSettlementJournal = () => {
    throw new Error('interrupted after journal');
  };
  await assert.rejects(stop(f), /interrupted after journal/);
  assert.equal(existsSync(f.config.recordPath), true);
  const firstResult = readFileSync(`${f.record.completionPath}.settlement/result.json`);
  f.recovery.afterSettlementJournal = undefined;
  const resumed = await stop(f);
  assert.equal(resumed.settlement.status, 'registration_retired');
  assert.deepEqual(readFileSync(`${f.record.completionPath}.settlement/result.json`), firstResult);
  assert.deepEqual(readFileSync(f.record.completionPath), originalCompletion);
  assert.equal(existsSync(f.config.recordPath), false);
});
