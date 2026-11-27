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

test(
  'native Setup deletes each extracted .tar and sidecar before unpacking the next and fails closed on incomplete node.tar',
  native,
  async () => {
    const { createRequire } = require('node:module');
    const { createHash } = require('node:crypto');
    const npmCli = path.join(
      path.dirname(process.execPath),
      process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js',
    );
    const tar = createRequire(npmCli)('tar');
    const extractProcedure = installerSource.slice(installerSource.indexOf('procedure ExtractRuntimeArchive('));
    assert.match(extractProcedure, /DeleteFile\(AppDir \+ '\\bundled\\archives\\' \+ ArchiveName\)/);

    async function makeTar(srcDir, archivePath, withSidecar) {
      await tar.c({ file: archivePath, gzip: false, cwd: srcDir, portable: true }, ['.']);
      if (!withSidecar) return null;
      let entries = 0;
      await tar.t({ file: archivePath, strict: true, onReadEntry: () => entries++ });
      const manifest = {
        archive: path.basename(archivePath),
        bytes: fs.statSync(archivePath).size,
        entries,
        sha256: createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex'),
      };
      fs.writeFileSync(archivePath + '.json', JSON.stringify(manifest));
      return manifest;
    }

    await withTempRoot('pr2070-archive-cleanup-', async (root) => {
      const staging = path.join(root, 'staging');
      const nodeInput = path.join(staging, 'node');
      const depsInput = path.join(staging, 'deps');
      const electronInput = path.join(staging, 'electron');
      const archiveInput = path.join(staging, 'archives');
      fs.mkdirSync(nodeInput, { recursive: true });
      fs.mkdirSync(depsInput, { recursive: true });
      fs.mkdirSync(electronInput, { recursive: true });
      fs.mkdirSync(archiveInput, { recursive: true });

      fs.copyFileSync(process.execPath, path.join(nodeInput, 'node.exe'));
      fs.writeFileSync(path.join(depsInput, '.runtime-lock.json'), '{"ok":true}');
      fs.writeFileSync(path.join(depsInput, 'pad.bin'), Buffer.alloc(256 * 1024, 0x41));
      fs.writeFileSync(path.join(electronInput, 'Clowder AI.exe'), 'electron-entry');
      fs.writeFileSync(path.join(electronInput, 'pad.bin'), Buffer.alloc(192 * 1024, 0x42));

      const nodeTar = path.join(archiveInput, 'node.tar');
      const depsTar = path.join(archiveInput, 'deploy-dependencies.tar');
      const electronTar = path.join(archiveInput, 'electron.tar');
      await makeTar(nodeInput, nodeTar, false);
      await makeTar(depsInput, depsTar, true);
      await makeTar(electronInput, electronTar, true);

      // Wrapper delegates to the real production extractor while resolving npm's tar from the test host.
      const extractorBridge = path.join(staging, 'extract-runtime-archive.cjs');
      fs.writeFileSync(
        extractorBridge,
        `const { createRequire } = require('node:module');
const { extractRuntimeArchive } = require(${JSON.stringify(require.resolve('./scripts/extract-runtime-archive.cjs'))});
const tar = createRequire(${JSON.stringify(npmCli)})('tar');
const [rootDir, name] = process.argv.slice(2);
extractRuntimeArchive(rootDir, name, tar, { engine: 'native' }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
`,
        'utf8',
      );

      const snapshotPath = path.join(root, 'archive-snapshots.txt');
      const programDir = path.join(root, 'program');
      const script = path.join(root, 'cleanup-probe.iss');
      fs.writeFileSync(
        script,
        `[Setup]
AppName=PR2070 Archive Cleanup Probe
AppVersion=1.0.0
DefaultDirName=${programDir}
CreateAppDir=yes
Uninstallable=no
PrivilegesRequired=lowest
UsePreviousAppDir=no
OutputDir=${root}
OutputBaseFilename=cleanup-probe
Compression=none
SetupLogging=yes
[Dirs]
Name: "{app}\\node"
Name: "{app}\\node_modules"
Name: "{app}\\desktop-dist"
Name: "{app}\\bundled\\archives"
[Files]
Source: "${extractorBridge}"; DestDir: "{app}\\scripts"
Source: "${depsTar}.json"; DestDir: "{app}\\bundled\\archives"
Source: "${electronTar}.json"; DestDir: "{app}\\bundled\\archives"
Source: "${nodeTar}"; DestDir: "{app}\\bundled\\archives"; AfterInstall: ProbeExtract('node.tar')
Source: "${depsTar}"; DestDir: "{app}\\bundled\\archives"; AfterInstall: ProbeExtract('deploy-dependencies.tar')
Source: "${electronTar}"; DestDir: "{app}\\bundled\\archives"; AfterInstall: ProbeExtract('electron.tar')
[Code]
function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall setuponly';
#include "${path.join(__dirname, 'installer/runtime-failure.iss')}"
${extractionOutput}
${extractProcedure}
procedure SnapshotArchives(const Stage: String);
var
  FindRec: TFindRec;
  Listing: String;
  ArchivesDir: String;
begin
  ArchivesDir := ExpandConstant('{app}\\bundled\\archives');
  Listing := '';
  if FindFirst(ArchivesDir + '\\*', FindRec) then begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then begin
          if Listing <> '' then Listing := Listing + ',';
          Listing := Listing + FindRec.Name;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  SaveStringToFile('${snapshotPath.replaceAll('\\', '\\\\')}', Stage + '=' + Listing + #13#10, True);
end;

procedure ProbeExtract(const ArchiveName: String);
begin
  SnapshotArchives('before:' + ArchiveName);
  ExtractRuntimeArchive(ArchiveName);
  SnapshotArchives('after:' + ArchiveName);
end;
`,
        'utf8',
      );
      const compiled = await runNativeCommand(root, 'compile-cleanup', compiler, ['/Q', script]);
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      const installed = await runNativeCommand(
        root,
        'run-cleanup',
        path.join(root, 'cleanup-probe.exe'),
        ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(root, 'cleanup.log')}`],
        { timeoutMs: 120000 },
      );
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);

      const snapshots = Object.fromEntries(
        fs
          .readFileSync(snapshotPath, 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const idx = line.indexOf('=');
            const names = line
              .slice(idx + 1)
              .split(',')
              .filter(Boolean)
              .sort();
            return [line.slice(0, idx), names];
          }),
      );
      // At every extraction step, at most one .tar file exists in bundled/archives.
      for (const name of ['node.tar', 'deploy-dependencies.tar', 'electron.tar']) {
        const presentTars = snapshots[`before:${name}`].filter((f) => f.endsWith('.tar'));
        assert.deepEqual(presentTars, [name], `only ${name} may be resident before its extraction`);
        assert.equal(
          snapshots[`after:${name}`].includes(name),
          false,
          `${name} must be deleted immediately after extraction`,
        );
        assert.equal(
          snapshots[`after:${name}`].includes(`${name}.json`),
          false,
          `${name}.json must be deleted immediately after extraction`,
        );
      }
      assert.deepEqual(fs.readdirSync(path.join(programDir, 'bundled/archives')), []);
      assert.equal(fs.readFileSync(path.join(programDir, 'node_modules/.runtime-lock.json'), 'utf8'), '{"ok":true}');
      assert.equal(fs.readFileSync(path.join(programDir, 'desktop-dist/Clowder AI.exe'), 'utf8'), 'electron-entry');

      // Bootstrap special case: node.tar without node.exe must fail closed with exit code 20.
      const badNodeInput = path.join(staging, 'bad-node');
      fs.mkdirSync(badNodeInput, { recursive: true });
      fs.writeFileSync(path.join(badNodeInput, 'README.txt'), 'missing node.exe');
      const badNodeTar = path.join(archiveInput, 'bad-node.tar');
      await makeTar(badNodeInput, badNodeTar, false);
      const badScript = path.join(root, 'bad-node-probe.iss');
      fs.writeFileSync(
        badScript,
        `[Setup]
AppName=PR2070 Bad Node Probe
AppVersion=1.0.0
DefaultDirName=${path.join(root, 'bad-program')}
CreateAppDir=yes
Uninstallable=no
PrivilegesRequired=lowest
UsePreviousAppDir=no
OutputDir=${root}
OutputBaseFilename=bad-node-probe
Compression=none
SetupLogging=yes
[Dirs]
Name: "{app}\\node"
Name: "{app}\\bundled\\archives"
[Files]
Source: "${badNodeTar}"; DestDir: "{app}\\bundled\\archives"; DestName: "node.tar"; AfterInstall: ExtractRuntimeArchive('node.tar')
[Code]
function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall setuponly';
#include "${path.join(__dirname, 'installer/runtime-failure.iss')}"
${extractionOutput}
${extractProcedure}
`,
        'utf8',
      );
      const badCompiled = await runNativeCommand(root, 'compile-bad-node', compiler, ['/Q', badScript]);
      assert.equal(badCompiled.status, 0, badCompiled.stdout + badCompiled.stderr);
      const badInstalled = await runNativeCommand(
        root,
        'run-bad-node',
        path.join(root, 'bad-node-probe.exe'),
        ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(root, 'bad-node.log')}`],
        { timeoutMs: 120000 },
      );
      assert.equal(badInstalled.status, 20, badInstalled.stdout + badInstalled.stderr);
      assert.match(fs.readFileSync(path.join(root, 'bad-node.log'), 'utf8'), /Bundled Node\.js is incomplete/);
    });
  },
);
