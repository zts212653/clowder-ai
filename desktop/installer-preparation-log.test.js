const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runNativeCommand, withTempRoot } = require('./test-helpers/native-installer-fixture.cjs');

const compiler = [
  process.env.ISCC_EXE,
  'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
].find((candidate) => candidate && fs.existsSync(candidate));

const native = {
  skip: process.platform !== 'win32' || !compiler ? 'Requires Windows and native Inno' : false,
};

// Embed the production callbacks and their default messages. The probe does
// not require the optional Chinese language pack to be installed.
const installerSource = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
const extractionOutput = installerSource.slice(
  installerSource.indexOf('procedure ExtractionOutput'),
  installerSource.indexOf('#include "install-preparation.iss"'),
);
const messages = installerSource
  .split('[CustomMessages]')[1]
  .split('[Dirs]')[0]
  .split(/\r?\n/)
  .filter((line) => !line.startsWith('chinese_simplified.'))
  .join('\n');
const installDelete = installerSource.split('[InstallDelete]')[1].split('[UninstallRun]')[0];

// Use real Inno execution and test-only PowerShell helper payloads.
async function writeProbe(root, { createAppDir = false, helpers, appId }) {
  const helperSources = helpers
    .map(({ name, body }) => {
      const helper = path.join(root, name);
      fs.writeFileSync(helper, body, 'utf8');
      return `Source: "${helper}"; Flags: dontcopy`;
    })
    .join('\n');
  const script = path.join(root, 'probe.iss');
  fs.writeFileSync(
    script,
    `[Setup]
AppName=PR1519 Preparation Log Probe
AppId=${appId || 'PR1519 Preparation Log Probe'}
AppVersion=1.0.0
DefaultDirName=${path.join(root, 'program')}
CreateAppDir=${createAppDir ? 'yes' : 'no'}
Uninstallable=${appId ? 'yes' : 'no'}
PrivilegesRequired=lowest
UsePreviousAppDir=${appId ? 'yes' : 'no'}
OutputDir=${root}
OutputBaseFilename=probe
Compression=none
SetupLogging=yes
[CustomMessages]
${messages}
[Files]
${helperSources}
[InstallDelete]
${installDelete}
[Code]
#include "${path.join(__dirname, 'installer/runtime-failure.iss')}"
${extractionOutput}
#include "${path.join(__dirname, 'installer/install-preparation.iss')}"
`,
    'utf8',
  );
  const compiled = await runNativeCommand(root, 'compile', compiler, ['/Q', script]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
}

async function runProbe(root, args = []) {
  const log = path.join(root, 'setup.log');
  const installed = await runNativeCommand(
    root,
    'setup',
    path.join(root, 'probe.exe'),
    ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${log}`, ...args],
    // Cold Windows PowerShell startup on hosted CI is not a product SLA.
    // Keep it bounded, and fail with the real log plus owned-tree cleanup.
    { timeoutMs: 120000 },
  );
  assert.equal(fs.existsSync(log), true, installed.stdout + installed.stderr);
  return { installed, recorded: fs.readFileSync(log, 'utf8') };
}

const configureHelper = (body) => ({ name: 'configure-desktop-instance.ps1', body });
const stopHelper = { name: 'stop-installed-desktop.ps1', body: 'exit 0\n' };

test('native Setup records the actual identity-helper error before refusing installation', native, async () => {
  await withTempRoot('pr1519-prepare-log-', async (root) => {
    await writeProbe(root, {
      // Only the helper result is a fault fixture: it must be the one failing.
      helpers: [
        configureHelper("[Console]::Error.WriteLine('PR1519_EXPECTED_IDENTITY_FAILURE'); exit 73\n"),
        stopHelper,
      ],
    });
    const { installed, recorded } = await runProbe(root);
    assert.equal(installed.status, 7, installed.stdout + installed.stderr);
    assert.match(recorded, /Unable to preserve the target installation identity/);
    assert.match(
      recorded,
      /PR1519_EXPECTED_IDENTITY_FAILURE/,
      'Setup must retain the helper stderr, not only a generic error',
    );
    assert.equal(fs.existsSync(path.join(root, 'program')), false);
  });
});

test(
  'native Setup rejects isolated ports without an InstanceRoot before creating the program directory',
  native,
  async () => {
    await withTempRoot('pr1519-prepare-args-', async (root) => {
      // CreateAppDir=yes makes this a real fail-closed check: a regression that
      // ignores the ports would let the install proceed and create the directory.
      await writeProbe(root, {
        createAppDir: true,
        helpers: [configureHelper("[Console]::Error.WriteLine('PR1519_HELPER_MUST_NOT_RUN'); exit 0\n"), stopHelper],
      });
      const { installed, recorded } = await runProbe(root, ['/FrontendPort=5150']);
      assert.equal(installed.status, 7, installed.stdout + installed.stderr);
      assert.match(recorded, /Identity helper rejected: isolated port parameters require DesktopInstanceRoot/);
      assert.doesNotMatch(
        recorded,
        /PR1519_HELPER_MUST_NOT_RUN/,
        'the identity helper must not run when isolated ports lack an instance root',
      );
      assert.equal(fs.existsSync(path.join(root, 'program')), false);
    });
  },
);

test('native Setup keeps identity-helper stderr in the setup log even when the helper succeeds', native, async () => {
  await withTempRoot('pr1519-prepare-stderr-', async (root) => {
    await writeProbe(root, {
      helpers: [configureHelper("[Console]::Error.WriteLine('PR1519_STDERR_RETAINED'); exit 0\n"), stopHelper],
    });
    const { installed, recorded } = await runProbe(root);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.match(recorded, /PR1519_STDERR_RETAINED/, 'helper stderr must reach the Setup log on the success path too');
    const completed = [...recorded.matchAll(/Setup stage ([\w-]+): finished, elapsedMs=\d+/g)].map((match) => match[1]);
    assert.deepEqual(completed, [
      'identity-extract',
      'identity-check',
      'shutdown-extract',
      'shutdown',
      'file-use-check',
      'preparation',
      'payload-replacement',
    ]);
    assert.match(recorded, /Setup stage identity-check: finished, elapsedMs=\d+, started=1, exit=0/);
    assert.match(recorded, /Setup stage shutdown: finished, elapsedMs=\d+, started=1, exit=0/);
    assert.match(
      recorded,
      /Setup stage native-preparation: ready confirmed[\s\S]*Setup stage identity-extract: started/,
    );
    assert.match(
      recorded,
      /Setup stage file-use-check: started \(Windows Restart Manager handoff\)[\s\S]*Setup stage file-use-check: finished, elapsedMs=\d+, outcome=installing[\s\S]*Setup stage payload-replacement: started/,
    );
    const noFileCheck = await runProbe(root, ['/NOCLOSEAPPLICATIONS']);
    assert.equal(noFileCheck.installed.status, 0, noFileCheck.installed.stdout + noFileCheck.installed.stderr);
    assert.doesNotMatch(noFileCheck.recorded, /Setup stage file-use-check:/);
  });
});

test('native Setup times a failed shutdown and refuses installation before replacement', native, async () => {
  await withTempRoot('issue1788-stop-log-', async (root) => {
    await writeProbe(root, {
      createAppDir: true,
      helpers: [configureHelper('exit 0\n'), { ...stopHelper, body: 'exit 74\n' }],
    });
    const { installed, recorded } = await runProbe(root);
    assert.equal(installed.status, 7, installed.stdout + installed.stderr);
    assert.match(recorded, /Setup stage shutdown: finished, elapsedMs=\d+, started=1, exit=74/);
    assert.match(recorded, /Unable to stop the target installation safely/);
    assert.doesNotMatch(recorded, /Setup stage payload-replacement: started/);
    assert.equal(fs.existsSync(path.join(root, 'program')), false);
  });
});

test('native Setup timeout reaps its bootstrap child before fixture removal', native, async () => {
  await withTempRoot('pr1519-prepare-timeout-', async (root) => {
    await writeProbe(root, {
      helpers: [configureHelper('Start-Sleep -Seconds 60; exit 0\n'), stopHelper],
    });
    await assert.rejects(
      runNativeCommand(
        root,
        'setup-timeout',
        path.join(root, 'probe.exe'),
        ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(root, 'setup.log')}`],
        { timeoutMs: 2000 },
      ),
      (error) => {
        assert.match(error.message, /timed out/);
        assert.equal(error.cleanupError, undefined, 'tree termination must succeed, not only the timeout');
        assert.throws(() => process.kill(error.pid, 0), { code: 'ESRCH' });
        return true;
      },
    );
    // withTempRoot must actually remove the fixture; EPERM remains a failure.
  });
});

async function uninstallUpgradeProbe(root, programs) {
  for (const program of [...new Set(programs)].reverse()) {
    const uninstaller = path.join(program, 'unins000.exe');
    if (!fs.existsSync(uninstaller)) continue;
    const removed = await runNativeCommand(root, `uninstall-${path.basename(program)}`, uninstaller, [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
    ]);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  }
}

[
  ['relocate', false, 0],
  ['same-directory', true, 0],
  ['previous-stop-failure', false, 73],
].forEach(([mode, sameDirectory, stopFailure]) => {
  const previousName = sameDirectory ? 'program' : 'previous';
  test(`native upgrade shutdown: ${mode}`, native, async () => {
    await withTempRoot('issue1948-shutdown-', async (root) => {
      const target = path.join(root, 'program');
      const previous = path.join(root, previousName);
      const expectedCalls = sameDirectory ? [target] : [previous, target];
      const calls = path.join(root, 'shutdown-calls.txt');
      const appId = path.basename(root);
      await writeProbe(root, {
        createAppDir: true,
        appId,
        helpers: [
          configureHelper('exit 0\n'),
          {
            ...stopHelper,
            body: `param([string]$AppDir, [string]$InstanceRoot)
$root = Split-Path $AppDir -Parent
Add-Content -LiteralPath (Join-Path $root 'shutdown-calls.txt') -Value $AppDir -Encoding UTF8
if ((Split-Path $AppDir -Leaf) -eq 'previous' -and (Test-Path -LiteralPath (Join-Path $root 'fail-old'))) { exit 73 }
exit 0
`,
          },
        ],
      });
      try {
        const seedDirectory = sameDirectory ? target.toUpperCase() + path.sep : previous;
        const seed = await runProbe(root, [`/DIR=${seedDirectory}`]);
        assert.equal(seed.installed.status, 0, seed.recorded);
        fs.writeFileSync(calls, '');
        const preserved = path.join(target, 'packages', 'must-survive.txt');
        if (stopFailure) {
          fs.mkdirSync(path.dirname(preserved), { recursive: true });
          fs.writeFileSync(preserved, 'existing payload');
          fs.writeFileSync(path.join(root, 'fail-old'), 'fail the previous installation shutdown');
        }
        const { installed, recorded } = await runProbe(root, [`/DIR=${target}`]);
        const actual = fs
          .readFileSync(calls, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
          .split(/\r?\n/);
        if (stopFailure) {
          assert.equal(installed.status, 7, recorded);
          assert.deepEqual(actual, [previous], 'failed previous shutdown must prevent target shutdown');
          assert.equal(fs.readFileSync(preserved, 'utf8'), 'existing payload');
          assert.doesNotMatch(recorded, /Setup stage payload-replacement: started/);
        } else {
          assert.equal(installed.status, 0, recorded);
          assert.deepEqual(actual, expectedCalls);
        }
      } finally {
        await uninstallUpgradeProbe(root, [previous, target]);
      }
    });
  });
});
