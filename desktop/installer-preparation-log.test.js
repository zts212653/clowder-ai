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

// Execute the production Pascal gate, not a copy of its logic.
const installerSource = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
const extractionOutput = installerSource.slice(
  installerSource.indexOf('procedure ExtractionOutput'),
  installerSource.indexOf('procedure ExtractRuntimeArchive'),
);
const identitySource = fs.readFileSync(path.join(__dirname, 'installer/installation-identity.iss'), 'utf8');
const prepareToInstall = identitySource.slice(identitySource.indexOf('function PrepareToInstall'));

// Compile a throwaway native Setup that embeds the production PrepareToInstall
// and ExtractionOutput procedures plus test-only helper payloads.
async function writeProbe(root, { createAppDir = false, helpers }) {
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
AppVersion=1.0.0
DefaultDirName=${path.join(root, 'program')}
CreateAppDir=${createAppDir ? 'yes' : 'no'}
Uninstallable=no
PrivilegesRequired=lowest
UsePreviousAppDir=no
OutputDir=${root}
OutputBaseFilename=probe
Compression=none
SetupLogging=yes
[Files]
${helperSources}
[Code]
#include "${path.join(__dirname, 'installer/runtime-failure.iss')}"
${extractionOutput}
${prepareToInstall}
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
