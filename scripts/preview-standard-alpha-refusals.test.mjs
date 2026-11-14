import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonStatePaths, writeDaemonState } from './lib/daemon-state.mjs';
import { stop } from './lib/preview-alpha-settlement-test-fixture.mjs';
import { ordinaryUnclaimedFixture } from './lib/preview-ordinary-unclaimed-test-fixture.mjs';
import { previewProcessRecordId } from './lib/preview-process-record-key.mjs';
import { isQuiescentHistoricalPredecessor } from './lib/preview-standard-alpha-predecessor.mjs';
import { standardAlphaDeadFixture } from './lib/preview-standard-alpha-test-fixture.mjs';

function writeOlderPredecessor(f, id, overrides = {}) {
  const olderIso = new Date(Date.parse(f.record.startedAt) - 60_000).toISOString();
  const base = {
    version: 1,
    id,
    cwd: join(f.directory, `cat-cafe-old-${id}`),
    port: 3011,
    command: ['pnpm', 'alpha:start'],
    origin: 'detached',
    pid: 900000890,
    startedAt: olderIso,
    ...overrides,
  };
  f.write(join(f.config.stateDir, `${id}.json`), base);
  return base;
}

const LAUNCHD_PRED_ID = 'eeeeeeeeeeeeeeee';
const LAUNCHD_PRED_LABEL = `com.catcafe.preview.${LAUNCHD_PRED_ID}`;

function writeSidecarPredecessor(f, suffix, data) {
  const compPath = join(f.config.stateDir, 'dddddddddddddddd.1.completion.json');
  writeOlderPredecessor(f, 'dddddddddddddddd', { completionPath: compPath });
  f.write(`${compPath}${suffix}`, data);
}

function writeLaunchdPredecessor(f, overrides = {}, plist = { Label: LAUNCHD_PRED_LABEL, KeepAlive: false }) {
  const plistPath = join(f.config.stateDir, `${LAUNCHD_PRED_ID}.plist`);
  if (plist !== null) f.write(plistPath, plist);
  return writeOlderPredecessor(f, LAUNCHD_PRED_ID, {
    origin: 'launchd',
    launchdLabel: LAUNCHD_PRED_LABEL,
    plistPath,
    ...overrides,
  });
}

const throwLaunchctl = (status, stderr) => () => {
  throw Object.assign(new Error('launchctl failed'), { status, stderr });
};
const unloadedLaunchd = throwLaunchctl(113, 'Could not find service');
const idleLaunchdReadJob = (plistObj) => (cmd) =>
  cmd === 'plutil' ? JSON.stringify(plistObj) : '\tstate = not running\n';
const predCase = (suffix, overrides, after) => [
  `older port-3011 registration ${suffix}`,
  (f) => {
    writeOlderPredecessor(f, 'cccccccccccccccc', overrides);
    after?.(f);
  },
];
const sidecarCase = (suffix, fileSuffix, data, after) => [
  `older port-3011 registration ${suffix}`,
  (f) => {
    writeSidecarPredecessor(f, fileSuffix, data);
    after?.(f);
  },
];
const launchdCase = (suffix, overrides, readJob, plist) => [
  `older launchd port-3011 registration ${suffix}`,
  (f) => {
    writeLaunchdPredecessor(f, typeof overrides === 'function' ? overrides(f) : overrides, plist);
    f.recovery.readJob = readJob;
  },
];

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
      const failed = { version: 2, exitCode: 1, commandExitCode: 0, cleanupExitCode: 1 };
      f.write(f.record.completionPath, {
        ...f.completion,
        ...failed,
        runnerExitCode: 1,
        cleanupOwnerStatus: 'complete',
      });
      f.write(`${f.record.completionPath}.owner.json`, { pid: 900000002, processGroupId: 900000003, ...failed });
      f.recovery.isRunning = (pid) => pid === 900000002;
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
  predCase('with missing startedAt', { startedAt: undefined }),
  predCase('with non-integer pid', { pid: '900000890' }),
  predCase('with invalid pid <= 1', { pid: 1 }),
  predCase('whose supervisor pid is still live', { pid: 900000891 }, (f) => {
    f.recovery.isRunning = (pid) => pid === 900000891;
  }),
  predCase('whose supervisor group is still live', { pid: 900000891 }, (f) => {
    f.recovery.groupRunning = (pgid) => pgid === 900000891;
  }),
  predCase('with empty completionPath', { completionPath: '' }),
  predCase('with non-string completionPath', { completionPath: 42 }),
  sidecarCase('with invalid .owner.json pid/processGroupId', '.owner.json', { pid: 1, processGroupId: 1 }),
  sidecarCase(
    'whose .owner.json pid is still live',
    '.owner.json',
    { pid: 900000892, processGroupId: 900000893 },
    (f) => {
      f.recovery.isRunning = (pid) => pid === 900000892;
    },
  ),
  sidecarCase(
    'whose .owner.json processGroupId is still live',
    '.owner.json',
    { pid: 900000892, processGroupId: 900000893 },
    (f) => {
      f.recovery.groupRunning = (pgid) => pgid === 900000893;
    },
  ),
  sidecarCase('with unrecognized .command.json identityStatus', '.command.json', {
    version: 1,
    identityStatus: 'corrupt',
    pid: 900000893,
    processGroupId: 900000894,
  }),
  sidecarCase(
    'whose bound command group is still live',
    '.command.json',
    { version: 1, identityStatus: 'observed', pid: 900000893, processGroupId: 900000894 },
    (f) => {
      f.recovery.groupRunning = (pgid) => pgid === 900000894;
    },
  ),
  launchdCase('with unrecognized origin', { origin: 'systemd' }, unloadedLaunchd, null),
  ...(process.platform === 'darwin'
    ? [
        launchdCase('with mismatched id', { id: 'ffffffffffffffff' }, unloadedLaunchd),
        launchdCase('with mismatched launchdLabel', { launchdLabel: 'com.catcafe.preview.wrong' }, unloadedLaunchd),
        launchdCase(
          'with mismatched plistPath',
          (f) => ({ plistPath: join(f.config.stateDir, 'wrong.plist') }),
          unloadedLaunchd,
        ),
        launchdCase('when launchctl fails with non-113 status', {}, throwLaunchctl(1, 'Could not find service'), null),
        launchdCase(
          'when launchctl 113 lacks service-not-found stderr',
          {},
          throwLaunchctl(113, 'Bootstrap IPC timeout'),
          null,
        ),
        launchdCase('whose launchd job is still running', {}, (cmd) =>
          cmd === 'plutil'
            ? JSON.stringify({ Label: LAUNCHD_PRED_LABEL, KeepAlive: false })
            : 'pid = 555\n\tstate = running\n',
        ),
        launchdCase('whose launchd output still reports a pid', {}, (cmd) =>
          cmd === 'plutil'
            ? JSON.stringify({ Label: LAUNCHD_PRED_LABEL, KeepAlive: false })
            : '\tpid = 555\n\tstate = not running\n',
        ),
        [
          'older launchd port-3011 registration whose loaded plistPath is a symlink',
          (f) => {
            const realPlist = join(f.config.stateDir, 'real-target.plist');
            f.write(realPlist, { Label: LAUNCHD_PRED_LABEL, KeepAlive: false });
            writeLaunchdPredecessor(f, {}, null);
            symlinkSync(realPlist, join(f.config.stateDir, `${LAUNCHD_PRED_ID}.plist`));
            f.recovery.readJob = idleLaunchdReadJob({ Label: LAUNCHD_PRED_LABEL, KeepAlive: false });
          },
        ],
        launchdCase(
          'whose loaded plist has KeepAlive enabled',
          {},
          idleLaunchdReadJob({ Label: LAUNCHD_PRED_LABEL, KeepAlive: true }),
          { Label: LAUNCHD_PRED_LABEL, KeepAlive: true },
        ),
        launchdCase(
          'whose loaded plist Label mismatches',
          {},
          idleLaunchdReadJob({ Label: 'com.catcafe.preview.other', KeepAlive: false }),
          { Label: 'com.catcafe.preview.other', KeepAlive: false },
        ),
        launchdCase('when plutil fails on loaded plist', {}, (cmd) => {
          if (cmd === 'plutil') throw new Error('corrupt plist');
          return '\tstate = not running\n';
        }),
      ]
    : []),
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

test('isQuiescentHistoricalPredecessor refuses unparseable target startedAt directly', (t) => {
  const f = standardAlphaDeadFixture(t);
  const pred = writeOlderPredecessor(f, 'cccccccccccccccc');
  assert.equal(
    isQuiescentHistoricalPredecessor(f.config, { ...f.record, startedAt: 'not-a-date' }, pred.id, pred, {
      isRunning: () => false,
      groupRunning: () => false,
    }),
    false,
  );
});
